# Pi Failover — Automatic LLM Model Failover Extension for Pi

## Problem

When using Pi, the session dies when the active model hits a usage cap, rate
limit, billing error, or service outage. The user must manually switch models.

## Solution

A **Pi extension** that registers a custom `failover` provider via
`pi.registerProvider()`. The provider's `streamSimple` function wraps the
Anthropic SDK with automatic failover across multiple backends.

---

## Architecture

**Not a proxy.** This is a native Pi extension that uses:

- `pi.registerProvider("failover", { streamSimple })` — custom streaming with failover
- `pi.on("session_start")` — UI status setup
- `pi.registerCommand("failover")` — `/failover` status command
- `pi.registerTool("failover_status")` — LLM-callable health check
- `ctx.ui.setStatus()` / `ctx.ui.notify()` — visual feedback on failover

```
Pi Agent
  └─► failover provider (streamSimple)
        ├─► Backend 1 (primary) ──► error? → degrade + cooldown
        ├─► Backend 2 (backup)  ──► success? → stream to Pi
        └─► Backend N           ──► all failed → surface error
```

## Detection: What Errors Trigger Failover?

### Anthropic API error codes

| HTTP | Type | Trigger failover? | Notes |
|------|------|-------------------|-------|
| 429 | rate_limit_error | **Yes** | Usage cap or RPM/TPM limit |
| 402 | billing_error | **Yes** | Subscription exhausted |
| 529 | overloaded_error | **Yes** | Servers under load |
| 500 | api_error | **Yes** | Internal server error |
| 504 | timeout_error | **Yes** | Server-side timeout |
| 401 | authentication_error | No | Config issue |
| 400 | invalid_request_error | No | Bad request |
| 403 | permission_error | No | Key lacks permission |

### Connection errors

ECONNREFUSED, ENOTFOUND, ETIMEDOUT, fetch failures — all configurable.

### Detection strategy

```
For each model request:
  1. Try backend[0] (highest priority)
  2. If Anthropic SDK throws with status in trigger_codes:
     a. Mark backend as degraded (cooldown timer)
     b. Notify user (desktop + status bar)
     c. Retry with backend[1]
  3. If non-retriable error (401, 400, etc.):
     a. Bubble up immediately — config issue, not transient
  4. If ALL backends exhausted → surface error to Pi
  5. Degraded backends recover after cooldown (default: 5 min)
```

---

## File Structure

```
pi-failover/
├── index.ts              # Pi extension entry point (registerProvider, commands)
├── stream.ts             # Failover-aware streamSimple implementation
├── detection.ts          # Error classification (failover vs fatal)
├── config.ts             # YAML config loading
├── failover.yaml         # User config template
├── package.json          # pi.extensions declaration
├── tests/
│   ├── detection.test.ts
│   └── config.test.ts
├── PLAN.md
└── README.md
```

---

## Implementation Phases

### Phase 1 — Core (Done ✅)
- [x] Pi extension with `registerProvider` + `streamSimple`
- [x] Anthropic SDK streaming with full event translation
- [x] Error detection on SDK exceptions (HTTP status codes)
- [x] Sequential failover across backends with cooldown
- [x] YAML config (backends, trigger codes, cooldowns)
- [x] `/failover` command for status
- [x] `failover_status` tool for LLM
- [x] Desktop notification on failover (macOS)
- [x] Status bar indicator
- [x] 17 passing tests

### Phase 2 — Model Configuration
- [ ] Dynamic model list from config (not hardcoded)
- [ ] Per-backend model mapping (e.g. Opus on primary → Sonnet on backup)
- [ ] Cost tracking per backend

### Phase 3 — AWS Bedrock Backend
- [ ] Backend type: "bedrock" with SigV4 auth
- [ ] Bedrock-specific error detection (ThrottlingException)
- [ ] Model ID mapping (anthropic.claude-sonnet-4-20250514-v1:0)

### Phase 4 — Google Vertex Backend
- [ ] Backend type: "vertex" with GCP service account auth
- [ ] Vertex-specific error detection (ResourceExhausted)

### Phase 5 — Advanced
- [ ] Mid-stream failover (detect error after streaming started, retry full request)
- [ ] Health probing (periodic test requests)
- [ ] OpenAI-compatible backend (for LiteLLM routing)
- [ ] Per-request token/cost tracking widget

---

## Open Questions

1. **Mid-stream failover**: If streaming starts then errors at 60%, discard and
   replay on backup? Current approach: errors before first event → retry;
   errors mid-stream → bubble up to Pi's own retry logic.

2. **Model mapping**: If primary has Opus but backup only has Sonnet, should the
   extension auto-downgrade? Current: same model ID sent to all backends.

3. **OAuth support**: Should the failover provider support Claude Pro/Max OAuth
   as a backend? Adds complexity but covers the "subscription ran out → API key
   fallback" case from issue #43260.
