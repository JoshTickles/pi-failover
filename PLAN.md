# Pi Failover — Automatic LLM Model Failover Proxy

## Problem

When using Claude Code (or any LLM-powered coding agent), the session dies when
the active model hits a usage cap, rate limit, billing error, or service outage.
The user must manually switch API keys, providers, or models. This breaks flow
and wastes time.

## Goal

Build a configurable proxy service that sits between Claude Code and the upstream
LLM API. It transparently intercepts errors and fails over to a prioritised list
of backup providers/models — so the coding session never drops.

---

## Architecture Decision: Why a Proxy?

Three approaches were evaluated:

| Approach | Pros | Cons |
|---|---|---|
| **A — Smart proxy** | Works today, transparent to client, full control over routing | Must faithfully proxy Anthropic streaming protocol |
| **B — Claude Code hooks** | Native integration | `BeforeModel`/`AfterModel` hooks don't exist yet ([#21531](https://github.com/anthropics/claude-code/issues/21531)); tool-level hooks can't intercept or reroute model calls |
| **C — Wrapper script** | Simple | Can only detect failures *after* the session errors out; no mid-stream recovery; clumsy UX |

**Decision: Option A — a lightweight reverse-proxy** that speaks the Anthropic
Messages API on the frontend and dispatches to multiple backends. Claude Code
already supports `ANTHROPIC_BASE_URL` for exactly this pattern.

---

## Detection: What Errors Trigger Failover?

### Anthropic API error codes (from official docs)

| HTTP | Type | Trigger failover? | Notes |
|------|------|-------------------|-------|
| 429 | `rate_limit_error` | **Yes** | Usage cap or RPM/TPM limit exceeded |
| 402 | `billing_error` | **Yes** | Billing/payment issue (e.g. Max subscription exhausted) |
| 529 | `overloaded_error` | **Yes** | Anthropic servers under load |
| 500 | `api_error` | **Yes** | Internal server error |
| 504 | `timeout_error` | **Yes** | Request timed out server-side |
| 401 | `authentication_error` | No | Config error — alert user, don't failover |
| 400 | `invalid_request_error` | No | Bad request — retrying elsewhere won't help |
| 403 | `permission_error` | No | Key lacks permission — config issue |
| 413 | `request_too_large` | No | Payload too big — won't fit elsewhere either |

### Additional detection signals

- **Streaming mid-stream errors**: SSE connections can return 200 then error
  partway through. The proxy must detect `error` events in the SSE stream and
  decide whether the partial response is salvageable or must be retried.
- **Connection-level failures**: TCP reset, TLS handshake failure, DNS
  resolution failure, proxy timeout — all trigger failover.
- **Bedrock/Vertex-specific errors**: `ThrottlingException` (Bedrock 429
  equivalent), `ResourceExhausted` (Vertex/gRPC), service-specific 5xx.

### Detection strategy

```
For each upstream request:
  1. Attempt provider[0] (highest priority)
  2. If error is in FAILOVER_TRIGGERS:
     a. Log the error + provider
     b. If streaming had started, buffer and discard partial response
     c. Mark provider as "degraded" with cooldown timer
     d. Retry with provider[1], then [2], etc.
  3. If ALL providers exhausted:
     a. Return the last error to the client with a clear message
     b. Optionally notify user (webhook, desktop notification)
  4. Degraded providers recover after cooldown (default: 5 min)
```

---

## Provider Backends

The proxy translates the inbound Anthropic-format request to each backend's
native protocol:

| Backend | Protocol | Auth | Config env vars (existing CC support) |
|---------|----------|------|---------------------------------------|
| Anthropic API | Native | `ANTHROPIC_API_KEY` | `ANTHROPIC_BASE_URL` |
| AWS Bedrock | Bedrock Messages API | AWS SigV4 | `CLAUDE_CODE_USE_BEDROCK`, `AWS_*` |
| Google Vertex AI | Vertex Messages API | GCP service account | `CLAUDE_CODE_USE_VERTEX`, `ANTHROPIC_VERTEX_*` |
| Microsoft Foundry | Foundry Messages API | Azure AD | `CLAUDE_CODE_USE_FOUNDRY`, `ANTHROPIC_FOUNDRY_*` |
| LiteLLM | OpenAI-compat → Anthropic adapter | API key | Custom |
| Any OpenAI-compat | Needs translation layer | API key | Custom |

### Priority for Josh's setup

1. **Anthropic API** (primary — Claude Max subscription)
2. **AWS Bedrock** (failover — org/personal AWS account)
3. **LiteLLM @ 172.16.1.113** (failover — Azure OpenAI via home network)

---

## Configuration

### Config file: `failover.yaml`

