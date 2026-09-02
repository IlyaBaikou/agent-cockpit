import { describe, expect, it } from "vitest";
import { buildAgentEnvironment } from "../src/environment.js";

describe("buildAgentEnvironment", () => {
  it("does not forward hub or unrelated secrets", () => {
    const result = buildAgentEnvironment({
      PATH: "/bin",
      HOME: "/tmp/home",
      SLACK_BOT_TOKEN: "xoxb-secret",
      SLACK_APP_TOKEN: "xapp-secret",
      DATABASE_PASSWORD: "secret",
    });

    expect(result).toEqual({ PATH: "/bin", HOME: "/tmp/home" });
  });

  it("allows explicit provider variables", () => {
    const result = buildAgentEnvironment({
      HOME: "/tmp/home",
      AGENT_FORWARD_ENV: "ANTHROPIC_API_KEY",
      ANTHROPIC_API_KEY: "provider-secret",
      SLACK_BOT_TOKEN: "slack-secret",
    });

    expect(result.ANTHROPIC_API_KEY).toBe("provider-secret");
    expect(result.SLACK_BOT_TOKEN).toBeUndefined();
  });
});
