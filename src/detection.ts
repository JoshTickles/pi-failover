// src/detection.ts — Error classification: failover-worthy vs fatal
import type { FailoverConfig } from "./config";

export interface ErrorClassification {
  shouldFailover: boolean;
  reason: string;
  httpStatus?: number;
  errorType?: string;
}

/**
 * Classify an HTTP response to decide if we should failover.
 *
 * Failover-worthy errors (configurable):
 *   429 - rate_limit_error (usage cap, RPM/TPM limit)
 *   402 - billing_error (subscription exhausted)
 *   500 - api_error (internal server error)
 *   504 - timeout_error (server-side timeout)
 *   529 - overloaded_error (servers under load)
 *
 * Non-failover errors (always fatal — config issue, not transient):
 *   400 - invalid_request_error
 *   401 - authentication_error
 *   403 - permission_error
 *   413 - request_too_large
 */
export function classifyHttpError(
  status: number,
  body: string | null,
  config: FailoverConfig
): ErrorClassification {
  // Parse error body if available
  let errorType: string | undefined;
  let errorMessage: string | undefined;
  if (body) {
    try {
      const parsed = JSON.parse(body);
      errorType = parsed?.error?.type || parsed?.type;
      errorMessage = parsed?.error?.message || parsed?.message;
    } catch {
      // Not JSON — could be a raw error string
      errorMessage = body.slice(0, 200);
    }
  }

  const shouldFailover = config.trigger_codes.includes(status);

  return {
    shouldFailover,
    reason: shouldFailover
      ? `HTTP ${status} (${errorType || "unknown"}): ${errorMessage || "no details"}`
      : `Non-retriable HTTP ${status} (${errorType || "unknown"}): ${errorMessage || "no details"}`,
    httpStatus: status,
    errorType,
  };
}

/**
 * Classify a connection-level error (DNS, TCP, TLS failure).
 */
export function classifyConnectionError(
  error: Error,
  config: FailoverConfig
): ErrorClassification {
  return {
    shouldFailover: config.trigger_on_connection_error,
    reason: `Connection error: ${error.message}`,
  };
}

/**
 * Classify an SSE stream error (connection dropped mid-stream).
 */
export function classifyStreamError(
  error: Error | string,
  config: FailoverConfig
): ErrorClassification {
  const message = typeof error === "string" ? error : error.message;
  return {
    shouldFailover: config.trigger_on_stream_error,
    reason: `Stream error: ${message}`,
  };
}

/**
 * Check if an SSE event indicates an error that should trigger failover.
 * Anthropic streams can emit error events after the initial 200 response.
 */
export function classifyStreamEvent(
  eventType: string,
  eventData: string,
  config: FailoverConfig
): ErrorClassification | null {
  if (eventType !== "error") return null;

  try {
    const parsed = JSON.parse(eventData);
    const errorType = parsed?.error?.type || parsed?.type;
    const errorMessage = parsed?.error?.message || parsed?.message;

    // Map Anthropic SSE error types to equivalent HTTP codes
    const typeToCode: Record<string, number> = {
      overloaded_error: 529,
      rate_limit_error: 429,
      api_error: 500,
    };

    const equivalentCode = typeToCode[errorType] || 500;
    const shouldFailover = config.trigger_codes.includes(equivalentCode);

    return {
      shouldFailover,
      reason: `SSE error event (${errorType}): ${errorMessage || "no details"}`,
      errorType,
    };
  } catch {
    return {
      shouldFailover: config.trigger_on_stream_error,
      reason: `Unparseable SSE error: ${eventData.slice(0, 200)}`,
    };
  }
}