```yaml
# Pi Failover configuration
listen:
  host: "127.0.0.1"
  port: 8080

# Failover behaviour
failover:
  # Errors that trigger failover to next provider
  trigger_codes: [429, 402, 500, 504, 529]
  trigger_on_connection_error: true
  trigger_on_stream_error: true

  # How long to skip a failed provider before retrying it
  cooldown_seconds: 300

  # Max retries across all providers per request
  max_retries: 3

  # Strategy: "sequential" (try in order) or "round-robin"
  strategy: "sequential"

# Notification on failover (optional)
notify:
  enabled: false
  # webhook_url: "https://hooks.slack.com/..."
  # desktop: true

# Ordered list of providers — first available wins
providers:
  - name: "anthropic"
    enabled: true
    type: "anthropic"        # native Anthropic Messages API
    api_key_env: "ANTHROPIC_API_KEY"  # reads from env
    base_url: "https://api.anthropic.com"

  - name: "bedrock"
    enabled: true
    type: "bedrock"          # AWS Bedrock Anthropic endpoint
    region: "us-west-2"
    # model_id: "anthropic.claude-sonnet-4-20250514-v1:0"
    # Uses default AWS credential chain (env, profile, instance role)

  - name: "litellm-home"
    enabled: false
    type: "openai-compat"    # OpenAI-compatible API (needs translation)
    base_url: "http://172.16.1.113"
    model: "azure/openai-gpt-lb"
    api_key_env: "LITELLM_API_KEY"

  - name: "vertex"
    enabled: false
    type: "vertex"           # Google Vertex AI
    project_id: "str-r-and-d"
    region: "us-central1"
```

### Usage

```bash
# Start the failover proxy
pi-failover start

# Claude Code uses it via ANTHROPIC_BASE_URL
export ANTHROPIC_BASE_URL="http://127.0.0.1:8080"
claude

# Or use the wrapper (sets env + starts proxy if needed)
pi-failover wrap -- claude
```

---

## Tech Stack

| Component | Choice | Rationale |
|-----------|--------|-----------|
| Language | **TypeScript / Bun** | Fast startup, native streaming support, matches Pi ecosystem |
| HTTP server | Bun's built-in `Bun.serve()` | Zero-dep, handles SSE streaming natively |
| Config | YAML (`yaml` package) | Human-readable, matches k8s conventions |
| AWS auth | `@aws-sdk/credential-providers` | SigV4 for Bedrock |
| GCP auth | `google-auth-library` | Vertex AI service account |
| Logging | Structured JSON to stderr | Parseable, non-intrusive |

---

## Implementation Phases

### Phase 1 — Core Proxy + Anthropic↔Anthropic Failover
- [ ] Bun HTTP server accepting Anthropic Messages API requests
- [ ] Forward to primary Anthropic provider (passthrough)
- [ ] Streaming SSE passthrough (non-streaming and streaming)
- [ ] Error detection on HTTP status codes
- [ ] Failover to second Anthropic provider (different API key)
- [ ] YAML config loading
- [ ] Basic structured logging
- [ ] `pi-failover start` CLI entry point
- [ ] Health check endpoint (`GET /health`)

### Phase 2 — Bedrock Backend
- [ ] Translate Anthropic Messages format → Bedrock invoke-model format
- [ ] AWS SigV4 signing
- [ ] Streaming translation (Bedrock SSE → Anthropic SSE)
- [ ] Bedrock-specific error detection (`ThrottlingException`, etc.)

### Phase 3 — Vertex AI Backend
- [ ] Translate → Vertex AI Anthropic endpoint format
- [ ] GCP service account auth
- [ ] Streaming translation

### Phase 4 — UX & Observability
- [ ] `pi-failover wrap -- <cmd>` wrapper mode
- [ ] Desktop notification on failover (macOS `osascript`)
- [ ] Status dashboard endpoint (`GET /status`) — current provider, error counts
- [ ] Prometheus metrics endpoint (optional)

### Phase 5 — Advanced
- [ ] Mid-stream failover (detect SSE error, replay from last `message_start`)
- [ ] Provider health probing (periodic pings)
- [ ] OpenAI-compatible backend (for LiteLLM / other providers)
- [ ] Configurable model mapping (e.g. Opus on Anthropic → Opus on Bedrock)

---

## Open Questions

1. **Mid-stream failover**: If Anthropic starts streaming a response and then
   errors at 60% completion, do we discard and retry the full request on the
   backup, or try to salvage the partial? Discarding is simpler and safer.

2. **Model mapping**: If the primary uses `claude-opus-4-6` but Bedrock only
   has `claude-sonnet-4-6`, should the proxy auto-downgrade? Or require explicit
   mapping in config?

3. **Token counting**: Should the proxy track token usage across providers for
   cost awareness? Nice-to-have but adds complexity.

4. **Scope**: Should this only target Claude Code, or be generic enough for any
   Anthropic API consumer? Starting Claude-Code-specific is simpler.

---

## File Structure (Proposed)

```
pi-failover/
├── src/
│   ├── index.ts              # CLI entry point
│   ├── server.ts             # Bun HTTP server + request handler
│   ├── config.ts             # YAML config loading + validation
│   ├── router.ts             # Failover logic + provider selection
│   ├── providers/
│   │   ├── base.ts           # Provider interface
│   │   ├── anthropic.ts      # Native Anthropic passthrough
│   │   ├── bedrock.ts        # AWS Bedrock translation
│   │   ├── vertex.ts         # Vertex AI translation
│   │   └── openai-compat.ts  # OpenAI-compatible translation
│   ├── detection.ts          # Error classification (failover vs fatal)
│   ├── stream.ts             # SSE stream handling + proxying
│   └── notify.ts             # Failover notifications
├── failover.yaml             # Default config (user copies + edits)
├── package.json
├── tsconfig.json
├── PLAN.md
└── README.md
```
