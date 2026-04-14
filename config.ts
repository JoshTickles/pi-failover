// config.ts — YAML config loading for failover providers
import { parse } from "yaml";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

export interface BackendConfig {
  name: string;
  enabled: boolean;
  type: "anthropic";
  base_url?: string;
  api_key_env?: string;
  api_key?: string;
}

export interface FailoverRules {
  trigger_codes: number[];
  trigger_on_connection_error: boolean;
  cooldown_seconds: number;
  max_retries: number;
}

export interface NotifyConfig {
  enabled: boolean;
  desktop?: boolean;
}

export interface FailoverConfig {
  failover: FailoverRules;
  notify: NotifyConfig;
  backends: BackendConfig[];
}

const DEFAULT_CONFIG: FailoverConfig = {
  failover: {
    trigger_codes: [429, 402, 500, 504, 529],
    trigger_on_connection_error: true,
    cooldown_seconds: 300,
    max_retries: 3,
  },
  notify: { enabled: true, desktop: true },
  backends: [],
};

export function loadConfig(): FailoverConfig {
  const candidates = [
    join(process.cwd(), "failover.yaml"),
    join(process.cwd(), "failover.yml"),
    join(process.env.HOME || "~", ".config", "pi-failover", "failover.yaml"),
  ];

  for (const p of candidates) {
    if (existsSync(p)) {
      const raw = readFileSync(p, "utf-8");
      const parsed = parse(raw) as Partial<FailoverConfig>;
      const config = mergeDeep(DEFAULT_CONFIG, parsed) as FailoverConfig;
      resolveKeys(config);
      return config;
    }
  }

  // No config found — return empty (extension will warn)
  return DEFAULT_CONFIG;
}

function resolveKeys(config: FailoverConfig) {
  for (const b of config.backends) {
    if (b.api_key_env && !b.api_key) {
      b.api_key = process.env[b.api_key_env];
    }
  }
}

function mergeDeep(target: any, source: any): any {
  if (!source) return target;
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === "object" && !Array.isArray(source[key])) {
      result[key] = mergeDeep(target[key] || {}, source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}
