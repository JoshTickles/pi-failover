// src/providers/base.ts — Provider interface
import type { ProviderConfig } from "../config";

export interface ProviderRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}

export interface ProviderResponse {
  status: number;
  headers: Record<string, string>;
  body: ReadableStream<Uint8Array> | string;
  isStreaming: boolean;
}

export interface Provider {
  readonly name: string;
  readonly config: ProviderConfig;

  /**
   * Send a request to this provider.
   * Returns the raw response (streaming or buffered).
   * Throws on connection-level errors.
   */
  send(req: ProviderRequest): Promise<ProviderResponse>;
}
