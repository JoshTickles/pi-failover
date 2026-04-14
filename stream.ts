// stream.ts — Failover-aware Anthropic streaming implementation
//
// This is based on the custom-provider-anthropic example from pi.
// The key addition: on retriable errors, it retries with the next backend.

import Anthropic from "@anthropic-ai/sdk";
import type { ContentBlockParam, MessageCreateParamsStreaming } from "@anthropic-ai/sdk/resources/messages.js";
import {
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  calculateCost,
  createAssistantMessageEventStream,
  type ImageContent,
  type Message,
  type Model,
  type Api,
  type SimpleStreamOptions,
  type StopReason,
  type TextContent,
  type ThinkingContent,
  type Tool,
  type ToolCall,
  type ToolResultMessage,
} from "@mariozechner/pi-ai";
import type { BackendConfig, FailoverConfig } from "./config";
import { classifyError } from "./detection";

// ---------------------------------------------------------------------------
// Backend state tracking
// ---------------------------------------------------------------------------

export interface BackendState {
  config: BackendConfig;
  degradedUntil: number; // 0 = healthy
  errorCount: number;
  lastError?: string;
}

let backends: BackendState[] = [];
let failoverConfig: FailoverConfig;
let totalFailovers = 0;
let onFailoverCallback: ((from: string, to: string, reason: string) => void) | undefined;

export function initBackends(config: FailoverConfig) {
  failoverConfig = config;
  backends = config.backends
    .filter((b) => b.enabled)
    .map((b) => ({ config: b, degradedUntil: 0, errorCount: 0 }));
}

export function setFailoverCallback(cb: (from: string, to: string, reason: string) => void) {
  onFailoverCallback = cb;
}

export function getBackendStates(): BackendState[] {
  return backends;
}

export function getTotalFailovers(): number {
  return totalFailovers;
}

function getHealthyBackends(): BackendState[] {
  const now = Date.now();
  return backends.filter((b) => {
    if (b.degradedUntil > now) return false;
    if (b.degradedUntil > 0) b.degradedUntil = 0; // cooldown expired
    return true;
  });
}

function degradeBackend(state: BackendState, reason: string) {
  state.errorCount++;
  state.lastError = reason;
  state.degradedUntil = Date.now() + failoverConfig.failover.cooldown_seconds * 1000;
}

// ---------------------------------------------------------------------------
// Message conversion (from pi-ai format → Anthropic SDK format)
// Simplified from the custom-provider-anthropic example
// ---------------------------------------------------------------------------

function sanitize(text: string): string {
  return text.replace(/[\uD800-\uDFFF]/g, "\uFFFD");
}

function convertContentBlocks(
  content: (TextContent | ImageContent)[]
): string | Array<{ type: "text"; text: string } | { type: "image"; source: any }> {
  const hasImages = content.some((c) => c.type === "image");
  if (!hasImages) {
    return sanitize(content.map((c) => (c as TextContent).text).join("\n"));
  }
  const blocks = content.map((block) => {
    if (block.type === "text") return { type: "text" as const, text: sanitize(block.text) };
    return {
      type: "image" as const,
      source: { type: "base64" as const, media_type: block.mimeType, data: block.data },
    };
  });
  if (!blocks.some((b) => b.type === "text")) {
    blocks.unshift({ type: "text" as const, text: "(see attached image)" });
  }
  return blocks;
}

function convertMessages(messages: Message[]): any[] {
  const params: any[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        if (msg.content.trim()) params.push({ role: "user", content: sanitize(msg.content) });
      } else {
        const blocks: ContentBlockParam[] = msg.content.map((item) =>
          item.type === "text"
            ? { type: "text" as const, text: sanitize(item.text) }
            : {
                type: "image" as const,
                source: { type: "base64" as const, media_type: item.mimeType as any, data: item.data },
              }
        );
        if (blocks.length > 0) params.push({ role: "user", content: blocks });
      }
    } else if (msg.role === "assistant") {
      const blocks: ContentBlockParam[] = [];
      for (const block of msg.content) {
        if (block.type === "text" && block.text.trim()) {
          blocks.push({ type: "text", text: sanitize(block.text) });
        } else if (block.type === "thinking" && block.thinking.trim()) {
          if ((block as ThinkingContent).thinkingSignature) {
            blocks.push({
              type: "thinking" as any,
              thinking: sanitize(block.thinking),
              signature: (block as ThinkingContent).thinkingSignature!,
            });
          } else {
            blocks.push({ type: "text", text: sanitize(block.thinking) });
          }
        } else if (block.type === "toolCall") {
          blocks.push({
            type: "tool_use",
            id: block.id,
            name: block.name,
            input: block.arguments,
          });
        }
      }
      if (blocks.length > 0) params.push({ role: "assistant", content: blocks });
    } else if (msg.role === "toolResult") {
      const toolResults: any[] = [];
      toolResults.push({
        type: "tool_result",
        tool_use_id: msg.toolCallId,
        content: convertContentBlocks(msg.content),
        is_error: msg.isError,
      });
      let j = i + 1;
      while (j < messages.length && messages[j].role === "toolResult") {
        const nextMsg = messages[j] as ToolResultMessage;
        toolResults.push({
          type: "tool_result",
          tool_use_id: nextMsg.toolCallId,
          content: convertContentBlocks(nextMsg.content),
          is_error: nextMsg.isError,
        });
        j++;
      }
      i = j - 1;
      params.push({ role: "user", content: toolResults });
    }
  }
  // Cache control on last user message
  if (params.length > 0) {
    const last = params[params.length - 1];
    if (last.role === "user" && Array.isArray(last.content)) {
      const lastBlock = last.content[last.content.length - 1];
      if (lastBlock) lastBlock.cache_control = { type: "ephemeral" };
    }
  }
  return params;
}

