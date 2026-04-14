// tests/detection.test.ts — Error classification tests
import { describe, test, expect } from "bun:test";
import { classifyError } from "../detection";
import type { FailoverRules } from "../config";

const rules: FailoverRules = {
  trigger_codes: [429, 402, 500, 504, 529],
  trigger_on_connection_error: true,
  cooldown_seconds: 300,
  max_retries: 3,
};

describe("classifyError", () => {
  test("429 triggers failover", () => {
    const err = { status: 429, message: "Rate limit exceeded" };
    const result = classifyError(err, rules);
    expect(result.shouldFailover).toBe(true);
    expect(result.httpStatus).toBe(429);
  });

  test("402 triggers failover", () => {
    const err = { status: 402, message: "Billing error" };
    expect(classifyError(err, rules).shouldFailover).toBe(true);
  });

  test("529 triggers failover", () => {
    const err = { status: 529, message: "Overloaded" };
    expect(classifyError(err, rules).shouldFailover).toBe(true);
  });

  test("500 triggers failover", () => {
    const err = { status: 500, message: "Internal error" };
    expect(classifyError(err, rules).shouldFailover).toBe(true);
  });

  test("504 triggers failover", () => {
    const err = { status: 504, message: "Timeout" };
    expect(classifyError(err, rules).shouldFailover).toBe(true);
  });

  test("401 does NOT trigger failover", () => {
    const err = { status: 401, message: "Invalid API key" };
    expect(classifyError(err, rules).shouldFailover).toBe(false);
  });

  test("400 does NOT trigger failover", () => {
    const err = { status: 400, message: "Bad request" };
    expect(classifyError(err, rules).shouldFailover).toBe(false);
  });

  test("403 does NOT trigger failover", () => {
    const err = { status: 403, message: "Forbidden" };
    expect(classifyError(err, rules).shouldFailover).toBe(false);
  });

  test("ECONNREFUSED triggers failover", () => {
    const err = { code: "ECONNREFUSED", message: "Connection refused" };
    expect(classifyError(err, rules).shouldFailover).toBe(true);
  });

  test("ENOTFOUND triggers failover", () => {
    const err = { code: "ENOTFOUND", message: "DNS lookup failed" };
    expect(classifyError(err, rules).shouldFailover).toBe(true);
  });

  test("connection errors respect config flag", () => {
    const noConnRules = { ...rules, trigger_on_connection_error: false };
    const err = { code: "ECONNREFUSED", message: "Connection refused" };
    expect(classifyError(err, noConnRules).shouldFailover).toBe(false);
  });

  test("custom trigger codes", () => {
    const customRules = { ...rules, trigger_codes: [429] };
    expect(classifyError({ status: 500, message: "" }, customRules).shouldFailover).toBe(false);
    expect(classifyError({ status: 429, message: "" }, customRules).shouldFailover).toBe(true);
  });

  test("generic fetch error triggers failover", () => {
    const err = new Error("fetch failed");
    expect(classifyError(err, rules).shouldFailover).toBe(true);
  });

  test("unknown error does NOT trigger failover", () => {
    const err = new Error("something unexpected");
    expect(classifyError(err, rules).shouldFailover).toBe(false);
  });
});
