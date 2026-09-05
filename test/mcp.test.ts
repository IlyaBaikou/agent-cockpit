import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { CollaborationService } from "../src/collab/service.js";
import { MemoryStateStore } from "../src/collab/store.js";
import { collaborationMcpHttp } from "../src/collab/mcp.js";
import type { Agent, Job, Snapshot, Space } from "../src/collab/model.js";

const employeeToken = "mcp-owner-personal-token-000000000000";

describe("job-scoped Agent Hub MCP", () => {
  let server: Server | undefined;
  afterEach(async () => {
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  });

  it("publishes one visible reply through Streamable HTTP without exposing employee authority", async () => {
    let now = Date.now();
    const service = new CollaborationService(new MemoryStateStore(), [{ actor: "Owner", token: employeeToken }], () => now);
    const call = <T>(op: string, input: Record<string, unknown> = {}) => service.call(employeeToken, op, input) as Promise<T>;
    const agent = await call<Agent>("agent", { name: "Reviewer", executor: "codex", device: "device", enabled: true });
    await call("heartbeat", { agent: agent.id, device: agent.device, ready: true });
    const space = await call<Space>("space", { name: "MCP test" });
    await call("post", { space: space.id, content: `@{a:${agent.id}} Review this contract` });
    const { job } = await call<{ job: Job }>("claim", { agent: agent.id, device: agent.device, contextVersion: 1 });

    const serve = collaborationMcpHttp(service);
    server = createServer((request, response) => void serve(request, response));
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("MCP test server did not bind");
    const url = new URL(`http://127.0.0.1:${address.port}/mcp`);

    const unauthorized = await fetch(url, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer wrong" }, body: "{}" });
    expect(unauthorized.status).toBe(401);
    const client = new Client({ name: "agent-hub-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(url, { authProvider: { token: async () => job.lease! } });
    await client.connect(transport);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["hub_reply"]);
    const result = await client.callTool({ name: "hub_reply", arguments: { content: "Contract is compatible.", next: "done" } });
    expect(result.isError).not.toBe(true);

    // Normal runner delivery after the MCP terminal call is idempotent and
    // cannot create a second message or regain broader employee privileges.
    await call("complete", { job: job.id, lease: job.lease, device: agent.device, content: "duplicate\nROUTE: done" });
    const snapshot = await call<Snapshot>("sync");
    expect(snapshot.threads[0]?.status).toBe("resolved");
    expect(snapshot.messages.filter((message) => message.kind === "agent")).toEqual([
      expect.objectContaining({ author: agent.id, content: "@{u:Owner}\n\nContract is compatible." }),
    ]);
    await transport.close();
    now += 91_000;
    await expect(service.authorizeMcp(job.lease!)).rejects.toThrow("истекло");
  });

  it("keeps peer consent and write authorization outside MCP", async () => {
    const bobToken = "mcp-bob-personal-token-00000000000000";
    const service = new CollaborationService(new MemoryStateStore(), [
      { actor: "Owner", token: employeeToken }, { actor: "Bob", token: bobToken },
    ]);
    const call = <T>(token: string, op: string, input: Record<string, unknown> = {}) => service.call(token, op, input) as Promise<T>;
    const first = await call<Agent>(employeeToken, "agent", { name: "Backend", executor: "codex", device: "a", enabled: true, allowWrite: true });
    const peer = await call<Agent>(bobToken, "agent", { name: "Frontend", executor: "claude", device: "b", enabled: true, allowWrite: true });
    await call(employeeToken, "heartbeat", { agent: first.id, device: first.device, ready: true });
    await call(bobToken, "heartbeat", { agent: peer.id, device: peer.device, ready: true });
    const space = await call<Space>(employeeToken, "space", { name: "MCP consent", members: ["Bob"] });
    await call(employeeToken, "post", { space: space.id, content: `@{a:${first.id}} Review` });
    const { job } = await call<{ job: Job }>(employeeToken, "claim", { agent: first.id, device: first.device });

    await expect(service.authorizeMcp(employeeToken)).rejects.toThrow("MCP-задание");
    await expect(service.completeMcp(job.lease!, { content: "Bad target", next: "agent", target: "missing" })).rejects.toThrow("недоступен");
    await service.completeMcp(job.lease!, { content: "Please check the frontend contract", next: "agent", target: peer.id });
    const waiting = await call<Snapshot>(bobToken, "sync");
    expect(waiting.threads[0]?.status).toBe("waiting");
    expect(waiting.participations?.find((value) => value.agent === peer.id)?.status).toBe("pending");
    expect(waiting.jobs).toHaveLength(1);

    // Even an owner's write job lease is rejected by the MCP endpoint. The
    // local runner remains the only component that can deliver worktree diffs.
    await call(employeeToken, "post", { space: space.id, thread: waiting.threads[0]!.id, content: `@{a:${first.id}} Implement`, mode: "write" });
    const write = await call<{ job: Job }>(employeeToken, "claim", { agent: first.id, device: first.device });
    await expect(service.authorizeMcp(write.job.lease!)).rejects.toThrow("только для обсуждения");
  });
});
