// src/stream.ts — SSE stream handling: proxying + error detection
import type { FailoverConfig } from "./config";
import { classifyStreamEvent } from "./detection";
import * as log from "./log";

/**
 * Read an SSE stream looking for error events.
 * Returns a TransformStream that:
 * - Passes through all chunks normally
 * - Signals via callback if a failover-worthy error is detected
 *
 * For Phase 1, we do NOT do mid-stream failover. If an error is detected
 * after streaming has started, we log it but let it through — the client
 * (Claude Code) will see the error and can retry.
 *
 * Mid-stream failover (discarding partial + replaying) is Phase 5.
 */
export function createStreamMonitor(
  config: FailoverConfig,
  onStreamError?: (reason: string) => void
): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  let buffer = "";

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      // Always forward the chunk immediately
      controller.enqueue(chunk);

      // Parse for error events (best-effort, don't block)
      try {
        buffer += decoder.decode(chunk, { stream: true });

        // Process complete SSE lines
        const lines = buffer.split("\n");
        buffer = lines.pop() || ""; // Keep incomplete last line

        let currentEventType = "";

        for (const line of lines) {
          if (line.startsWith("event: ")) {
            currentEventType = line.slice(7).trim();
          } else if (line.startsWith("data: ") && currentEventType) {
            const data = line.slice(6);
            const classification = classifyStreamEvent(
              currentEventType,
              data,
              config
            );
            if (classification?.shouldFailover) {
              log.warn("SSE error event detected mid-stream", {
                reason: classification.reason,
              });
              onStreamError?.(classification.reason);
            }
            // Reset after processing data for this event
            if (line === "" || lines.indexOf(line) < lines.length - 1) {
              currentEventType = "";
            }
          } else if (line === "") {
            currentEventType = "";
          }
        }
      } catch (err) {
        // Don't let monitoring errors break the stream
        log.debug("Stream monitor parse error", {
          error: String(err),
        });
      }
    },
  });
}

/**
 * Consume a ReadableStream fully into a string.
 * Used when we need to buffer a non-streaming response.
 */
export async function streamToString(
  stream: ReadableStream<Uint8Array>
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let result = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    result += decoder.decode(value, { stream: true });
  }

  result += decoder.decode(); // flush
  return result;
}
