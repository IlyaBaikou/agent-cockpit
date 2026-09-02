import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeSlackDesktopProof } from "../src/integration-doctor.js";
import {
  formatDesktopAgentResponse,
  SlackDesktopPublisher,
  type DesktopSlackPost,
} from "../src/slack/desktop-publisher.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("SlackDesktopPublisher", () => {
  it("formats a visibly attributed agent response and removes the internal handoff marker", () => {
    expect(formatDesktopAgentResponse({
      conversationId: "CHAT-0004",
      agentLabel: "Codex",
      content: "Backend answer.\nHANDOFF: claude",
    })).toEqual([
      "*AgentHub · Codex · CHAT-0004*\nBackend answer.\n\n_Sent using Codex_",
    ]);
  });

  it("publishes only through a fresh proof for the configured channel", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-hub-slack-publisher-"));
    temporaryDirectories.push(root);
    const proofFile = join(root, "proof.json");
    await writeSlackDesktopProof(proofFile, {
      workspaceId: "T123",
      workspaceName: "Workspace",
      channelId: "C123",
      channelName: "agent-hub-lab",
      userName: "Developer",
    });
    const posts: DesktopSlackPost[] = [];
    const publisher = new SlackDesktopPublisher({
      proofFile,
      expectedChannelId: "C123",
      automation: async (post) => { posts.push(post); },
    });

    await publisher.publish({ conversationId: "CHAT-0004", agentLabel: "Codex", content: "Answer\nHANDOFF: done" });
    expect(posts).toEqual([{
      workspaceId: "T123",
      channelId: "C123",
      channelName: "agent-hub-lab",
      text: "*AgentHub · Codex · CHAT-0004*\nAnswer\n\n_Sent using Codex_",
    }]);

    const wrongChannel = new SlackDesktopPublisher({
      proofFile,
      expectedChannelId: "C999",
      automation: async () => undefined,
    });
    await expect(wrongChannel.publish({ conversationId: "CHAT-0004", agentLabel: "Codex", content: "Answer" }))
      .rejects.toThrow("does not match configured channel");
  });
});
