#!/usr/bin/env bun
// src/index.ts — CLI entry point
import { loadConfig } from "./config";
import { createServer } from "./server";
import { setLogLevel } from "./log";
import * as log from "./log";

const args = process.argv.slice(2);
const command = args[0] || "start";

function printUsage() {
  console.log(`
pi-failover — Automatic LLM model failover proxy

Usage:
  pi-failover start [--config path] [--debug]    Start the proxy server
  pi-failover status                              Show provider status
  pi-failover help                                Show this help

Environment:
  Set ANTHROPIC_BASE_URL=http://127.0.0.1:<port> to route Claude Code through the proxy.

Config:
  Searches for failover.yaml in: ./failover.yaml → ~/.config/pi-failover/failover.yaml
  Override with --config <path>
`);
}

async function main() {
  switch (command) {
    case "start": {
      // Parse flags
      let configPath: string | undefined;
      for (let i = 1; i < args.length; i++) {
        if (args[i] === "--config" && args[i + 1]) {
          configPath = args[++i];
        } else if (args[i] === "--debug") {
          setLogLevel("debug");
        }
      }

      const config = loadConfig(configPath);
      const { start } = createServer(config);

      log.info("Starting pi-failover proxy", {
        version: "0.1.0",
        host: config.listen.host,
        port: config.listen.port,
        providers: config.providers
          .filter((p) => p.enabled)
          .map((p) => p.name),
      });

      start();
      break;
    }

    case "status": {
      // Quick status check against a running proxy
      const port = process.env.PI_FAILOVER_PORT || "8099";
      const host = process.env.PI_FAILOVER_HOST || "127.0.0.1";
      try {
        const resp = await fetch(`http://${host}:${port}/status`);
        const data = await resp.json();
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        console.error(
          `Could not reach pi-failover at ${host}:${port}. Is it running?`
        );
        process.exit(1);
      }
      break;
    }

    case "help":
    case "--help":
    case "-h":
      printUsage();
      break;

    default:
      console.error(`Unknown command: ${command}`);
      printUsage();
      process.exit(1);
  }
}

main().catch((err) => {
  log.error("Fatal error", { error: String(err) });
  process.exit(1);
});
