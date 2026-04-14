// src/providers/anthropic.ts — Native Anthropic API passthrough provider
import type { ProviderConfig } from "../config";
import type { Provider, ProviderRequest, ProviderResponse } from "./base";
import * as log from "../log";

const DEFAULT_BASE_URL = "https://api.anthropic.com";

export class AnthropicProvider implements Provider {
  readonly name: string;
  readonly config: ProviderConfig;
  private baseUrl: string;

  constructor(config: ProviderConfig) {
    this.name = config.name;
    this.config = config;
    this.baseUrl = (config.base_url || DEFAULT_BASE_URL).replace(/\/$/, "");
  }

  async send(req: ProviderRequest): Promise<ProviderResponse> {
    const url = `${this.baseUrl}${req.path}`;

    // Build headers — forward most, but override auth
    const headers = new Headers();

    // Copy safe request headers
    const forwardHeaders = [
      "content-type",
      "anthropic-version",
      "anthropic-beta",
      "accept",
    ];
    for (const key of forwardHeaders) {
      if (req.headers[key]) {
        headers.set(key, req.headers[key]);
      }
    }

    // Set auth from provider config
    if (this.config.api_key) {
      headers.set("x-api-key", this.config.api_key);
    }

    // Ensure content-type
    if (!headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }

    log.debug("anthropic provider sending", {
      provider: this.name,
      url,
      streaming: req.headers["accept"]?.includes("text/event-stream") || false,
    });

    const response = await fetch(url, {
      method: req.method,
      headers,
      body: req.method !== "GET" ? req.body : undefined,
    });

    const isStreaming =
      response.headers.get("content-type")?.includes("text/event-stream") ??
      false;

    // Build response headers
    const respHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      // Forward relevant headers
      if (
        !["transfer-encoding", "connection", "keep-alive"].includes(
          key.toLowerCase()
        )
      ) {
        respHeaders[key] = value;
      }
    });

    if (isStreaming && response.body) {
      return {
        status: response.status,
        headers: respHeaders,
        body: response.body,
        isStreaming: true,
      };
    }

    // Non-streaming: read full body
    const body = await response.text();
    return {
      status: response.status,
      headers: respHeaders,
      body,
      isStreaming: false,
    };
  }
}
