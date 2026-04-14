// tests/config.test.ts
import { describe, test, expect } from "bun:test";
import { loadConfig } from "../config";

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
