type Level = "info" | "warn" | "error";

function log(level: Level, msg: string, fields: Record<string, unknown> = {}): void {
  // One JSON object per line: easy to grep locally and to ingest on a host later.
  // Rule: never pass secrets, tokens, or raw payloads in `fields`.
  console.log(JSON.stringify({ level, msg, time: new Date().toISOString(), ...fields }));
}

export const logger = {
  info: (msg: string, fields?: Record<string, unknown>) => log("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => log("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => log("error", msg, fields),
};
