// tests/detection.test.ts — Error classification tests
import { describe, test, expect } from "bun:test";
import {
  classifyHttpError,
  classifyConnectionError,
  classifyStreamEvent,
} from "../src/detection";
import type { FailoverConfig } from "../src/config";

const defaultConfig: FailoverConfig = {
  trigger_codes: [429, 402, 500, 504, 529],
  trigger_on_connection_error: true,
  trigger_on_stream_error: true,
  cooldown_seconds: 300,
  max_retries: 3,
  strategy: "sequential",
};

describe("classifyHttpError", () => {
  test("429 rate_limit_error triggers failover", () => {
    const body = JSON.stringify({
      error: { type: "rate_limit_error", message: "Rate limit exceeded" },
    });
    const result = classifyHttpError(429, body, defaultConfig);
    expect(result.shouldFailover).toBe(true);
    expect(result.httpStatus).toBe(429);
    expect(result.errorType).toBe("rate_limit_error");
  });

  test("402 billing_error triggers failover", () => {
    const body = JSON.stringify({
      error: { type: "billing_error", message: "Usage limit reached" },
    });
    const result = classifyHttpError(402, body, defaultConfig);
    expect(result.shouldFailover).toBe(true);
  });

  test("529 overloaded_error triggers failover", () => {
    const body = JSON.stringify({
      error: { type: "overloaded_error", message: "API overloaded" },
    });
    const result = classifyHttpError(529, body, defaultConfig);
    expect(result.shouldFailover).toBe(true);
  });

  test("500 api_error triggers failover", () => {
    const result = classifyHttpError(500, null, defaultConfig);
    expect(result.shouldFailover).toBe(true);
  });

  test("504 timeout_error triggers failover", () => {
    const result = classifyHttpError(504, null, defaultConfig);
    expect(result.shouldFailover).toBe(true);
  });

  test("401 authentication_error does NOT trigger failover", () => {
    const body = JSON.stringify({
      error: { type: "authentication_error", message: "Invalid API key" },
    });
    const result = classifyHttpError(401, body, defaultConfig);
    expect(result.shouldFailover).toBe(false);
  });

  test("400 invalid_request_error does NOT trigger failover", () => {
    const body = JSON.stringify({
      error: { type: "invalid_request_error", message: "Bad model name" },
    });
    const result = classifyHttpError(400, body, defaultConfig);
    expect(result.shouldFailover).toBe(false);
  });

  test("403 permission_error does NOT trigger failover", () => {
    const result = classifyHttpError(403, null, defaultConfig);
    expect(result.shouldFailover).toBe(false);
  });

  test("413 request_too_large does NOT trigger failover", () => {
    const result = classifyHttpError(413, null, defaultConfig);
    expect(result.shouldFailover).toBe(false);
  });

  test("handles unparseable body gracefully", () => {
    const result = classifyHttpError(429, "not json at all", defaultConfig);
    expect(result.shouldFailover).toBe(true);
    expect(result.reason).toContain("not json at all");
  });

  test("handles null body", () => {
    const result = classifyHttpError(429, null, defaultConfig);
    expect(result.shouldFailover).toBe(true);
  });

  test("respects custom trigger_codes", () => {
    const customConfig = { ...defaultConfig, trigger_codes: [429] };
    expect(classifyHttpError(500, null, customConfig).shouldFailover).toBe(
      false
    );
    expect(classifyHttpError(429, null, customConfig).shouldFailover).toBe(
      true
    );
  });
});

describe("classifyConnectionError", () => {
  test("triggers failover by default", () => {
    const result = classifyConnectionError(
      new Error("ECONNREFUSED"),
      defaultConfig
    );
    expect(result.shouldFailover).toBe(true);
    expect(result.reason).toContain("ECONNREFUSED");
  });

  test("respects trigger_on_connection_error=false", () => {
    const config = { ...defaultConfig, trigger_on_connection_error: false };
    const result = classifyConnectionError(
      new Error("ECONNREFUSED"),
      config
    );
    expect(result.shouldFailover).toBe(false);
  });
});

describe("classifyStreamEvent", () => {
  test("non-error events return null", () => {
    expect(classifyStreamEvent("message_start", "{}", defaultConfig)).toBeNull();
    expect(classifyStreamEvent("content_block_delta", "{}", defaultConfig)).toBeNull();
    expect(classifyStreamEvent("message_stop", "{}", defaultConfig)).toBeNull();
  });

  test("overloaded_error event triggers failover", () => {
    const data = JSON.stringify({
      error: { type: "overloaded_error", message: "Overloaded" },
    });
    const result = classifyStreamEvent("error", data, defaultConfig);
    expect(result).not.toBeNull();
    expect(result!.shouldFailover).toBe(true);
    expect(result!.errorType).toBe("overloaded_error");
  });

  test("rate_limit_error event triggers failover", () => {
    const data = JSON.stringify({
      error: { type: "rate_limit_error", message: "Limit hit" },
    });
    const result = classifyStreamEvent("error", data, defaultConfig);
    expect(result).not.toBeNull();
    expect(result!.shouldFailover).toBe(true);
  });

  test("handles unparseable event data", () => {
    const result = classifyStreamEvent("error", "not json", defaultConfig);
    expect(result).not.toBeNull();
    expect(result!.shouldFailover).toBe(true); // defaults to stream error
  });
});
