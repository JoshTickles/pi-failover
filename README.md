# pi-failover

Automatic LLM model failover for [Pi coding agent](https://github.com/mariozechner/pi-coding-agent). When your model hits a rate limit, usage cap, or outage, pi-failover swaps to a backup model and retries — no manual intervention.

## Install

```bash
# Clone into Pi's extensions directory
git clone https://github.com/JoshTickles/pi-failover.git ~/.pi/agent/extensions/pi-failover
cd ~/.pi/agent/extensions/pi-failover && npm install
```

## Configure

Create `~/.config/pi-failover/failover.yaml`:

```yaml
failover:
  trigger_codes: [429, 402, 500, 504, 529]
  trigger_on_connection_error: true
  cooldown_seconds: 300
  max_retries: 3

notify:
  enabled: true
  desktop: true    # macOS notification on swap

# Models tried in order when the active model errors.
# Use the provider/model names from /model in Pi.
fallback_models:
  - provider: "amazon-bedrock"
    model: "global.anthropic.claude-opus-4-8"
  - provider: "amazon-bedrock"
    model: "us.anthropic.claude-fable-5"
  - provider: "amazon-bedrock"
    model: "global.anthropic.claude-sonnet-4-6"
```

That's it. Start Pi normally — the extension auto-loads and watches for errors.

## What it does

When you're running on `claude-bridge/claude-fable-5` and hit "You've hit your limit · resets 3pm":

1. Pi's built-in retry fires (3x exponential backoff) for errors it recognises
2. If Pi's retries exhaust, **or** the error is one Pi won't retry (like subscription caps), pi-failover kicks in
3. Swaps to `amazon-bedrock/global.anthropic.claude-opus-4-8` via `pi.setModel()`
4. Retries the prompt automatically via `pi.sendUserMessage()`
5. If bedrock also fails, walks to the next model in the chain
6. Desktop notification + status bar update so you know what happened

Works with autoresearch, `-p` mode, interactive — anything.

## Error detection

Errors are detected via `AssistantMessage.stopReason === "error"` on Pi's `message_end` event — structured Pi data, not screen scraping.

| Error | Pi retries? | pi-failover action |
|---|---|---|
| `429 rate_limit_error` | ✅ 3x backoff | Swaps after Pi gives up |
| `You've hit your limit · resets 3pm` | ❌ | **Swaps immediately** |
| `Claude rate limited (five_hour)` | ✅ 3x backoff | Swaps after Pi gives up |
| `529 overloaded_error` | ✅ 3x backoff | Swaps after Pi gives up |
| `Connection error` | ✅ 3x backoff | Swaps after Pi gives up |
| `401 authentication_error` | ❌ | ❌ No swap (config issue) |
| `400 invalid_request_error` | ❌ | ❌ No swap |

## Commands

| Command | Description |
|---|---|
| `/failover` | Show backend health + fallback chain status |

The `failover_status` tool is also available for the LLM to check health programmatically.

## Config reference

### `fallback_models` (recommended)

Ordered list of models to swap to when the active model errors. Uses providers Pi already has configured.

```yaml
fallback_models:
  - provider: "amazon-bedrock"        # AWS Bedrock (cross-region)
    model: "global.anthropic.claude-opus-4-8"
  - provider: "amazon-bedrock"        # Fable 5 on Bedrock
    model: "us.anthropic.claude-fable-5"
  - provider: "amazon-bedrock"        # Fast, high rate limits
    model: "global.anthropic.claude-sonnet-4-6"
```

### `backends` (optional, advanced)

Registers a `failover/*` provider that tries multiple Anthropic API keys in sequence within a single request. Only needed if you have multiple API keys for the same provider.

```yaml
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
```

Then select `failover/claude-sonnet-4-6` via `/model`.

### `failover`

```yaml
failover:
  trigger_codes: [429, 402, 500, 504, 529]  # HTTP codes that trigger failover
  trigger_on_connection_error: true           # Also on ECONNREFUSED, DNS, etc.
  cooldown_seconds: 300                       # Skip failed backend for 5 min
  max_retries: 3                              # Max backends to try per request
```

### `notify`

```yaml
notify:
  enabled: true
  desktop: true     # macOS desktop notification via osascript
```

## Config locations

Searched in order:
1. `$PI_FAILOVER_CONFIG` (env var override)
2. `./failover.yaml` (project-local)
3. `~/.config/pi-failover/failover.yaml` (global)