function convertTools(tools: Tool[]): any[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: {
      type: "object",
      properties: (tool.parameters as any).properties || {},
      required: (tool.parameters as any).required || [],
    },
  }));
}

function mapStopReason(reason: string): StopReason {
  switch (reason) {
    case "end_turn":
    case "pause_turn":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "toolUse";
    default:
      return "error";
  }
}

// ---------------------------------------------------------------------------
// Core: attempt a single backend
// ---------------------------------------------------------------------------

async function attemptBackend(
  backend: BackendState,
  model: Model<Api>,
  context: Context,
  options: SimpleStreamOptions | undefined,
  output: AssistantMessage,
  stream: AssistantMessageEventStream
): Promise<boolean> {
  const apiKey = backend.config.api_key || options?.apiKey || "";
  const baseURL = backend.config.base_url || model.baseUrl || "https://api.anthropic.com";

  console.error(`[pi-failover] Attempting "${backend.config.name}" → ${baseURL}`);

  const betaFeatures = ["fine-grained-tool-streaming-2025-05-14", "interleaved-thinking-2025-05-14"];
  const client = new Anthropic({
    apiKey,
    baseURL,
    maxRetries: 0, // We handle retries via failover — don't let the SDK retry internally
    dangerouslyAllowBrowser: true,
    defaultHeaders: {
      accept: "application/json",
      "anthropic-dangerous-direct-browser-access": "true",
      "anthropic-beta": betaFeatures.join(","),
    },
  });

  const params: MessageCreateParamsStreaming = {
    model: model.id,
    messages: convertMessages(context.messages),
    max_tokens: options?.maxTokens || Math.floor(model.maxTokens / 3),
    stream: true,
  };

  if (context.systemPrompt) {
    params.system = [
      { type: "text", text: sanitize(context.systemPrompt), cache_control: { type: "ephemeral" } },
    ];
  }

  if (context.tools) {
    params.tools = convertTools(context.tools);
  }

  if (options?.reasoning && model.reasoning) {
    const budgets: Record<string, number> = {
      minimal: 1024,
      low: 4096,
      medium: 10240,
      high: 20480,
    };
    const customBudget = options.thinkingBudgets?.[options.reasoning as keyof typeof options.thinkingBudgets];
    params.thinking = {
      type: "enabled",
      budget_tokens: customBudget ?? budgets[options.reasoning] ?? 10240,
    };
  }

  const anthropicStream = client.messages.stream({ ...params }, { signal: options?.signal });

  type Block = (ThinkingContent | TextContent | (ToolCall & { partialJson: string })) & { index: number };
  const blocks = output.content as Block[];

  for await (const event of anthropicStream) {
    if (event.type === "message_start") {
      output.usage.input = event.message.usage.input_tokens || 0;
      output.usage.output = event.message.usage.output_tokens || 0;
      output.usage.cacheRead = (event.message.usage as any).cache_read_input_tokens || 0;
      output.usage.cacheWrite = (event.message.usage as any).cache_creation_input_tokens || 0;
      output.usage.totalTokens =
        output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
      calculateCost(model, output.usage);
    } else if (event.type === "content_block_start") {
      if (event.content_block.type === "text") {
        output.content.push({ type: "text", text: "", index: event.index } as any);
        stream.push({ type: "text_start", contentIndex: output.content.length - 1, partial: output });
      } else if (event.content_block.type === "thinking") {
        output.content.push({ type: "thinking", thinking: "", thinkingSignature: "", index: event.index } as any);
        stream.push({ type: "thinking_start", contentIndex: output.content.length - 1, partial: output });
      } else if (event.content_block.type === "tool_use") {
        output.content.push({
          type: "toolCall",
          id: event.content_block.id,
          name: event.content_block.name,
          arguments: {},
          partialJson: "",
          index: event.index,
        } as any);
        stream.push({ type: "toolcall_start", contentIndex: output.content.length - 1, partial: output });
      }
    } else if (event.type === "content_block_delta") {
      const index = blocks.findIndex((b) => b.index === event.index);
      const block = blocks[index];
      if (!block) continue;

      if (event.delta.type === "text_delta" && block.type === "text") {
        block.text += event.delta.text;
        stream.push({ type: "text_delta", contentIndex: index, delta: event.delta.text, partial: output });
      } else if (event.delta.type === "thinking_delta" && block.type === "thinking") {
        block.thinking += event.delta.thinking;
        stream.push({ type: "thinking_delta", contentIndex: index, delta: event.delta.thinking, partial: output });
      } else if (event.delta.type === "input_json_delta" && block.type === "toolCall") {
        (block as any).partialJson += event.delta.partial_json;
        try { block.arguments = JSON.parse((block as any).partialJson); } catch {}
        stream.push({ type: "toolcall_delta", contentIndex: index, delta: event.delta.partial_json, partial: output });
      } else if (event.delta.type === "signature_delta" && block.type === "thinking") {
        block.thinkingSignature = (block.thinkingSignature || "") + (event.delta as any).signature;
      }
    } else if (event.type === "content_block_stop") {
      const index = blocks.findIndex((b) => b.index === event.index);
      const block = blocks[index];
      if (!block) continue;
      delete (block as any).index;
      if (block.type === "text") {
        stream.push({ type: "text_end", contentIndex: index, content: block.text, partial: output });
      } else if (block.type === "thinking") {
        stream.push({ type: "thinking_end", contentIndex: index, content: block.thinking, partial: output });
      } else if (block.type === "toolCall") {
        try { block.arguments = JSON.parse((block as any).partialJson); } catch {}
        delete (block as any).partialJson;
        stream.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: output });
      }
    } else if (event.type === "message_delta") {
      if ((event.delta as any).stop_reason) {
        output.stopReason = mapStopReason((event.delta as any).stop_reason);
      }
      output.usage.input = (event.usage as any).input_tokens || output.usage.input;
      output.usage.output = (event.usage as any).output_tokens || output.usage.output;
      output.usage.cacheRead = (event.usage as any).cache_read_input_tokens || output.usage.cacheRead;
      output.usage.cacheWrite = (event.usage as any).cache_creation_input_tokens || output.usage.cacheWrite;
      output.usage.totalTokens =
        output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
      calculateCost(model, output.usage);
    }
  }

  return true; // success
}

