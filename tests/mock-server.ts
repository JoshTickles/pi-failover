// tests/mock-server.ts — Mock Anthropic API servers for integration tests
//
// Port 19001: Always returns 429 rate_limit_error
// Port 19002: Returns valid Anthropic SSE streaming response

const SSE_RESPONSE = `event: message_start
data: {"type":"message_start","message":{"id":"msg_test","type":"message","role":"assistant","content":[],"model":"mock-model","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":10,"output_tokens":1}}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"pong"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}

event: message_stop
data: {"type":"message_stop"}

`;

Bun.serve({
  port: 19001,
  fetch() {
    return new Response(
      JSON.stringify({ error: { type: "rate_limit_error", message: "Rate limit exceeded" } }),
      { status: 429, headers: { "content-type": "application/json" } }
    );
  },
});

Bun.serve({
  port: 19002,
  fetch() {
    return new Response(SSE_RESPONSE, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  },
});

console.error("[mock] 429 on :19001, 200 SSE on :19002");
// Keep alive
await new Promise(() => {});
