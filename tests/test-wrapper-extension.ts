// tests/test-wrapper-extension.ts
//
// Wraps the real pi-failover extension AND registers a "mock-backup" provider
// pointing at our success mock server on port 19002.
// This lets fallback_models swap to mock-backup/mock-model automatically.

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import mainExtension from "../index";

export default function (pi: ExtensionAPI) {
  // Register the mock-backup provider FIRST so it's available when the
  // main extension tries to look it up for fallback
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

  // Run the real extension
  mainExtension(pi);
}
