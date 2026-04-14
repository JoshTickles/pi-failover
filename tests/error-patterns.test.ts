// tests/error-patterns.test.ts — Verify real-world error messages are detected
import { describe, test, expect } from "bun:test";

// Import the same patterns the extension uses. Since they're in index.ts
// (not easily importable without running the extension), we duplicate them
// here and test the matching logic directly.

const RETRIABLE_PATTERNS = [
  // Rate limits & usage caps
  /rate.?limit/i,
  /hit.+limit/i,
  /usage.?limit/i,
  /too many requests/i,
  /quota/i,
  /capacity/i,
  /resets?\s+\d/i,
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

function isRetriableError(msg: string): boolean {
  return RETRIABLE_PATTERNS.some((p) => p.test(msg));
}

describe("Real-world error detection", () => {
  // ── From the screenshot ──────────────────────────────────────
  test("Claude rate limited (five_hour) — resets at 1:22:15 am", () => {
    expect(isRetriableError("Claude rate limited (five_hour) — resets at 1:22:15 am")).toBe(true);
  });

  test("You've hit your limit · resets 3pm (Pacific/Auckland)", () => {
    expect(isRetriableError("You've hit your limit · resets 3pm (Pacific/Auckland)")).toBe(true);
  });

  test("Claude Code returned an error result: You've hit your limit · resets 3pm", () => {
    expect(
      isRetriableError(
        "Claude Code returned an error result: You've hit your limit · resets 3pm (Pacific/Auckland)"
      )
    ).toBe(true);
  });

  // ── Anthropic API errors ─────────────────────────────────────
  test("429 rate_limit_error", () => {
    expect(isRetriableError('429 {"error":{"type":"rate_limit_error","message":"Rate limit exceeded"}}')).toBe(true);
  });

  test("529 overloaded_error", () => {
    expect(isRetriableError("529 overloaded_error: API is temporarily overloaded")).toBe(true);
  });

  test("402 billing_error", () => {
    expect(isRetriableError("402 billing_error: Payment required")).toBe(true);
  });

  test("500 internal server error", () => {
    expect(isRetriableError("500 api_error: An unexpected error occurred")).toBe(true);
  });

  test("504 timeout", () => {
    expect(isRetriableError("504 timeout_error: Request timed out")).toBe(true);
  });

  // ── Connection errors ────────────────────────────────────────
  test("Connection error", () => {
    expect(isRetriableError("Connection error.")).toBe(true);
  });

  test("ECONNREFUSED", () => {
    expect(isRetriableError("connect ECONNREFUSED 127.0.0.1:443")).toBe(true);
  });

  // ── Bedrock / Vertex specific ────────────────────────────────
  test("Bedrock ThrottlingException", () => {
    expect(isRetriableError("Rate limit: ThrottlingException")).toBe(true);
  });

  test("Too many requests from bedrock", () => {
    expect(isRetriableError("Too many requests, please wait before trying again")).toBe(true);
  });

  // ── Non-retriable (should NOT match) ─────────────────────────
  test("401 authentication_error → NOT retriable", () => {
    expect(isRetriableError("401 authentication_error: Invalid API key")).toBe(false);
  });

  test("400 invalid_request_error → NOT retriable", () => {
    expect(isRetriableError("400 invalid_request_error: model not found")).toBe(false);
  });

  test("403 permission_error → NOT retriable", () => {
    expect(isRetriableError("403 permission_error: Not allowed")).toBe(false);
  });

  test("random error message → NOT retriable", () => {
    expect(isRetriableError("Something unexpected happened")).toBe(false);
  });
});
