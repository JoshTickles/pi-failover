// tests/integration.test.ts — End-to-end Pi integration tests
//
// These tests spin up mock HTTP servers, then run Pi as a subprocess
// with the failover extension, verifying that:
//   1. Backend failover works (429 → backup within streamSimple)
//   2. Connection error failover works
//   3. Automatic model swap works (message_end error → pi.setModel + retry)
//
// Each test runs Pi in -p (print) mode with --no-tools for speed.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { resolve } from "path";
import type { Subprocess } from "bun";

const PROJECT_ROOT = resolve(import.meta.dir, "..");
const MOCK_SERVER = resolve(import.meta.dir, "mock-server.ts");
const WRAPPER_EXT = resolve(import.meta.dir, "test-wrapper-extension.ts");
const FIXTURES = resolve(import.meta.dir, "fixtures");

let mockProc: Subprocess;

beforeAll(async () => {
  // Start mock servers (429 on 19001, 200 SSE on 19002)
  mockProc = Bun.spawn(["bun", "run", MOCK_SERVER], {
    cwd: PROJECT_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });

  // Wait for servers to be ready
  await new Promise((r) => setTimeout(r, 1000));

  // Verify mock is listening
  try {
    const resp = await fetch("http://127.0.0.1:19001/v1/messages", { method: "POST" });
    if (resp.status !== 429) throw new Error(`Expected 429, got ${resp.status}`);
  } catch (e: any) {
    if (e.message?.includes("Expected 429")) throw e;
    throw new Error(`Mock server not ready: ${e.message}`);
  }
});

afterAll(() => {
  mockProc?.kill();
});

interface PiResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function runPi(opts: {
  config: string;
  model: string;
  prompt?: string;
  extension?: string;
  timeoutMs?: number;
}): Promise<PiResult> {
  const {
    config,
    model,
    prompt = "respond with only the word 'pong'",
    extension = PROJECT_ROOT,
    timeoutMs = 30_000,
  } = opts;

  const env = {
    ...process.env,
    PI_FAILOVER_CONFIG: config,
  };

  const proc = Bun.spawn(
    ["pi", "-e", extension, "-p", prompt, "--no-tools", "--model", model],
    { cwd: PROJECT_ROOT, env, stdout: "pipe", stderr: "pipe" }
  );

  // Timeout guard
  const timeout = setTimeout(() => proc.kill(), timeoutMs);

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  clearTimeout(timeout);

  return { stdout: stdout.trim(), stderr, exitCode };
}

// ─────────────────────────────────────────────────────────────────
// Mechanism 1: Backend failover (streamSimple)
// ─────────────────────────────────────────────────────────────────

describe("Backend failover (mechanism 1)", () => {
  test("429 rate limit → failover to backup backend", async () => {
    const result = await runPi({
      config: resolve(FIXTURES, "backend-failover.yaml"),
      model: "failover/claude-sonnet-4-20250514",
    });

    expect(result.stdout).toBe("pong");
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain('Attempting "rate-limited"');
    expect(result.stderr).toContain("HTTP 429");
    expect(result.stderr).toContain('Attempting "backup-ok"');
    expect(result.stderr).toContain("Failover succeeded");
  }, 30_000);

  test("connection refused → failover to backup backend", async () => {
    const result = await runPi({
      config: resolve(FIXTURES, "connection-error.yaml"),
      model: "failover/claude-sonnet-4-20250514",
    });

    expect(result.stdout).toBe("pong");
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain('Attempting "dead-endpoint"');
    expect(result.stderr).toContain("APIConnectionError");
    expect(result.stderr).toContain('Attempting "backup-ok"');
    expect(result.stderr).toContain("Failover succeeded");
  }, 30_000);
});

// ─────────────────────────────────────────────────────────────────
// Mechanism 2: Automatic model swap
// ─────────────────────────────────────────────────────────────────

describe("Automatic model swap (mechanism 2)", () => {
  test("error on active model → auto-swap to fallback → retry succeeds", async () => {
    const result = await runPi({
      config: resolve(FIXTURES, "autoswap.yaml"),
      model: "failover/claude-sonnet-4-20250514",
      extension: WRAPPER_EXT,
    });

    expect(result.stdout).toBe("pong");
    expect(result.exitCode).toBe(0);

    // Should see: initial attempt fails, then auto-swap
    expect(result.stderr).toContain("Loaded: 1 backend(s), 1 fallback model(s)");
    expect(result.stderr).toContain("Retriable error");
    expect(result.stderr).toContain("Swapping to mock-backup/mock-model");
    expect(result.stderr).toContain("Retrying prompt");
  }, 30_000);
});
