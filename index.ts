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
          id: "claude-sonnet-4-20250514",
          name: "Claude Sonnet 4 (failover)",
          reasoning: true, input: ["text", "image"],
          cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
          contextWindow: 200000, maxTokens: 64000,
        },
        {
          id: "claude-sonnet-4-6",
          name: "Claude Sonnet 4.6 (failover)",
          reasoning: true, input: ["text", "image"],
          cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
          contextWindow: 200000, maxTokens: 64000,
        },
        {
          id: "claude-opus-4-6",
          name: "Claude Opus 4.6 (failover)",
          reasoning: true, input: ["text", "image"],
          cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
          contextWindow: 200000, maxTokens: 64000,
        },
        {
          id: "claude-opus-4-5",
          name: "Claude Opus 4.5 (failover)",
          reasoning: true, input: ["text", "image"],
          cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
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

    // Watch for errors on assistant messages
    pi.on("message_end", async (event, ctx) => {
      const msg = event.message;
      if (msg.role !== "assistant") return;

      const assistantMsg = msg as AssistantMessage;
      if (assistantMsg.stopReason !== "error" || !assistantMsg.errorMessage) return;
      if (swapInProgress) return; // prevent recursive swap

      // Check if this is a retriable error
      if (!isRetriableError(assistantMsg.errorMessage)) {
        console.error(`[pi-failover] Non-retriable error: ${assistantMsg.errorMessage}`);
        return;
      }

      // Find next fallback
      const nextIndex = fallbackIndex + 1;
      if (nextIndex >= config.fallback_models.length) {
        notify("❌ All fallback models exhausted", "error");
        return;
      }

      const fallback = config.fallback_models[nextIndex];
      const currentModel = `${assistantMsg.provider}/${assistantMsg.model}`;

      console.error(
        `[pi-failover] Retriable error on ${currentModel}: ${assistantMsg.errorMessage}`
      );
      notify(
        `⚠️ ${currentModel} failed — swapping to ${fallback.provider}/${fallback.model}`,
        "warning"
      );
      desktopNotify(`→ ${fallback.provider}/${fallback.model}`, assistantMsg.errorMessage);

      // Attempt the swap
      swapInProgress = true;
      fallbackIndex = nextIndex;
      swapCount++;

      try {
        const model = ctx.modelRegistry.find(fallback.provider, fallback.model);
        if (!model) {
          notify(`❌ Fallback model not found: ${fallback.provider}/${fallback.model}`, "error");
          swapInProgress = false;
          return;
        }

        const success = await pi.setModel(model);
        if (!success) {
          notify(`❌ No API key for ${fallback.provider}/${fallback.model}`, "error");
          swapInProgress = false;
          return;
        }

        ctx.ui.setStatus(
          "failover",
          `⚡ swapped → ${fallback.provider}/${fallback.model}`
        );

        // Retry the last prompt on the new model
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
