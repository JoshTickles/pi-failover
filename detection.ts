// detection.ts — Classify API errors as failover-worthy or fatal
import type { FailoverRules } from "./config";

export interface ErrorClassification {
  shouldFailover: boolean;
  reason: string;
  httpStatus?: number;
}

/**
 * Failover-worthy (transient):
 *   429 - rate_limit_error (usage cap, RPM/TPM limit)
 *   402 - billing_error (subscription exhausted)
 *   500 - api_error (internal server error)
 *   504 - timeout_error (server-side timeout)
 *   529 - overloaded_error (servers under load)
 *
 * NOT failover-worthy (config issue):
 *   400 - invalid_request_error
 *   401 - authentication_error
 *   403 - permission_error
 *   413 - request_too_large
 */
export function classifyError(
  error: unknown,
  rules: FailoverRules
): ErrorClassification {
  // Anthropic SDK errors have .status and .message
  if (error && typeof error === "object") {
    const err = error as any;

    // HTTP status from Anthropic SDK APIError
    if (typeof err.status === "number") {
      const shouldFailover = rules.trigger_codes.includes(err.status);
      return {
        shouldFailover,
        reason: `HTTP ${err.status}: ${err.message || "unknown"}`,
        httpStatus: err.status,
      };
    }

    // Connection-level errors (ECONNREFUSED, DNS failures, etc.)
    if (err.code === "ECONNREFUSED" || err.code === "ENOTFOUND" || err.code === "ETIMEDOUT") {
      return {
        shouldFailover: rules.trigger_on_connection_error,
        reason: `Connection error: ${err.code} - ${err.message || ""}`,
      };
    }

    // Fetch errors (network level)
    if (err.cause && typeof err.cause === "object") {
      const cause = err.cause as any;
      if (cause.code === "ECONNREFUSED" || cause.code === "ENOTFOUND") {
        return {
          shouldFailover: rules.trigger_on_connection_error,
          reason: `Connection error: ${cause.code}`,
        };
      }
    }
  }

  // Generic error — check if it's a network/timeout error by message
  const message = error instanceof Error ? error.message : String(error);
  const isNetworkError =
    message.includes("fetch failed") ||
    message.includes("ECONNREFUSED") ||
    message.includes("ENOTFOUND") ||
    message.includes("socket hang up") ||
    message.includes("network");

  return {
    shouldFailover: isNetworkError && rules.trigger_on_connection_error,
    reason: message,
  };
}
