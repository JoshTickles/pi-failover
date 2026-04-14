// tests/router.test.ts — Failover routing tests
import { describe, test, expect, mock, beforeEach } from "bun:test";
import { Router } from "../src/router";
import type { Config } from "../src/config";

function makeConfig(
  overrides: Partial<Config> = {}
): Config {
  return {
    listen: { host: "127.0.0.1", port: 8099 },
    failover: {
      trigger_codes: [429, 402, 500, 504, 529],
      trigger_on_connection_error: true,
      trigger_on_stream_error: true,
      cooldown_seconds: 300,
      max_retries: 3,
      strategy: "sequential",
    },
    notify: { enabled: false },
    providers: [
      {
        name: "primary",
        enabled: true,
        type: "anthropic",
        base_url: "http://mock-primary:9999",
        api_key: "sk-test-primary",
      },
      {
        name: "backup",
        enabled: true,
        type: "anthropic",
        base_url: "http://mock-backup:9999",
        api_key: "sk-test-backup",
      },
    ],
    ...overrides,
  };
}

const MESSAGES_PATH = "/v1/messages";
const BASIC_REQUEST = {
  method: "POST",
  path: MESSAGES_PATH,
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    model: "claude-sonnet-4-20250514",
    messages: [{ role: "user", content: "Hello" }],
    max_tokens: 100,
  }),
};

describe("Router", () => {
  test("routes to primary on success", async () => {
    // Mock fetch to return success from primary
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.includes("mock-primary")) {
        return new Response(
          JSON.stringify({ content: [{ text: "Hello!" }] }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;

    try {
      const router = new Router(makeConfig());
      const resp = await router.route(BASIC_REQUEST);
      expect(resp.status).toBe(200);

      const stats = router.getStats();
      expect(stats.totalRequests).toBe(1);
      expect(stats.totalFailovers).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("fails over from primary to backup on 429", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.includes("mock-primary")) {
        return new Response(
          JSON.stringify({
            error: { type: "rate_limit_error", message: "Rate limited" },
          }),
          { status: 429, headers: { "content-type": "application/json" } }
        );
      }
      if (urlStr.includes("mock-backup")) {
        return new Response(
          JSON.stringify({ content: [{ text: "From backup!" }] }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      return new Response("unexpected", { status: 500 });
    }) as typeof fetch;

    try {
      const router = new Router(makeConfig());
      const resp = await router.route(BASIC_REQUEST);

      expect(resp.status).toBe(200);
      const body =
        typeof resp.body === "string" ? resp.body : "stream";
      expect(body).toContain("From backup!");

      const stats = router.getStats();
      expect(stats.totalRequests).toBe(1);
      expect(stats.totalFailovers).toBe(1);
      // Primary should be marked degraded
      expect(stats.providers[0].healthy).toBe(false);
      expect(stats.providers[1].healthy).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("does NOT failover on 401 (auth error)", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => {
      return new Response(
        JSON.stringify({
          error: { type: "authentication_error", message: "Invalid key" },
        }),
        { status: 401, headers: { "content-type": "application/json" } }
      );
    }) as typeof fetch;

    try {
      const router = new Router(makeConfig());
      const resp = await router.route(BASIC_REQUEST);
      expect(resp.status).toBe(401);

      const stats = router.getStats();
      expect(stats.totalFailovers).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("fails over on connection error", async () => {
    const originalFetch = globalThis.fetch;
    let callCount = 0;
    globalThis.fetch = mock(async () => {
      callCount++;
      if (callCount === 1) {
        throw new Error("ECONNREFUSED");
      }
      return new Response(
        JSON.stringify({ content: [{ text: "From backup!" }] }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as typeof fetch;

    try {
      const router = new Router(makeConfig());
      const resp = await router.route(BASIC_REQUEST);
      expect(resp.status).toBe(200);

      const stats = router.getStats();
      expect(stats.totalFailovers).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("returns 503 when all providers fail", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => {
      return new Response(
        JSON.stringify({
          error: { type: "overloaded_error", message: "Overloaded" },
        }),
        { status: 529, headers: { "content-type": "application/json" } }
      );
    }) as typeof fetch;

    try {
      const router = new Router(makeConfig());
      const resp = await router.route(BASIC_REQUEST);
      expect(resp.status).toBe(503);

      const body =
        typeof resp.body === "string" ? resp.body : "";
      expect(body).toContain("all_providers_failed");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("provider cooldown prevents reuse", async () => {
    const originalFetch = globalThis.fetch;
    let callCount = 0;
    globalThis.fetch = mock(async () => {
      callCount++;
      if (callCount <= 2) {
        // Both fail on first request
        return new Response(
          JSON.stringify({
            error: { type: "rate_limit_error", message: "Rate limited" },
          }),
          { status: 429 }
        );
      }
      // Second request — backup should still be degraded
      return new Response(JSON.stringify({ content: [{ text: "ok" }] }), {
        status: 200,
      });
    }) as typeof fetch;

    try {
      const router = new Router(makeConfig());

      // First request: both providers fail
      const resp1 = await router.route(BASIC_REQUEST);
      expect(resp1.status).toBe(503);

      // Both providers in cooldown now
      const stats = router.getStats();
      expect(stats.providers[0].healthy).toBe(false);
      expect(stats.providers[1].healthy).toBe(false);

      // Second request: all still in cooldown → 503
      const resp2 = await router.route(BASIC_REQUEST);
      expect(resp2.status).toBe(503);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
