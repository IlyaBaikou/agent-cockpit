import { homedir, release } from "node:os";
import { stat } from "node:fs/promises";
import { ProcessError, runProcess, type ProcessResult } from "../process.js";

export type Provider = "claude" | "cursor" | "codex";
export type Stage = "workspace" | "version" | "auth" | "run" | "response";
const reasons = {
  missing_cli: ["Не найден файл запуска CLI.", "Проверьте установку и укажите существующий файл в поле «Путь к исполняемому файлу CLI». После установки перезапустите хаб."],
  missing_workspace: ["Рабочая папка недоступна.", "Выберите существующую папку проекта и проверьте доступ к ней."],
  permission: ["Нет разрешения на запуск или доступ к файлу.", "Проверьте права на файл и ограничения безопасности компьютера. Не отключайте защиту целиком."],
  auth: ["CLI не смог подтвердить вход в аккаунт.", "Войдите в аккаунт через выбранный CLI и повторите «Проверить подключение»."],
  rate_limit: ["Провайдер ограничил частоту запросов.", "Дождитесь сброса ограничения и вызовите агента заново."],
  quota: ["Провайдер сообщил об исчерпанном лимите или проблеме оплаты.", "Проверьте доступный лимит аккаунта у провайдера."],
  model: ["Запрошенная модель недоступна.", "Проверьте модель и доступ к ней в настройках CLI."],
  network: ["CLI сообщил об ошибке соединения.", "Проверьте сеть, прокси и доступ к сервису провайдера с этого компьютера."],
  trust: ["CLI ожидает подтверждения доверия к рабочей папке.", "Откройте выбранный CLI в этой папке и подтвердите доверие, только если доверяете её содержимому."],
  unsupported_cli: ["CLI не поддерживает параметры запуска хаба.", "Проверьте версию CLI и что выбран CLI агента, а не редактор. Передайте владельцу хаба подробности ошибки."],
  shell_missing: ["CLI не нашёл необходимую командную оболочку.", "На Windows проверьте установку Git for Windows / Git Bash и путь к нему в настройках CLI."],
  timeout: ["CLI не завершил запрос за отведённое время.", "Проверьте доступность провайдера и уменьшите запрос. Перед повтором режима изменений проверьте рабочую копию."],
  cancelled: ["Выполнение остановлено.", "Проверьте состояние треда и при необходимости вызовите агента вручную."],
  empty_response: ["CLI завершился без текста ответа.", "Причина не установлена. Откройте подробности: там сохранены код завершения и диагностический вывод CLI."],
  invalid_response: ["CLI вернул ответ в неподдерживаемом формате.", "Передайте владельцу хаба подробности с версией CLI. Повторная установка без проверки не требуется."],
  cli_failed: ["CLI не смог выполнить запрос.", "Откройте подробности ошибки. По одному коду завершения определить причину нельзя."],
} as const;
export type DiagnosticCode = keyof typeof reasons;
export type AgentDiagnostic = {
  version: 1; provider: Provider; stage: Stage; code: DiagnosticCode; summary: string; hint: string;
  at: number; exitCode: number | null; systemCode: string; signal: string;
  binary: string; platform: string; osVersion: string; arch: string; cliVersion: string; appVersion: string;
  stdout: string; stderr: string; outputTruncated: boolean;
};
const labels = { claude: "Claude Code", cursor: "Cursor CLI", codex: "Codex" };
const versions = new Map<string, string>();

