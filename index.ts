// index.ts — Pi extension entry point
//
// Two failover mechanisms:
//
// 1. "failover" provider (streamSimple) — tries multiple Anthropic backends
//    in sequence within a single model call. Transparent to Pi.
//    Requires: /model → failover/claude-sonnet-4-6
//
// 2. Automatic model swap — watches for errors on ANY active model.
//    On retriable error, swaps to the next model in fallback_models chain
//    and retries automatically. Zero manual intervention.
//    Requires: fallback_models configured in failover.yaml

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import { loadConfig, type FallbackModelConfig } from "./config";
import {
  initBackends,
  setFailoverCallback,
  streamWithFailover,
  getBackendStates,
  getTotalFailovers,
} from "./stream";
import { Type } from "@sinclair/typebox";

// ---------------------------------------------------------------------------
// Error message patterns that indicate retriable provider failures
// ---------------------------------------------------------------------------
const RETRIABLE_PATTERNS = [
  // Rate limits & usage caps
  /rate.?limit/i,
  /hit.+limit/i,
  /usage.?limit/i,
  /too many requests/i,
  /quota/i,
  /capacity/i,
  /resets?\s+\d/i,          // "resets 3pm", "resets at 1:22"
  // HTTP status codes
  /429/,
  /402/,
  /500/,
  /504/,
  /529/,
  // Server issues
  /overloaded/i,
  /billing/i,
  /server.?error/i,
  /timeout/i,
  // Connection failures
  /connection.?error/i,
  /ECONNREFUSED/i,
  // Our own failover provider exhaustion
  /all backends/i,
  /all providers/i,
];

function isRetriableError(errorMessage: string): boolean {
  return RETRIABLE_PATTERNS.some((p) => p.test(errorMessage));
}

