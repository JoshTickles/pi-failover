// tests/test-wrapper-extension.ts
//
// Registers a "mock-backup" provider for integration testing.
// The main pi-failover extension is auto-loaded from ~/.pi/agent/extensions/
// so we DON'T import it here — just register the mock provider.

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerProvider("mock-backup", {
    baseUrl: "http://127.0.0.1:19002",
    apiKey: "fake-key",
    api: "anthropic-messages",
    models: [
      {
        id: "mock-model",
        name: "Mock Backup Model",
        reasoning: false,
        input: ["text" as const, "image" as const],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 64000,
      },
    ],
  });
}
