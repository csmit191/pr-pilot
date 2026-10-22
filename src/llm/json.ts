import type { z } from "zod";

export type ParseResult<T> = { ok: true; data: T } | { ok: false; error: string };

/**
 * Pulls the JSON object out of a model reply. We ask for bare JSON, but models sometimes wrap
 * it in ```json fences or add a sentence first, and rejecting those wastes a retry.
 */
export function extractJsonObject(text: string): string | null {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  const body = fenced?.[1] ?? trimmed;

  if (body.startsWith("{") && body.endsWith("}")) return body;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  return start !== -1 && end > start ? body.slice(start, end + 1) : null;
}

/** Parses and validates model output. The error string is safe to show back to the model. */
export function parseModelJson<T>(text: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>): ParseResult<T> {
  const candidate = extractJsonObject(text);
  if (candidate === null) return { ok: false, error: "No JSON object found in the reply." };

  let raw: unknown;
  try {
    raw = JSON.parse(candidate);
  } catch (err) {
    const detail = err instanceof Error ? err.message : "parse error";
    return { ok: false, error: `The reply is not valid JSON (${detail}).` };
  }

  const result = schema.safeParse(raw);
  if (!result.success) {
    const detail = result.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    return { ok: false, error: `The JSON does not match the schema (${detail}).` };
  }
  return { ok: true, data: result.data };
}
