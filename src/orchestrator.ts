import { randomUUID } from "node:crypto";
import type { AgentAdapter } from "./agents/adapter.js";
import type { AgentProfiles } from "./config.js";
import { HubStore } from "./store.js";
import type { AgentId, DiscussionMessage } from "./types.js";

export type DiscussionOptions = {
  discussionId?: string;
  repositoryAlias: string;
  repositoryPath: string;
  prompt: string;
  rounds: number;
  onMessage?: (message: DiscussionMessage) => Promise<void> | void;
};

export class Orchestrator {
  readonly #agents: Record<AgentId, AgentAdapter>;
  readonly #profiles: AgentProfiles;
  readonly #store: HubStore;

  constructor(options: {
    agents: Record<AgentId, AgentAdapter>;
    profiles: AgentProfiles;
    store: HubStore;
  }) {
    this.#agents = options.agents;
    this.#profiles = options.profiles;
    this.#store = options.store;
  }

  async ask(options: {
    discussionId?: string;
    agent: AgentId;
    repositoryAlias: string;
    repositoryPath: string;
    prompt: string;
    onMessage?: (message: DiscussionMessage) => Promise<void> | void;
  }): Promise<DiscussionMessage> {
    const id = options.discussionId ?? randomUUID();
    this.#store.createDiscussion(id, options.repositoryAlias, options.prompt);
    try {
      const result = await this.#agents[options.agent].run({
        repositoryPath: options.repositoryPath,
        prompt: options.prompt,
      });
      const message: DiscussionMessage = {
        agent: options.agent,
        label: this.#profiles[options.agent].label,
        round: 1,
        content: result.content,
      };
      this.#store.addMessage(id, message);
      await options.onMessage?.(message);
      this.#store.finishDiscussion(id, "completed");
      return message;
    } catch (error) {
      this.#store.finishDiscussion(id, "failed");
      throw error;
    }
  }

  async discuss(options: DiscussionOptions): Promise<DiscussionMessage[]> {
    const id = options.discussionId ?? randomUUID();
    const transcript: DiscussionMessage[] = [];
    this.#store.createDiscussion(id, options.repositoryAlias, options.prompt);

    try {
      for (let round = 1; round <= options.rounds; round += 1) {
        for (const agent of ["codex", "claude"] as const) {
          const peer = agent === "codex" ? "claude" : "codex";
          const history = transcript.length
            ? transcript
                .map((message) => `${message.label} (round ${message.round}):\n${message.content}`)
                .join("\n\n---\n\n")
            : "No prior agent messages.";

          const prompt = [
            `Engineering topic: ${options.prompt}`,
            `You are round ${round} participant '${this.#profiles[agent].label}'.`,
            `Your peer is '${this.#profiles[peer].label}'.`,
            "Respond to the latest arguments, do not repeat settled points, and clearly mark unresolved human decisions.",
            "",
            "Discussion transcript:",
            history,
          ].join("\n");

          const result = await this.#agents[agent].run({ repositoryPath: options.repositoryPath, prompt });
          const message: DiscussionMessage = {
            agent,
            label: this.#profiles[agent].label,
            round,
            content: result.content,
          };
          transcript.push(message);
          this.#store.addMessage(id, message);
          await options.onMessage?.(message);
        }
      }
      this.#store.finishDiscussion(id, "completed");
      return transcript;
    } catch (error) {
      this.#store.finishDiscussion(id, "failed");
      throw error;
    }
  }
}
