// tests/config.test.ts — Config loading tests
import { describe, test, expect } from "bun:test";
import { loadConfig } from "../config";

describe("loadConfig", () => {
  test("loads config from cwd failover.yaml", () => {
    const config = loadConfig();
    // Should find ./failover.yaml in project root
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

  test("first backend is anthropic-primary", () => {
    const config = loadConfig();
    expect(config.backends[0].name).toBe("anthropic-primary");
    expect(config.backends[0].type).toBe("anthropic");
    expect(config.backends[0].api_key_env).toBe("ANTHROPIC_API_KEY");
  });
});