// Defense in depth, not a guarantee that arbitrary program output contains no
// private data. Detailed reports are restricted to the owner / hub operator.
export function redact(value: string, sensitive: string[] = []): string {
  let text = value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
  for (const secret of sensitive.filter((s) => s.length > 3).sort((a, b) => b.length - a.length)) {
    text = text.split(secret).join("[REDACTED]").split(JSON.stringify(secret).slice(1, -1)).join("[REDACTED]");
  }
  return text
    .replace(/-----BEGIN [\w ]*PRIVATE KEY-----[\s\S]*?(?:-----END [\w ]*PRIVATE KEY-----|$)/g, "[PRIVATE KEY REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:sk-|xox[baprs]-|gh[pousr]_|github_pat_)[A-Za-z0-9_-]+/g, "[REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[JWT REDACTED]")
    .replace(/(\b[\w-]{0,80}(?:token|password|secret|api[_-]?key|authorization|cookie)[\w-]{0,80}["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;&}]+)/gi, "$1[REDACTED]")
    .replace(/(--(?:api-key|token|password|secret)\s+)(?:"[^"]*"|'[^']*'|\S+)/gi, "$1[REDACTED]")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[REDACTED]@")
    .replace(/([?&](?:code|key|signature|sig|credential)=)[^\s&#]+/gi, "$1[REDACTED]")
    .replace(/\bAH2:[A-Za-z0-9_=-]+/g, "[INVITE REDACTED]")
    .split(homedir()).join("[home]")
    .replace(/[A-Z]:\\{1,2}Users\\{1,2}[^\\\s"']+/gi, "[home]")
    .replace(/\/(?:Users|home)\/[^/\s"']+/g, "[home]");
}
function bounded(value: string, max: number, sensitive: string[]): string {
  const clean = redact(value, sensitive);
  return clean.length > max ? clean.slice(0, max) + "\n[вывод сокращён]" : clean;
}
export function diagnosticMessage(d: AgentDiagnostic): string { return `${labels[d.provider]}: ${d.summary} ${d.hint}`; }
export class AgentExecutionError extends Error {
  constructor(readonly diagnostic: AgentDiagnostic) { super(diagnosticMessage(diagnostic)); }
}
export function classifyFailure(text: string, fallback: DiagnosticCode): DiagnosticCode {
  if (/insufficient[_ ]quota|credit balance|out of credits|billing|usage limit|quota exceeded/i.test(text)) return "quota";
  if (/rate.?limit|too many requests|\b429\b/i.test(text)) return "rate_limit";
  if (/not (?:logged in|authenticated)|unauthori[sz]ed|invalid (?:api.?key|token)|authentication (?:failed|required)|login required|\b401\b/i.test(text)) return "auth";
  if (/workspace.{0,30}(?:not trusted|untrusted)|trust (?:this|the) (?:workspace|directory|folder)|--trust/i.test(text)) return "trust";
  if (/requires git.?bash|git.?bash.{0,60}(?:not found|not installed|could not find)|could not find.{0,30}git.?bash/i.test(text)) return "shell_missing";
  if (/unknown (?:option|argument)|unrecognized (?:option|argument)|unsupported (?:option|flag)|invalid value.{0,80}--mode/i.test(text)) return "unsupported_cli";
  if (/model.{0,60}(?:not found|unavailable|does not exist|not available|not supported)|model_not_found/i.test(text)) return "model";
  if (/ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|fetch failed|network error|certificate.{0,30}(?:failed|invalid|expired)/i.test(text)) return "network";
  if (/EACCES|EPERM|permission denied|access denied/i.test(text)) return "permission";
  return fallback;
}
type FailureInput = {
  provider: Provider; stage: Stage; binary?: string; code?: DiagnosticCode; result?: ProcessResult;
  error?: unknown; detail?: string; sensitive?: string[];
};
export function agentFailure(input: FailureInput): AgentExecutionError {
  const processError = input.error instanceof ProcessError ? input.error : undefined;
  const systemCode = processError?.code ?? (input.error as NodeJS.ErrnoException | undefined)?.code ?? "";
  const stdout = input.result?.stdout ?? processError?.stdout ?? "";
  const stderr = input.result?.stderr ?? processError?.stderr ?? "";
  const detail = input.detail ?? (input.error instanceof Error ? input.error.message : "");
  const fallback = systemCode === "ENOENT" ? "missing_cli" : systemCode === "TIMEOUT" ? "timeout" : systemCode === "ABORTED" ? "cancelled" : input.code ?? "cli_failed";
  let evidence = `${detail}\n${stderr}\n${stdout}`;
  for (const prompt of input.sensitive ?? []) if (prompt) evidence = evidence.split(prompt).join("").split(JSON.stringify(prompt).slice(1, -1)).join("");
  const code = ["ENOENT", "TIMEOUT", "ABORTED"].includes(systemCode) ? fallback : classifyFailure(evidence, fallback);
  const sensitive = [...(input.sensitive ?? []), ...Object.entries(process.env).filter(([k]) => /token|secret|password|api.?key|credential/i.test(k)).map(([, v]) => v ?? "")];
  const d: AgentDiagnostic = {
    version: 1, provider: input.provider, stage: input.stage, code, summary: reasons[code][0], hint: reasons[code][1], at: Date.now(),
    exitCode: input.result?.exitCode ?? null, systemCode: bounded(systemCode, 80, sensitive), signal: input.result?.signal ?? "",
    binary: bounded(input.binary ?? "", 500, sensitive), platform: process.platform, osVersion: release(), arch: process.arch,
    cliVersion: bounded(versions.get(input.binary ?? "") ?? "не определена", 160, sensitive), appVersion: "не определена",
    stdout: bounded(stdout, 4000, sensitive), stderr: bounded([stderr, detail].filter(Boolean).join("\n"), 4000, sensitive),
    outputTruncated: stdout.length > 4000 || stderr.length + detail.length > 4000,
  };
  return new AgentExecutionError(d);
}
export async function runAgentProcess(provider: Provider, stage: Stage, binary: string, args: string[], options: Parameters<typeof runProcess>[2] = {}, sensitive: string[] = []): Promise<ProcessResult> {
  try {
    const result = await runProcess(binary, args, options);
    if (stage === "version" && result.exitCode === 0 && result.stdout.trim()) versions.set(binary, redact(result.stdout.trim()).slice(0, 160));
    return result;
  } catch (error) { throw agentFailure({ provider, stage, binary, error, sensitive }); }
}
export async function checkWorkspace(provider: Provider, directory: string): Promise<void> {
  try { if (!(await stat(directory)).isDirectory()) throw new Error("Not a directory"); }
  catch (error) { throw agentFailure({ provider, stage: "workspace", code: "missing_workspace", detail: error instanceof Error ? error.message : "" }); }
}

// The server accepts only known fields and re-applies redaction before storage.
export function acceptDiagnostic(value: unknown, provider: Provider, at: number): AgentDiagnostic | undefined {
  if (!value || typeof value !== "object") return;
  const d = value as Partial<AgentDiagnostic>;
  if (d.version !== 1 || !d.code || !Object.hasOwn(reasons, d.code) || !["workspace", "version", "auth", "run", "response"].includes(d.stage ?? "")) return;
  const clean = (key: keyof AgentDiagnostic, max: number) => bounded(typeof d[key] === "string" ? d[key] as string : "", max, []);
  return {
    version: 1, provider, at, code: d.code, stage: d.stage!, summary: reasons[d.code][0], hint: reasons[d.code][1],
    exitCode: typeof d.exitCode === "number" && Number.isSafeInteger(d.exitCode) ? d.exitCode : null,
    systemCode: clean("systemCode", 80), signal: clean("signal", 40), binary: clean("binary", 500), platform: clean("platform", 40),
    osVersion: clean("osVersion", 80), arch: clean("arch", 40), cliVersion: clean("cliVersion", 160), appVersion: clean("appVersion", 80),
    stdout: clean("stdout", 4000), stderr: clean("stderr", 4000), outputTruncated: d.outputTruncated === true,
  };
}
