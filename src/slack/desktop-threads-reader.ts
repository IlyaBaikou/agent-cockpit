import { chmod, mkdir, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { runProcess } from "../process.js";

export type SlackThreadMessage = {
  rootId: string;
  id: string;
  url: string;
  author: string;
  text: string;
};

export type SlackThreadsScanner = { scan(): Promise<SlackThreadMessage[]> };

export class SlackAccessibilityThreadsScanner implements SlackThreadsScanner {
  readonly #channelId: string;
  readonly #sourceFile: string;
  readonly #binaryFile: string;

  constructor(options: { channelId: string; sourceFile?: string; binaryFile?: string }) {
    this.#channelId = options.channelId;
    this.#sourceFile = resolve(options.sourceFile ?? resolve(process.cwd(), "native/slack_ax_threads_reader.swift"));
    this.#binaryFile = resolve(options.binaryFile ?? resolve(process.cwd(), ".agent-hub-local/bin/slack-ax-threads-reader"));
  }

  async prepare(): Promise<void> {
    if (process.platform !== "darwin") throw new Error("Slack thread reading currently requires macOS");
    const source = await stat(this.#sourceFile);
    const binary = await stat(this.#binaryFile).catch(() => undefined);
    if (binary && binary.mtimeMs >= source.mtimeMs) return;
    await mkdir(dirname(this.#binaryFile), { recursive: true });
    const compiled = await runProcess("/usr/bin/swiftc", [this.#sourceFile, "-o", this.#binaryFile], { timeoutMs: 60_000 });
    if (compiled.exitCode !== 0) throw new Error(compiled.stderr.trim() || `swiftc exited with ${compiled.exitCode}`);
    await chmod(this.#binaryFile, 0o700);
  }

  async scan(): Promise<SlackThreadMessage[]> {
    await this.prepare();
    const result = await runProcess(this.#binaryFile, [this.#channelId], { timeoutMs: 10_000 });
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `Slack threads reader exited with ${result.exitCode}`);
    const parsed = JSON.parse(result.stdout) as { messages?: SlackThreadMessage[] };
    return parsed.messages ?? [];
  }
}
