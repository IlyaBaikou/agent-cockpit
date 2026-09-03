type ObjectValue = Record<string, unknown>;
const object = (v: unknown): v is ObjectValue => Boolean(v) && typeof v === "object" && !Array.isArray(v);
export type CliOutput = { content: string; error: string; failed: boolean; structured: boolean; complete: boolean; sessionId?: string };
function errorText(v: unknown): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.slice(0, 20).map(errorText).filter(Boolean).join("\n");
  if (object(v)) return [v.message, v.error, v.errors, v.code].map((x) => typeof x === "string" ? x : Array.isArray(x) ? x.map(errorText).join("\n") : "").filter(Boolean).join("\n");
  return "";
}
// Accept a final result, including arrays/NDJSON used by some CLI releases.
// Never mistake init/tool/partial assistant events for a completed answer.
export function parseCliOutput(stdout: string): CliOutput {
  const text = stdout.trim();
  let values: unknown[] = [];
  try { const parsed: unknown = JSON.parse(text); values = Array.isArray(parsed) ? parsed : [parsed]; }
  catch {
    for (const line of text.split(/\r?\n/)) { try { values.push(JSON.parse(line)); } catch { /* Plain-text warning or legacy output. */ } }
  }
  const records = values.filter(object);
  const terminal = records.filter((v) => v.type === "result" || v.type === "error" || (!v.type && ("result" in v || "error" in v || "errors" in v || "is_error" in v))).at(-1);
  if (terminal) {
    const error = [errorText(terminal.error), errorText(terminal.errors)].filter(Boolean).join("\n");
    const failed = terminal.is_error === true || terminal.type === "error" || String(terminal.subtype ?? "").startsWith("error") || Boolean(error);
    return { content: typeof terminal.result === "string" ? terminal.result.trim() : "", error, failed, structured: true, complete: true,
      ...(typeof terminal.session_id === "string" ? { sessionId: terminal.session_id } : {}) };
  }
  const structured = values.length > 0 || /^[\[{]/.test(text);
  return { content: structured ? "" : text, error: "", failed: false, structured, complete: !structured };
}