export default function (pi: ExtensionAPI) {
  const config = loadConfig();
  const enabledBackends = config.backends.filter((b) => b.enabled);
  const hasFallbackModels = config.fallback_models.length > 0;
  const hasBackends = enabledBackends.length > 0;

  if (!hasBackends && !hasFallbackModels) {
    console.error("[pi-failover] No backends or fallback_models configured. Extension inactive.");
    return;
  }

  // =========================================================================
  // Mechanism 1: "failover" provider with streamSimple (multi-backend)
  // =========================================================================
  if (hasBackends) {
    initBackends(config);

    pi.registerProvider("failover", {
      baseUrl: enabledBackends[0].base_url || "https://api.anthropic.com",
      apiKey: enabledBackends[0].api_key_env || enabledBackends[0].api_key || "ANTHROPIC_API_KEY",
      api: "failover-api" as any,
      models: [
        {
          id: "claude-opus-4-8",
          name: "Claude Opus 4.8 (failover)",
          reasoning: true, input: ["text", "image"],
          cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
          contextWindow: 1000000, maxTokens: 128000,
        },
        {
          id: "claude-fable-5",
          name: "Claude Fable 5 (failover)",
          reasoning: true, input: ["text", "image"],
          cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
          contextWindow: 1000000, maxTokens: 128000,
        },
        {
          id: "claude-sonnet-4-6",
          name: "Claude Sonnet 4.6 (failover)",
          reasoning: true, input: ["text", "image"],
          cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
          contextWindow: 1000000, maxTokens: 64000,
        },
        {
          id: "claude-haiku-4-5-20251001",
          name: "Claude Haiku 4.5 (failover)",
          reasoning: false, input: ["text", "image"],
          cost: { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
          contextWindow: 200000, maxTokens: 64000,
        },
      ],
      streamSimple: streamWithFailover,
    });
  }

  // =========================================================================
  // Mechanism 2: Automatic model swap on error (works with ANY provider)
  // =========================================================================
  let currentCtx: ExtensionContext | undefined;
  let lastUserPrompt: string | undefined;
  let swapInProgress = false;
  let swapCount = 0;
  // Track which fallback index we're on. -1 = using the user's original model.
  let fallbackIndex = -1;
  // Track the model the user originally selected (so we can restore later)
  let originalModel: { provider: string; id: string } | undefined;

  // Notification helper
  function notify(msg: string, level: "info" | "warning" | "error" = "info") {
    console.error(`[pi-failover] ${msg}`);
    currentCtx?.ui.notify(msg, level);
  }

  // Desktop notification
  function desktopNotify(subtitle: string, body: string) {
    if (!config.notify.enabled || !config.notify.desktop) return;
    try {
      Bun.spawn([
        "osascript", "-e",
        `display notification "${body}" with title "pi-failover" subtitle "${subtitle}"`,
      ]);
    } catch {}
  }

  // Failover callback for mechanism 1
  setFailoverCallback((from, to, reason) => {
    const msg = `⚠️ Backend failover: ${from} → ${to}`;
    notify(msg, "warning");
    desktopNotify(`→ ${to}`, reason);
  });

  // Capture UI context
  pi.on("session_start", async (_event, ctx) => {
    currentCtx = ctx;
    const parts: string[] = [];
    if (hasBackends) parts.push(`${enabledBackends.length} backend(s)`);
    if (hasFallbackModels) parts.push(`${config.fallback_models.length} fallback model(s)`);
    ctx.ui.setStatus("failover", `⚡ ${parts.join(", ")}`);
  });

  if (hasFallbackModels) {
    // Track user's original model selection
    pi.on("model_select", async (event, _ctx) => {
      // Only capture if user explicitly changed model (not our swap)
      if (!swapInProgress) {
        originalModel = { provider: event.model.provider, id: event.model.id };
        fallbackIndex = -1; // reset chain
        console.error(`[pi-failover] Tracking original model: ${originalModel.provider}/${originalModel.id}`);
      }
    });

    // Capture user prompts so we can replay on swap
    pi.on("input", async (event, _ctx) => {
      if (event.source === "extension") return { action: "continue" as const };
      lastUserPrompt = event.text;
      return { action: "continue" as const };
    });

    // -----------------------------------------------------------------------
    // Detection strategy:
    //
    // Pi has auto-retry for SOME errors (rate_limit, connection, 429, 500,
    // etc.) with exponential backoff (default 3 retries).
    //
    // But some errors Pi WON'T retry:
    //   - "You've hit your limit · resets 3pm" (Claude Max subscription cap)
    //   - "All backends are in cooldown" (our own failover provider)
    //   - Billing errors without standard HTTP codes
    //
    // Strategy:
    //   1. On message_end with error: record it, classify it
    //   2. On agent_end: check if this is an error Pi won't retry
    //      (= our retriable, but NOT Pi's retriable) → swap immediately
    //   3. For errors Pi IS retrying: count consecutive errors,
    //      swap after Pi exhausts retries (consecutiveErrors > PI_MAX_RETRIES)
    // -----------------------------------------------------------------------

    // Pi's own retryable error regex (from agent-session.js _isRetryableError)
    const PI_RETRYABLE = /overloaded|provider.?returned.?error|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|server.?error|internal.?error|network.?error|connection.?error|connection.?refused|other side closed|fetch failed|upstream.?connect|reset before headers|socket hang up|ended without|timed?.out|timeout|terminated|retry delay/i;

    let consecutiveErrors = 0;
    let lastErrorMessage = "";
    let lastErrorIsPiRetryable = false;
    const PI_MAX_RETRIES = 3;

    pi.on("message_end", async (event, _ctx) => {
      const msg = event.message;
      if (msg.role !== "assistant") return;

      const assistantMsg = msg as AssistantMessage;
      if (assistantMsg.stopReason === "error" && assistantMsg.errorMessage) {
        if (isRetriableError(assistantMsg.errorMessage)) {
          consecutiveErrors++;
          lastErrorMessage = assistantMsg.errorMessage;
          lastErrorIsPiRetryable = PI_RETRYABLE.test(assistantMsg.errorMessage);
          console.error(
            `[pi-failover] Retriable error #${consecutiveErrors} (pi-retryable=${lastErrorIsPiRetryable}): ${assistantMsg.errorMessage}`
          );
        }
      } else {
        // Successful response — reset
        if (consecutiveErrors > 0) {
          console.error(`[pi-failover] Success after ${consecutiveErrors} error(s), resetting`);
        }
        consecutiveErrors = 0;
        lastErrorMessage = "";
      }
    });

    pi.on("agent_end", async (event, ctx) => {
      if (swapInProgress) return;
      if (consecutiveErrors === 0) return;

      // Decide whether to swap now or wait for Pi's retries
      const shouldSwapNow =
        // Errors Pi won't retry → swap immediately
        (!lastErrorIsPiRetryable) ||
        // Errors Pi retries → wait until retries exhausted
        (consecutiveErrors > PI_MAX_RETRIES);

      if (!shouldSwapNow) return; // Pi is still retrying, wait

      // Time to swap
      const nextIndex = fallbackIndex + 1;
      if (nextIndex >= config.fallback_models.length) {
        notify("\u274c All fallback models exhausted", "error");
        consecutiveErrors = 0;
        return;
      }

      const fallback = config.fallback_models[nextIndex];

      console.error(
        `[pi-failover] Swapping to ${fallback.provider}/${fallback.model} after ${consecutiveErrors} failure(s)`
      );
      notify(
        `\u26a0\ufe0f Swapping to ${fallback.provider}/${fallback.model}`,
        "warning"
      );
      desktopNotify(`\u2192 ${fallback.provider}/${fallback.model}`, lastErrorMessage);

      swapInProgress = true;
      fallbackIndex = nextIndex;
      swapCount++;
      consecutiveErrors = 0;

      try {
        const model = ctx.modelRegistry.find(fallback.provider, fallback.model);
        if (!model) {
          notify(`\u274c Fallback not found: ${fallback.provider}/${fallback.model}`, "error");
          return;
        }

        const success = await pi.setModel(model);
        if (!success) {
          notify(`\u274c No API key for ${fallback.provider}/${fallback.model}`, "error");
          return;
        }

        ctx.ui.setStatus("failover", `\u26a1 swapped \u2192 ${fallback.provider}/${fallback.model}`);

        if (lastUserPrompt) {
          console.error(`[pi-failover] Retrying prompt on ${fallback.provider}/${fallback.model}`);
          pi.sendUserMessage(lastUserPrompt, { deliverAs: "followUp" });
        }
      } finally {
        swapInProgress = false;
      }
    });
  }

  // =========================================================================
  // /failover command
  // =========================================================================
  pi.registerCommand("failover", {
    description: "Show failover status",
    handler: async (_args, ctx) => {
      const lines: string[] = [];

      if (hasBackends) {
        const states = getBackendStates();
        const now = Date.now();
        lines.push("Backends (streamSimple failover):");
        for (const s of states) {
          const healthy = s.degradedUntil <= now;
          const status = healthy ? "✅" : `❌ cooldown (${Math.ceil((s.degradedUntil - now) / 1000)}s)`;
          lines.push(`  ${s.config.name}: ${status} [${s.errorCount} errors]`);
        }
        lines.push(`  Backend failovers: ${getTotalFailovers()}`);
        lines.push("");
      }

      if (hasFallbackModels) {
        lines.push("Fallback models (auto-swap):");
        for (let i = 0; i < config.fallback_models.length; i++) {
          const f = config.fallback_models[i];
          const marker = i === fallbackIndex ? " ← active" : i < fallbackIndex ? " ✓ tried" : "";
          lines.push(`  ${i + 1}. ${f.provider}/${f.model}${marker}`);
        }
        if (originalModel) {
          lines.push(`  Original: ${originalModel.provider}/${originalModel.id}`);
        }
        lines.push(`  Model swaps: ${swapCount}`);
      }

      lines.push("");
      lines.push(`Trigger codes: ${config.failover.trigger_codes.join(", ")}`);
      lines.push(`Cooldown: ${config.failover.cooldown_seconds}s`);

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  // =========================================================================
  // failover_status tool
  // =========================================================================
  pi.registerTool({
    name: "failover_status",
    label: "Failover Status",
    description: "Check the health status of failover backends and fallback models",
    parameters: Type.Object({}),
    async execute() {
      const backendStatus = hasBackends
        ? getBackendStates().map((s) => ({
            name: s.config.name,
            healthy: s.degradedUntil <= Date.now(),
            errorCount: s.errorCount,
            lastError: s.lastError,
          }))
        : [];

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            backends: backendStatus,
            backendFailovers: getTotalFailovers(),
            fallbackModels: config.fallback_models,
            currentFallbackIndex: fallbackIndex,
            modelSwaps: swapCount,
            originalModel,
          }, null, 2),
        }],
        details: {},
      };
    },
  });

  // =========================================================================
  // Log summary
  // =========================================================================
  const parts: string[] = [];
  if (hasBackends) parts.push(`${enabledBackends.length} backend(s)`);
  if (hasFallbackModels) parts.push(`${config.fallback_models.length} fallback model(s)`);
  console.error(`[pi-failover] Loaded: ${parts.join(", ")}`);
}
