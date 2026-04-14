// Tiny mock: port 19001 returns 429, port 19002 returns a valid Anthropic streaming response
const MOCK_SSE = `event: message_start
data: {"type":"message_start","message":{"id":"msg_test","type":"message","role":"assistant","content":[],"model":"claude-sonnet-4-20250514","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":10,"output_tokens":1}}}

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

// 429 server
Bun.serve({
  port: 19001,
  fetch() {
    console.error("[mock:19001] Returning 429");
    return new Response(
      JSON.stringify({ error: { type: "rate_limit_error", message: "Rate limit exceeded" } }),
      { status: 429, headers: { "content-type": "application/json" } }
    );
  },
});

// Success server
Bun.serve({
  port: 19002,
  fetch() {
    console.error("[mock:19002] Returning 200 SSE");
    return new Response(MOCK_SSE, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  },
});

console.error("[mock] 429 server on :19001, success server on :19002");
