// tests/config.test.ts
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { writeFileSync, unlinkSync } from "fs";
import { join } from "path";

const TEST_CONFIG = join(import.meta.dir, "..", "failover.yaml");

beforeAll(() => {
  // Create a temporary config in the project root for tests
  writeFileSync(
    TEST_CONFIG,
    `
failover:
  trigger_codes: [429, 402, 500, 504, 529]
  trigger_on_connection_error: true
  cooldown_seconds: 300
  max_retries: 3

notify:
  enabled: true
  desktop: true

fallback_models:
  - provider: "amazon-bedrock"
    model: "global.anthropic.claude-sonnet-4-6"

backends:
  - name: "anthropic-primary"
    enabled: true
    type: "anthropic"
    api_key_env: "ANTHROPIC_API_KEY"
    base_url: "https://api.anthropic.com"
`
  );
});

afterAll(() => {
  try { unlinkSync(TEST_CONFIG); } catch {}
});

// Import after writing the file
const { loadConfig } = await import("../config");

describe("loadConfig", () => {
  test("loads config from cwd failover.yaml", () => {
    const config = loadConfig();
    expect(config.backends.length).toBeGreaterThan(0);
    expect(config.failover.trigger_codes).toContain(429);
    expect(config.failover.trigger_codes).toContain(529);
  });

  test("has correct defaults merged", () => {
    const config = loadConfig();
    expect(config.failover.cooldown_seconds).toBe(300);
    expect(config.failover.max_retries).toBe(3);
    expect(config.failover.trigger_on_connection_error).toBe(true);
  });

  test("loads fallback_models", () => {
    const config = loadConfig();
    expect(config.fallback_models.length).toBeGreaterThan(0);
    expect(config.fallback_models[0].provider).toBe("amazon-bedrock");
    expect(config.fallback_models[0].model).toBe("global.anthropic.claude-sonnet-4-6");
  });

  test("loads backends", () => {
    const config = loadConfig();
    expect(config.backends[0].name).toBe("anthropic-primary");
    expect(config.backends[0].type).toBe("anthropic");
  });
});
