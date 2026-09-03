import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentExecutionError, acceptDiagnostic, agentFailure, classifyFailure, redact } from "../src/agents/diagnostics.js";
import { parseCliOutput } from "../src/agents/cli-output.js";
import { ClaudeAdapter, resolveClaudeBinary } from "../src/agents/claude.js";
import { CursorAdapter } from "../src/agents/cursor.js";
import { ProcessError, runProcess } from "../src/process.js";

vi.mock("../src/process.js", async (original) => ({ ...await original<typeof import("../src/process.js")>(), runProcess: vi.fn() }));
const run = vi.mocked(runProcess);
const roots: string[] = [];
afterEach(async () => { vi.resetAllMocks(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const result = (stdout = "", stderr = "", exitCode = 0) => ({ stdout, stderr, exitCode });
const request = { repositoryPath: tmpdir(), mode: "read" as const, prompt: "A private prompt that must not appear in reports" };
async function getFailure(promise: Promise<unknown>): Promise<AgentExecutionError> {
  return promise.then(() => { throw new Error("Expected failure"); }, (error: unknown) => { expect(error).toBeInstanceOf(AgentExecutionError); return error as AgentExecutionError; });
}

describe("provider output parsing", () => {
  it("accepts object, array and NDJSON final results, but never partial events", () => {
    const final = { type: "result", result: "Answer\nROUTE: done", session_id: "session-1" };
    for (const value of [JSON.stringify(final), JSON.stringify([{ type: "system" }, final]), `${JSON.stringify({ type: "assistant", message: "partial" })}\n${JSON.stringify(final)}`]) {
      expect(parseCliOutput(value)).toMatchObject({ content: final.result, failed: false, sessionId: "session-1", complete: true });
    }
    expect(parseCliOutput('{"type":"assistant","message":"partial"}')).toMatchObject({ content: "", complete: false });
    expect(parseCliOutput('{"usage":{"tokens":10}}')).toMatchObject({ content: "", complete: false });
    expect(parseCliOutput('a legacy text answer')).toMatchObject({ content: "a legacy text answer", complete: true });
  });
  it("handles empty, malformed and terminal error responses without type errors", () => {
    expect(parseCliOutput('{"type":"result","is_error":true,"errors":["quota exceeded"],"result":null}')).toMatchObject({ failed: true, error: "quota exceeded", content: "" });
    expect(parseCliOutput('{"result":{"unexpected":true}}').content).toBe("");
    expect(parseCliOutput('{"result":').complete).toBe(false);
    expect(parseCliOutput('')).toMatchObject({ complete: true, content: "" });
  });
});

describe("actionable and redacted errors", () => {
  it.each([
    ["unknown option --bad", "unsupported_cli"], ["Authentication required: not logged in", "auth"],
    ["rate_limit_error 429", "rate_limit"], ["insufficient_quota", "quota"], ["credit balance too low", "quota"],
    ["model_not_found", "model"], ["fetch failed ECONNRESET", "network"], ["Please trust this workspace", "trust"], ["EACCES permission denied", "permission"],
  ])("classifies %s", (text, code) => { expect(classifyFailure(text, "cli_failed")).toBe(code); });
  it("does not invent a reason for code 1 with no diagnostics", () => {
    const failure = agentFailure({ provider: "cursor", stage: "response", result: result("", "", 1) });
    expect(failure.message).toContain("По одному коду");
    expect(failure.diagnostic).toMatchObject({ code: "cli_failed", exitCode: 1, stdout: "", stderr: "" });
  });
  it("retains stderr even when Claude exits 0 with an empty result", async () => {
    run.mockResolvedValue(result('{"type":"result","result":""}', "ECONNRESET from provider"));
    const error = await getFailure(new ClaudeAdapter({ binary: "fake-claude" }).run(request));
    expect(error).toBeInstanceOf(AgentExecutionError);
    expect(error.diagnostic).toMatchObject({ code: "network", stage: "response", exitCode: 0 });
    expect(error.diagnostic.stderr).toContain("ECONNRESET");
  });
  it("retains Cursor plain stdout on failure, without exposing it in public text", async () => {
    run.mockResolvedValue(result("CLI diagnostic that used to be discarded", "", 1));
    const error = await getFailure(new CursorAdapter({ binary: "fake-cursor" }).run(request));
    expect(error.diagnostic.stdout).toContain("used to be discarded");
    expect(error.message).not.toContain("discarded");
  });
  it("reads nested provider errors without pretending an error is an answer", async () => {
    run.mockResolvedValue(result(JSON.stringify({ type: "result", subtype: "error_during_execution", errors: [{ message: "credit balance too low" }] })));
    await expect(new ClaudeAdapter({ binary: "fake-claude" }).run(request)).rejects.toMatchObject({ diagnostic: { code: "quota" } });
  });
  it("keeps prompt, credentials, home names and environment secrets out of reports", async () => {
    vi.stubEnv("TEST_DIAGNOSTIC_SECRET", "private-environment-value");
    run.mockResolvedValue(result(JSON.stringify({ type: "result", result: "", errors: [request.prompt, "private-environment-value", "token=abc-private", "Bearer bearer-value", "sk-api-value", "C:\\Users\\Anar\\folder"] })));
    const error = await getFailure(new ClaudeAdapter({ binary: "fake-claude" }).run(request));
    const report = JSON.stringify(error.diagnostic);
    for (const secret of [request.prompt, "private-environment-value", "abc-private", "bearer-value", "sk-api-value", "Anar"]) expect(report).not.toContain(secret);
    expect(report).toContain("REDACTED");
    expect(redact('api_key="private key with spaces" password=privatePass https://name:privatePass@host/path?code=privateCode')).not.toMatch(/private key|privatePass|privateCode/);
  });
  it("bounds reports and validates server input fields", () => {
    const d = agentFailure({ provider: "cursor", stage: "response", result: result("x".repeat(20_000), "y".repeat(10_000), 1) }).diagnostic;
    expect(d.outputTruncated).toBe(true); expect(d.stdout.length).toBeLessThan(4100); expect(d.stderr.length).toBeLessThan(4100);
    const accepted = acceptDiagnostic({ ...d, prompt: "do not store", environment: { token: "do not store" }, provider: "claude", summary: "untrusted public text", at: -1 }, "cursor", 123);
    expect(accepted).toMatchObject({ provider: "cursor", at: 123 }); expect(accepted!.summary).not.toContain("untrusted");
    expect(JSON.stringify(accepted)).not.toContain("do not store");
    expect(acceptDiagnostic({ version: 1, code: "__proto__", stage: "run" }, "claude", 0)).toBeUndefined();
  });
  it("explains missing executables and timeout with captured stderr", async () => {
    run.mockRejectedValueOnce(new ProcessError("spawn missing ENOENT", "ENOENT"));
    await expect(new ClaudeAdapter({ binary: "missing" }).healthCheck()).rejects.toMatchObject({ diagnostic: { code: "missing_cli", stage: "version", exitCode: null } });
    run.mockRejectedValueOnce(new ProcessError("timed out", "TIMEOUT", "", "still waiting"));
    await expect(new CursorAdapter({ binary: "fake" }).run(request)).rejects.toMatchObject({ diagnostic: { code: "timeout", stderr: expect.stringContaining("still waiting") } });
  });
  it("does not report Claude as authenticated when auth status is empty or malformed", async () => {
    run.mockResolvedValueOnce(result("2.1.258")).mockResolvedValueOnce(result(""));
    await expect(new ClaudeAdapter({ binary: "fake" }).healthCheck()).rejects.toMatchObject({ diagnostic: { code: "invalid_response", stage: "auth", cliVersion: "2.1.258" } });
    run.mockResolvedValueOnce(result("2.1.258")).mockResolvedValueOnce(result('{"loggedIn":true,"authMethod":"oauth"}'));
    await expect(new ClaudeAdapter({ binary: "fake" }).healthCheck()).resolves.toContain("oauth");
  });
  it("checks workspace separately and does not launch CLI for a missing directory", async () => {
    await expect(new ClaudeAdapter({ binary: "fake" }).run({ ...request, repositoryPath: join(tmpdir(), "missing-workspace-" + Date.now()) })).rejects.toMatchObject({ diagnostic: { code: "missing_workspace", stage: "workspace" } });
    expect(run).not.toHaveBeenCalled();
  });
  it("preserves write flags but omits the unsupported Cursor --mode=agent", async () => {
    run.mockResolvedValue(result('{"result":"Done"}'));
    await new CursorAdapter({ binary: "fake" }).run({ ...request, mode: "write" });
    expect(run.mock.calls[0]![1]).toContain("--force"); expect(run.mock.calls[0]![1]).not.toContain("--mode=agent");
  });
});

describe("Claude discovery", () => {
  it("finds Windows Desktop versions numerically and skips incomplete updates", async () => {
    const root = await mkdtemp(join(tmpdir(), "claude-discovery-")); roots.push(root);
    const base = join(root, "roaming", "Claude", "claude-code");
    for (const v of ["2.1.9", "2.1.258", "2.1.259", "current"]) await mkdir(join(base, v), { recursive: true });
    for (const v of ["2.1.9", "2.1.258"]) await writeFile(join(base, v, "claude.exe"), "fixture");
    const env = { APPDATA: join(root, "roaming") };
    expect(await resolveClaudeBinary(undefined, env, "win32", root)).toBe(join(base, "2.1.258", "claude.exe"));
    expect(await resolveClaudeBinary("explicit-path", env, "win32", root)).toBe("explicit-path");
    expect(await resolveClaudeBinary(undefined, { ...env, CLAUDE_BIN: "environment-path" }, "win32", root)).toBe("environment-path");
  });
  it("supports the native Windows installation when Desktop is absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "claude-native-")); roots.push(root);
    const binary = join(root, ".local", "bin", "claude.exe"); await mkdir(join(root, ".local", "bin"), { recursive: true }); await writeFile(binary, "fixture");
    expect(await resolveClaudeBinary(undefined, {}, "win32", root)).toBe(binary);
  });
});
