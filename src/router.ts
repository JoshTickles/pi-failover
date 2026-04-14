// src/router.ts — Failover logic + provider selection
import type { Config, ProviderConfig } from "./config";
import type { Provider, ProviderRequest, ProviderResponse } from "./providers/base";
import { AnthropicProvider } from "./providers/anthropic";
import {
  classifyHttpError,
  classifyConnectionError,
} from "./detection";
import { createStreamMonitor, streamToString } from "./stream";
import { notifyFailover } from "./notify";
import * as log from "./log";

interface ProviderState {
  provider: Provider;
  degradedUntil: number; // timestamp — 0 means healthy
  errorCount: number;
  lastError?: string;
}

export interface RouterStats {
  totalRequests: number;
  totalFailovers: number;
  providers: {
    name: string;
    type: string;
    enabled: boolean;
    healthy: boolean;
    errorCount: number;
    lastError?: string;
    degradedUntil?: string;
  }[];
}

export class Router {
  private providers: ProviderState[] = [];
  private config: Config;
  private totalRequests = 0;
  private totalFailovers = 0;

  constructor(config: Config) {
    this.config = config;

    for (const pc of config.providers.filter((p) => p.enabled)) {
      const provider = this.createProvider(pc);
      if (provider) {
        this.providers.push({
          provider,
          degradedUntil: 0,
          errorCount: 0,
        });
      }
    }
  }

  private createProvider(config: ProviderConfig): Provider | null {
    switch (config.type) {
      case "anthropic":
        return new AnthropicProvider(config);
      case "bedrock":
        log.warn("Bedrock provider not yet implemented, skipping", {
          provider: config.name,
        });
        return null;
      case "vertex":
        log.warn("Vertex provider not yet implemented, skipping", {
          provider: config.name,
        });
        return null;
      case "openai-compat":
        log.warn("OpenAI-compat provider not yet implemented, skipping", {
          provider: config.name,
        });
        return null;
      default:
        log.error("Unknown provider type", {
          provider: config.name,
          type: config.type,
        });
        return null;
    }
  }

  /** Get ordered list of healthy providers */
  private getAvailableProviders(): ProviderState[] {
    const now = Date.now();
    return this.providers.filter((p) => {
      if (p.degradedUntil > now) {
        log.debug("Provider still in cooldown", {
          provider: p.provider.name,
          remainingMs: p.degradedUntil - now,
        });
        return false;
      }
      // Reset degraded state if cooldown expired
      if (p.degradedUntil > 0 && p.degradedUntil <= now) {
        log.info("Provider cooldown expired, restoring", {
          provider: p.provider.name,
        });
        p.degradedUntil = 0;
      }
      return true;
    });
  }

  /** Mark a provider as degraded */
  private degradeProvider(state: ProviderState, reason: string) {
    state.errorCount++;
    state.lastError = reason;
    state.degradedUntil =
      Date.now() + this.config.failover.cooldown_seconds * 1000;

    log.warn("Provider degraded", {
      provider: state.provider.name,
      reason,
      cooldownSeconds: this.config.failover.cooldown_seconds,
      totalErrors: state.errorCount,
    });
  }

  /**
   * Route a request through the failover chain.
   *
   * For non-streaming: attempt provider, check status, failover if needed.
   * For streaming: we get a 200 + SSE stream. Monitor the stream for errors,
   * but don't do mid-stream failover (Phase 5). If the initial response is
   * an error status, failover before any streaming starts.
   */
  async route(req: ProviderRequest): Promise<ProviderResponse> {
    this.totalRequests++;
    const available = this.getAvailableProviders();

    if (available.length === 0) {
      log.error("All providers exhausted or in cooldown");
      return {
        status: 503,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          error: {
            type: "all_providers_exhausted",
            message:
              "All configured providers are unavailable. Check pi-failover logs.",
          },
        }),
        isStreaming: false,
      };
    }

    const maxRetries = Math.min(
      this.config.failover.max_retries,
      available.length
    );

    let lastError: string = "no providers attempted";

    for (let i = 0; i < maxRetries; i++) {
      const state = available[i];
      const providerName = state.provider.name;

      log.info("Attempting provider", {
        provider: providerName,
        attempt: i + 1,
        maxRetries,
        path: req.path,
      });

      try {
        const response = await state.provider.send(req);

        // Non-error response — success
        if (response.status >= 200 && response.status < 400) {
          if (i > 0) {
            log.info("Failover succeeded", {
              provider: providerName,
              attempt: i + 1,
            });
          }

          // For streaming, wrap in monitor
          if (response.isStreaming && response.body instanceof ReadableStream) {
            const monitor = createStreamMonitor(
              this.config.failover,
              (reason) => {
                log.warn("Stream error detected (no mid-stream failover yet)", {
                  provider: providerName,
                  reason,
                });
              }
            );
            const monitoredStream = response.body.pipeThrough(monitor);
            return { ...response, body: monitoredStream };
          }

          return response;
        }

        // Error response — classify it
        const body =
          typeof response.body === "string"
            ? response.body
            : await streamToString(response.body);

        const classification = classifyHttpError(
          response.status,
          body,
          this.config.failover
        );

        if (!classification.shouldFailover) {
          // Non-retriable error — return it directly
          log.info("Non-retriable error, returning to client", {
            provider: providerName,
            status: response.status,
            reason: classification.reason,
          });
          return {
            status: response.status,
            headers: response.headers,
            body,
            isStreaming: false,
          };
        }

        // Failover-worthy error
        lastError = classification.reason;
        this.degradeProvider(state, classification.reason);
        this.totalFailovers++;

        // Notify about failover
        const nextProvider = available[i + 1];
        if (nextProvider) {
          await notifyFailover(
            this.config.notify,
            providerName,
            nextProvider.provider.name,
            classification.reason
          );
        }

        log.warn("Failing over to next provider", {
          from: providerName,
          reason: classification.reason,
          attempt: i + 1,
        });
      } catch (err) {
        // Connection-level error
        const error = err instanceof Error ? err : new Error(String(err));
        const classification = classifyConnectionError(
          error,
          this.config.failover
        );

        lastError = classification.reason;

        if (classification.shouldFailover) {
          this.degradeProvider(state, classification.reason);
          this.totalFailovers++;

          const nextProvider = available[i + 1];
          if (nextProvider) {
            await notifyFailover(
              this.config.notify,
              providerName,
              nextProvider.provider.name,
              classification.reason
            );
          }

          log.warn("Connection error, failing over", {
            from: providerName,
            reason: classification.reason,
          });
        } else {
          // Connection error but failover disabled for it
          return {
            status: 502,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              error: {
                type: "connection_error",
                message: classification.reason,
              },
            }),
            isStreaming: false,
          };
        }
      }
    }

    // All retries exhausted
    log.error("All providers failed", { lastError });
    return {
      status: 503,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        error: {
          type: "all_providers_failed",
          message: `All providers failed. Last error: ${lastError}`,
        },
      }),
      isStreaming: false,
    };
  }

  /** Get current router stats for /status endpoint */
  getStats(): RouterStats {
    const now = Date.now();
    return {
      totalRequests: this.totalRequests,
      totalFailovers: this.totalFailovers,
      providers: this.providers.map((s) => ({
        name: s.provider.name,
        type: s.provider.config.type,
        enabled: s.provider.config.enabled,
        healthy: s.degradedUntil <= now,
        errorCount: s.errorCount,
        lastError: s.lastError,
        degradedUntil:
          s.degradedUntil > now
            ? new Date(s.degradedUntil).toISOString()
            : undefined,
      })),
    };
  }
}
