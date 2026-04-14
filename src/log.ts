// src/log.ts — Structured JSON logging
export type LogLevel = "debug" | "info" | "warn" | "error";

let minLevel: LogLevel = "info";

const LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export function setLogLevel(level: LogLevel) {
  minLevel = level;
}

export function log(
  level: LogLevel,
  message: string,
  data?: Record<string, unknown>
) {
  if (LEVELS[level] < LEVELS[minLevel]) return;

  const entry: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    msg: message,
    ...data,
  };

  console.error(JSON.stringify(entry));
}

export const debug = (msg: string, data?: Record<string, unknown>) =>
  log("debug", msg, data);
export const info = (msg: string, data?: Record<string, unknown>) =>
  log("info", msg, data);
export const warn = (msg: string, data?: Record<string, unknown>) =>
  log("warn", msg, data);
export const error = (msg: string, data?: Record<string, unknown>) =>
  log("error", msg, data);