// ---------------------------------------------------------------------------
// Public: failover-aware stream function
// ---------------------------------------------------------------------------

export function streamWithFailover(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();

  (async () => {
    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };

    try {
      stream.push({ type: "start", partial: output });

      const healthy = getHealthyBackends();
      if (healthy.length === 0) {
        throw new Error("All backends are in cooldown. Check pi-failover config.");
      }

      const maxAttempts = Math.min(failoverConfig.failover.max_retries, healthy.length);
      let lastError: Error | undefined;

      for (let i = 0; i < maxAttempts; i++) {
        const backend = healthy[i];

        try {
          // Reset output content for each attempt (clean slate)
          output.content = [];

          await attemptBackend(backend, model, context, options, output, stream);

          if (options?.signal?.aborted) throw new Error("Request was aborted");

          // Success
          if (i > 0) {
            console.error(`[pi-failover] ✅ Failover succeeded on backend "${backend.config.name}" (attempt ${i + 1})`);
            totalFailovers++;
          } else {
            console.error(`[pi-failover] ✅ Primary backend "${backend.config.name}" succeeded`);
          }

          stream.push({
            type: "done",
            reason: output.stopReason as "stop" | "length" | "toolUse",
            message: output,
          });
          stream.end();
          return;
        } catch (err) {
          // Abort = don't retry
          if (options?.signal?.aborted) throw err;

          const classification = classifyError(err, failoverConfig.failover);
          lastError = err instanceof Error ? err : new Error(String(err));

          console.error(`[pi-failover] ❌ "${backend.config.name}" → ${classification.reason}`);

          if (!classification.shouldFailover) {
            // Non-retriable error — bubble up immediately
            throw lastError;
          }

          // Degrade this backend
          degradeBackend(backend, classification.reason);

          // Notify about failover
          const nextBackend = healthy[i + 1];
          if (nextBackend && onFailoverCallback) {
            onFailoverCallback(backend.config.name, nextBackend.config.name, classification.reason);
          }
        }
      }

      // All attempts exhausted
      throw lastError || new Error("All backends failed");
    } catch (error) {
      for (const block of output.content) delete (block as any).index;
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();

  return stream;
}
