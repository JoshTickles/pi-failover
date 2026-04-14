// src/notify.ts — Failover notifications (desktop + webhook)
import type { NotifyConfig } from "./config";
import * as log from "./log";

export async function notifyFailover(
  config: NotifyConfig,
  fromProvider: string,
  toProvider: string,
  reason: string
): Promise<void> {
  if (!config.enabled) return;

  const message = `⚠️ pi-failover: Switched from "${fromProvider}" → "${toProvider}"\nReason: ${reason}`;

  // Desktop notification (macOS)
  if (config.desktop !== false) {
    try {
      const proc = Bun.spawn([
        "osascript",
        "-e",
        `display notification "${reason}" with title "pi-failover" subtitle "→ ${toProvider}"`,
      ]);
      await proc.exited;
    } catch (err) {
      log.debug("Desktop notification failed", { error: String(err) });
    }
  }

  // Webhook
  if (config.webhook_url) {
    try {
      await fetch(config.webhook_url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: message,
          event: "failover",
          from: fromProvider,
          to: toProvider,
          reason,
          timestamp: new Date().toISOString(),
        }),
      });
    } catch (err) {
      log.debug("Webhook notification failed", { error: String(err) });
    }
  }
}
