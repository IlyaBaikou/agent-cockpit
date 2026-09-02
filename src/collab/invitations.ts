import { hubUrl } from "./client.js";
import { field, requireValue } from "./model.js";

export function encodeInvitation(url: string, code: string, group = false): string {
  return `AH2:${Buffer.from(JSON.stringify({ url: hubUrl(url), code, ...(group ? { group: true } : {}) })).toString("base64url")}`;
}

export function decodeInvitation(value: string): { url: string; code: string; group: boolean } {
  requireValue(typeof value === "string" && value.length <= 4096 && value.startsWith("AH2:"), "Вставьте приглашение AH2 целиком");
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(Buffer.from(value.slice(4), "base64url").toString("utf8")); }
  catch { throw new Error("Приглашение повреждено. Скопируйте код AH2 целиком"); }
  requireValue(parsed && typeof parsed === "object" && !Array.isArray(parsed), "Неверное приглашение");
  return { url: hubUrl(field(parsed.url, "Адрес хаба", 2048)), code: field(parsed.code, "Код приглашения", 200), group: parsed.group === true };
}
