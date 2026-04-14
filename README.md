# pi-failover

Automatic LLM model failover extension for [Pi coding agent](https://github.com/mariozechner/pi-coding-agent).

When your primary API key hits a rate limit, billing cap, or service outage — pi-failover transparently retries with the next backend. No dropped sessions.

## How it works

1. You configure ordered **backends** in `failover.yaml` (different API keys, endpoints, etc.)
2. The extension registers a `failover` provider with `streamSimple` that wraps the Anthropic API
3. On retriable errors (429, 402, 500, 504, 529), it automatically tries the next backend
4. Failed backends enter a cooldown period, then recover
5. You get a desktop notification + status bar update on failover

## Install

```bash
# Option 1: symlink for global use
ln -s /path/to/pi-failover ~/.pi/agent/extensions/pi-failover

# Option 2: one-off test
pi -e /path/to/pi-failover
```

Install dependencies:
```bash
cd /path/to/pi-failover && npm install
```

## Configure

Create `~/.config/pi-failover/failover.yaml` (or `./failover.yaml` in your project):

```yaml
failover:
  trigger_codes: [429, 402, 500, 504, 529]
  trigger_on_connection_error: true
  cooldown_seconds: 300
  max_retries: 3

notify:
  enabled: true
  desktop: true

backends:
  - name: "anthropic-primary"
    enabled: true
    type: "anthropic"
    api_key_env: "ANTHROPIC_API_KEY"
    base_url: "https://api.anthropic.com"

  - name: "anthropic-backup"
    enabled: true
    type: "anthropic"
    api_key_env: "ANTHROPIC_BACKUP_API_KEY"
    base_url: "https://api.anthropic.com"
```

## Use

1. Start Pi normally
2. Use `/model` and select a `failover/*` model (e.g. `failover/claude-sonnet-4-6`)
3. Use `/failover` to check backend health anytime

## Error classification

| HTTP | Error | Failover? |
|------|-------|-----------|
| 429 | Rate limit / usage cap | ✅ Yes |
| 402 | Billing exhausted | ✅ Yes |
| 500 | Internal server error | ✅ Yes |
| 504 | Timeout | ✅ Yes |
| 529 | Overloaded | ✅ Yes |
| 401 | Auth error | ❌ No (config issue) |
| 400 | Bad request | ❌ No |
| 403 | Permission denied | ❌ No |
| Connection errors | ECONNREFUSED, DNS, etc. | ✅ Configurable |

## Architecture

```
Pi Agent
  │
  ├─► /model → failover/claude-sonnet-4-6
  │
  └─► streamSimple (failover-aware)
        │
        ├─► Backend 1: api.anthropic.com (key A) ──► 429 rate limited
        │     ↓ failover
        ├─► Backend 2: api.anthropic.com (key B) ──► 200 OK ✅
        │
        └─► (Backend 1 enters 5min cooldown, auto-recovers)
```

The extension uses Pi's native `registerProvider` + `streamSimple` API — no proxy process, no external dependencies beyond the Anthropic SDK.
