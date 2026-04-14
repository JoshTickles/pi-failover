// src/config.ts — YAML config loading + validation
import { parse } from "yaml";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

export interface ProviderConfig {
  name: string;
  enabled: boolean;
  type: "anthropic" | "bedrock" | "vertex" | "openai-compat";
  base_url?: string;
  api_key_env?: string;
  api_key?: string; // resolved at runtime
  region?: string;
  model?: string;
  model_id?: string;
  project_id?: string;
}

export interface FailoverConfig {
  trigger_codes: number[];
  trigger_on_connection_error: boolean;
  trigger_on_stream_error: boolean;
  cooldown_seconds: number;
  max_retries: number;
  strategy: "sequential" | "round-robin";
}

export interface NotifyConfig {
  enabled: boolean;
  webhook_url?: string;
  desktop?: boolean;
}

export interface ListenConfig {
  host: string;
  port: number;
}

export interface Config {
  listen: ListenConfig;
  failover: FailoverConfig;
  notify: NotifyConfig;
  providers: ProviderConfig[];
}

const DEFAULT_CONFIG: Config = {
  listen: { host: "127.0.0.1", port: 8099 },
  failover: {
    trigger_codes: [429, 402, 500, 504, 529],
    trigger_on_connection_error: true,
    trigger_on_stream_error: true,
    cooldown_seconds: 300,
    max_retries: 3,
    strategy: "sequential",
  },
  notify: { enabled: false },
  providers: [],
};

/** Search order: explicit path → cwd → ~/.config/pi-failover */
export function loadConfig(explicitPath?: string): Config {
  const candidates = [
    explicitPath,
    join(process.cwd(), "failover.yaml"),
    join(process.cwd(), "failover.yml"),
    join(
      process.env.HOME || "~",
      ".config",
      "pi-failover",
      "failover.yaml"
    ),
  ].filter(Boolean) as string[];

  let raw: string | undefined;
  let loadedFrom: string | undefined;

  for (const p of candidates) {
    if (existsSync(p)) {
      raw = readFileSync(p, "utf-8");
      loadedFrom = p;
      break;
    }
  }

  if (!raw) {
    console.error(
      `[config] No failover.yaml found. Searched:\n${candidates.map((c) => `  - ${c}`).join("\n")}`
    );
    process.exit(1);
  }

  console.error(`[config] Loaded from ${loadedFrom}`);
  const parsed = parse(raw) as Partial<Config>;
  const config = mergeDeep(DEFAULT_CONFIG, parsed) as Config;

  // Resolve API keys from env vars
  for (const p of config.providers) {
    if (p.api_key_env && !p.api_key) {
      p.api_key = process.env[p.api_key_env];
      if (!p.api_key) {
        console.error(
          `[config] Warning: provider "${p.name}" references env ${p.api_key_env} but it's not set`
        );
      }
    }
  }

  const enabled = config.providers.filter((p) => p.enabled);
  if (enabled.length === 0) {
    console.error("[config] No enabled providers. Check failover.yaml");
    process.exit(1);
  }

  console.error(
    `[config] ${enabled.length} provider(s) enabled: ${enabled.map((p) => p.name).join(", ")}`
  );
  return config;
}

function mergeDeep(target: any, source: any): any {
  if (!source) return target;
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (
      source[key] &&
      typeof source[key] === "object" &&
      !Array.isArray(source[key])
    ) {
      result[key] = mergeDeep(target[key] || {}, source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}
