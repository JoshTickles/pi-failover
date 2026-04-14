// src/server.ts — Bun HTTP server + request handler
import type { Config } from "./config";
import type { ProviderRequest } from "./providers/base";
import { Router } from "./router";
import * as log from "./log";

export function createServer(config: Config): {
  router: Router;
  start: () => void;
} {
  const router = new Router(config);
  const { host, port } = config.listen;

  function start() {
    Bun.serve({
      hostname: host,
      port,
      fetch: async (request: Request): Promise<Response> => {
        const url = new URL(request.url);
        const path = url.pathname;

        // --- Health check ---
        if (path === "/health") {
          return new Response(
            JSON.stringify({ status: "ok", uptime: process.uptime() }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            }
          );
        }

        // --- Status dashboard ---
        if (path === "/status") {
          return new Response(JSON.stringify(router.getStats(), null, 2), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }

        // --- Proxy all other requests ---
        try {
          // Read request body
          const body = await request.text();

          // Collect headers
          const headers: Record<string, string> = {};
          request.headers.forEach((value, key) => {
            headers[key.toLowerCase()] = value;
          });

          const providerReq: ProviderRequest = {
            method: request.method,
            path: path + url.search,
            headers,
            body,
          };

          log.debug("Incoming request", {
            method: request.method,
            path,
            contentLength: body.length,
            streaming: headers["accept"]?.includes("text/event-stream"),
          });

          const response = await router.route(providerReq);

          // Build response headers
          const respHeaders = new Headers();
          for (const [key, value] of Object.entries(response.headers)) {
            respHeaders.set(key, value);
          }

          // Return streaming or buffered response
          if (
            response.isStreaming &&
            response.body instanceof ReadableStream
          ) {
            return new Response(response.body, {
              status: response.status,
              headers: respHeaders,
            });
          }

          return new Response(
            typeof response.body === "string"
              ? response.body
              : "Internal error",
            {
              status: response.status,
              headers: respHeaders,
            }
          );
        } catch (err) {
          log.error("Unhandled server error", {
            error: String(err),
            path,
          });
          return new Response(
            JSON.stringify({
              error: {
                type: "proxy_error",
                message: `pi-failover internal error: ${String(err)}`,
              },
            }),
            {
              status: 500,
              headers: { "content-type": "application/json" },
            }
          );
        }
      },
    });

    log.info(`pi-failover proxy listening`, { host, port });
    log.info(`Set ANTHROPIC_BASE_URL=http://${host}:${port} to use`);
  }

  return { router, start };
}
