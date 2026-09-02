import { CodexAdapter } from "./agents/codex.js";
import { ClaudeAdapter } from "./agents/claude.js";
import { loadAgentProfiles } from "./config.js";
import { ConversationHub } from "./conversations.js";
import { Orchestrator } from "./orchestrator.js";
import { RepositoryRegistry } from "./repositories.js";
import { HubStore } from "./store.js";
import { TaskFlow } from "./task-flow.js";

export async function createRuntime(): Promise<{
  orchestrator: Orchestrator;
  repositories: RepositoryRegistry;
  store: HubStore;
  taskFlow: TaskFlow;
  conversations: ConversationHub;
  agents: { codex: CodexAdapter; claude: ClaudeAdapter };
}> {
  const repositories = new RepositoryRegistry();
  await repositories.load();
  const profiles = await loadAgentProfiles();
  const store = new HubStore();
  const agents = {
    codex: new CodexAdapter(),
    claude: new ClaudeAdapter(),
  };
  const orchestrator = new Orchestrator({ agents, profiles, store });
  const taskFlow = new TaskFlow({ agents, profiles, store, repositories });
  const conversations = new ConversationHub({ store, profiles });
  return { orchestrator, taskFlow, conversations, repositories, store, agents };
}
