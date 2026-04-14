// index.ts — Pi extension entry point
//
// Registers a "failover" provider that wraps the Anthropic API with
// automatic failover across multiple backends (different API keys,
// endpoints, etc.) on retriable errors (429, 402, 529, etc.).
//
// Usage:
//   1. Create ~/.config/pi-failover/failover.yaml (or ./failover.yaml)
//   2. Install: pi --extension ./path/to/pi-failover
//      Or symlink to ~/.pi/agent/extensions/pi-failover/
//   3. Use /model to select "failover/<model>"

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { loadConfig } from "./config";
import {
  initBackends,
  setFailoverCallback,
  streamWithFailover,
  getBackendStates,
  getTotalFailovers,
} from "./stream";
import { Type } from "@sinclair/typebox";

export default function (pi: ExtensionAPI) {
  const config = loadConfig();
  const enabledBackends = config.backends.filter((b) => b.enabled);

  if (enabledBackends.length === 0) {
    // No config or no backends — register a noop
    console.error("[pi-failover] No enabled backends found in failover.yaml. Extension inactive.");
    return;
  }

  // Initialize backend state
  initBackends(config);

  // Track active notification context
  let notifyUi: { notify: (msg: string, level: "info" | "warning" | "error") => void } | undefined;

  // Failover notification callback
  setFailoverCallback((from, to, reason) => {
    const msg = `⚠️ Failover: ${from} → ${to} (${reason})`;
    console.error(`[pi-failover] ${msg}`);

    if (notifyUi) {
      notifyUi.notify(msg, "warning");
    }

    // macOS desktop notification
    if (config.notify.enabled && config.notify.desktop) {
      try {
        const proc = Bun.spawn([
          "osascript", "-e",
          `display notification "${reason}" with title "pi-failover" subtitle "→ ${to}"`,
        ]);
        // fire and forget
      } catch {}
    }
  });

  // Store UI context from events
  pi.on("session_start", async (_event, ctx) => {
    notifyUi = ctx.ui;
    ctx.ui.setStatus("failover", `⚡ ${enabledBackends.length} backends`);
  });

  // Register the failover provider
  // Models match the standard Anthropic lineup so /model selection works
  pi.registerProvider("failover", {
    baseUrl: enabledBackends[0].base_url || "https://api.anthropic.com",
    apiKey: enabledBackends[0].api_key_env || enabledBackends[0].api_key || "ANTHROPIC_API_KEY",
    api: "failover-api" as any,

    models: [
      {
        id: "claude-sonnet-4-20250514",
        name: "Claude Sonnet 4 (failover)",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
        contextWindow: 200000,
        maxTokens: 64000,
      },
      {
        id: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.6 (failover)",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
        contextWindow: 200000,
        maxTokens: 64000,
      },
      {
        id: "claude-opus-4-6",
        name: "Claude Opus 4.6 (failover)",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
        contextWindow: 200000,
        maxTokens: 64000,
      },
      {
        id: "claude-opus-4-5",
        name: "Claude Opus 4.5 (failover)",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
        contextWindow: 200000,
        maxTokens: 64000,
      },
    ],

    streamSimple: streamWithFailover,
  });

  // -------------------------------------------------------------------------
  // /failover command — show status
  // -------------------------------------------------------------------------
  pi.registerCommand("failover", {
    description: "Show failover provider status",
    handler: async (_args, ctx) => {
      const states = getBackendStates();
      const now = Date.now();
      const lines: string[] = [
        `Failover backends (${states.length}):`,
        "",
      ];

      for (const s of states) {
        const healthy = s.degradedUntil <= now;
        const status = healthy ? "✅ healthy" : `❌ cooldown (${Math.ceil((s.degradedUntil - now) / 1000)}s)`;
        const errors = s.errorCount > 0 ? ` [${s.errorCount} errors]` : "";
        const lastErr = s.lastError ? `\n    Last: ${s.lastError}` : "";
        lines.push(`  ${s.config.name}: ${status}${errors}${lastErr}`);
      }

      lines.push("");
      lines.push(`Total failovers this session: ${getTotalFailovers()}`);
      lines.push(`Trigger codes: ${config.failover.trigger_codes.join(", ")}`);
      lines.push(`Cooldown: ${config.failover.cooldown_seconds}s`);

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  // -------------------------------------------------------------------------
  // failover_status tool — lets the LLM check provider health
  // -------------------------------------------------------------------------
  pi.registerTool({
    name: "failover_status",
    label: "Failover Status",
    description: "Check the health status of all configured failover backends",
    parameters: Type.Object({}),
    async execute() {
      const states = getBackendStates();
      const now = Date.now();
      const status = states.map((s) => ({
        name: s.config.name,
        healthy: s.degradedUntil <= now,
        errorCount: s.errorCount,
        lastError: s.lastError,
        cooldownRemaining:
          s.degradedUntil > now ? Math.ceil((s.degradedUntil - now) / 1000) : 0,
      }));

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              { backends: status, totalFailovers: getTotalFailovers() },
              null,
              2
            ),
          },
        ],
        details: {},
      };
    },
  });

  console.error(
    `[pi-failover] Loaded with ${enabledBackends.length} backend(s): ${enabledBackends.map((b) => b.name).join(", ")}`
  );
}
