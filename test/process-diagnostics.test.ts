import { expect, it } from "vitest";
import { ProcessError, runProcess } from "../src/process.js";
import { runAgentProcess } from "../src/agents/diagnostics.js";

it("captures stdout, stderr and the actual nonzero process status on this OS", async () => {
  const result = await runProcess(process.execPath, ["-e", "process.stdout.write('stdout detail'); process.stderr.write('stderr detail'); process.exitCode=7"], { timeoutMs: 10_000 });
  expect(result).toMatchObject({ stdout: "stdout detail", stderr: "stderr detail", exitCode: 7 });
});
it("converts an actual missing executable into an actionable spawn diagnostic", async () => {
  await expect(runAgentProcess("claude", "version", "agent-hub-definitely-missing-executable-026", ["--version"], { timeoutMs: 5000 }))
    .rejects.toMatchObject({ diagnostic: { code: "missing_cli", systemCode: "ENOENT", stage: "version", exitCode: null } });
});
it("retains output when an actual child process times out", async () => {
  const result = await runProcess(process.execPath, ["-e", "process.stdout.write('before timeout'); process.stderr.write('provider still waiting'); setInterval(()=>{},1000)"], { timeoutMs: 2000 })
    .then(() => { throw new Error("Expected timeout"); }, (error: unknown) => error as ProcessError);
  expect(result).toBeInstanceOf(ProcessError); expect(result.code).toBe("TIMEOUT");
  expect(result.stderr).toBe("provider still waiting"); expect(result.stdout).toBe("before timeout");
}, 10_000);
