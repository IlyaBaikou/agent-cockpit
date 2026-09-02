const api = window.cockpit;
const $ = (selector) => document.querySelector(selector);
let appState;
let conversations = [];
let selectedId;
let selectedSnapshot;
let loading = false;
let toastTimer;

function escapeHtml(value = "") {
  return String(value).replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
}

function time(value) {
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", month: "short", day: "numeric" }).format(new Date(value));
}

function showToast(message) {
  clearTimeout(toastTimer);
  $("#toast").textContent = message;
  $("#toast").classList.remove("hidden");
  toastTimer = setTimeout(() => $("#toast").classList.add("hidden"), 2400);
}

function errorMessage(error) {
  return error?.message?.replace(/^Error invoking remote method '[^']+': Error: /, "") || String(error);
}

function renderState() {
  if (!appState) return;
  const pill = $("#connection-pill");
  pill.textContent = appState.connected ? (appState.mode === "host" ? "Hosting locally" : "Connected to host") : "Offline";
  pill.className = `pill ${appState.connected ? "ready" : "error"}`;
  $("#connection-detail").textContent = appState.connectionDetail;
  $("#connection-url").textContent = appState.serverUrl;
  $("#repository-list").innerHTML = appState.repositories.map((name) => `<span class="tag">${escapeHtml(name)}</span>`).join("");
  $("#agent-cards").innerHTML = appState.agents.map((agent) => `
    <div class="agent-card ${agent.enabled ? "" : "agent-off"}">
      <div class="agent-card-top">
        <span class="avatar ${agent.id}">${agent.id === "codex" ? "C" : "Cl"}</span>
        <div><strong>${agent.id === "codex" ? "Codex" : "Frontend agent"}${agent.enabled ? "" : " · off"}</strong><small title="${escapeHtml(agent.detail)}">${escapeHtml(agent.detail)}</small></div>
        <span class="health-light ${agent.status}"></span>
      </div>
    </div>`).join("");
  const codex = appState.agents.find((agent) => agent.id === "codex");
  const claude = appState.agents.find((agent) => agent.id === "claude");
  const hasConfiguredAgent = appState.agents.some((agent) => agent.enabled);
  $("#codex-setup-status").textContent = codex?.detail || "Not checked";
  $("#claude-setup-status").textContent = claude?.detail || "Not checked";
  $("#enable-codex").disabled = codex?.status === "unavailable";
  $("#enable-claude").disabled = claude?.status === "unavailable";
  $("#enable-codex").checked = Boolean((codex?.enabled || (appState.firstRun && !hasConfiguredAgent)) && codex?.status !== "unavailable");
  $("#enable-claude").checked = Boolean((claude?.enabled || (appState.firstRun && !hasConfiguredAgent)) && claude?.status !== "unavailable");
  $("#allow-write").checked = appState.allowWrite;
  $("#claude-executor").value = appState.claudeExecutor;
  $("#advertise-url").value = appState.advertiseUrl;
  $("#advertise-field").classList.toggle("hidden", appState.mode !== "host");
  $("#invite-box").classList.toggle("hidden", !appState.inviteCode);
  $("#settings-title").textContent = appState.firstRun ? "Connect your agents" : "Local agent setup";
}

function renderThreads() {
  $("#thread-count").textContent = String(conversations.length);
  $("#thread-list").innerHTML = conversations.map((conversation) => `
    <button class="thread-item ${conversation.id === selectedId ? "active" : ""}" data-id="${conversation.id}">
      <strong>${escapeHtml(conversation.topic)}</strong>
      <span class="thread-meta"><span><i class="status-dot ${conversation.status}"></i>${escapeHtml(conversation.status)}</span><span>${time(conversation.updatedAt)}</span></span>
    </button>`).join("");
  document.querySelectorAll(".thread-item").forEach((button) => button.addEventListener("click", () => selectConversation(button.dataset.id)));
}

function cleanContent(content) {
  const routing = content.match(/^HANDOFF:\s*(codex|claude|human|done)\s*$/im)?.[1];
  const body = content.replace(/^HANDOFF:\s*(codex|claude|human|done)\s*$/gim, "").trim();
  return { body, routing };
}

function renderConversation() {
  const hasConversation = Boolean(selectedSnapshot);
  $("#empty-state").classList.toggle("hidden", hasConversation);
  $("#conversation").classList.toggle("hidden", !hasConversation);
  if (!selectedSnapshot) return;
  const conversation = selectedSnapshot.conversation;
  $("#conversation-id").textContent = `${conversation.id} · ${conversation.status}`;
  $("#conversation-title").textContent = conversation.topic;
  $("#operator-banner").classList.toggle("hidden", conversation.waitingFor !== "human");
  $("#close-thread-button").disabled = conversation.status === "running" || conversation.status === "completed";
  $("#reply-form").classList.toggle("hidden", conversation.status === "running");
  const lastAgent = [...selectedSnapshot.messages].reverse().find((message) => message.actor === "codex" || message.actor === "claude")?.actor;
  $("#reply-target").value = lastAgent === "codex" ? "claude" : "codex";
  $("#message-list").innerHTML = selectedSnapshot.messages.map((message) => {
    const { body, routing } = cleanContent(message.content);
    const actor = message.actor;
    const avatar = actor === "codex" ? "C" : actor === "claude" ? "Cl" : actor === "human" ? "You" : "•";
    return `<article class="message ${actor}">
      <div class="message-head"><span class="avatar ${actor}">${avatar}</span><strong>${escapeHtml(message.label)}</strong><span>${time(message.createdAt)}</span></div>
      <div class="message-body">${escapeHtml(body)}${routing ? `<span class="handoff">Next: ${escapeHtml(routing)}</span>` : ""}</div>
    </article>`;
  }).join("");
  const list = $("#message-list");
  list.scrollTop = list.scrollHeight;
}

async function loadState() {
  appState = await api.state();
  renderState();
  if (appState.firstRun) $("#settings-modal").classList.remove("hidden");
}

async function refreshConversations() {
  if (loading || !appState?.connected) return;
  loading = true;
  try {
    conversations = await api.list();
    if (!selectedId && conversations[0]) selectedId = conversations[0].id;
    renderThreads();
    if (selectedId) {
      selectedSnapshot = await api.get(selectedId);
      renderConversation();
    }
  } catch (error) {
    showToast(errorMessage(error));
  } finally {
    loading = false;
  }
}

async function selectConversation(id) {
  selectedId = id;
  renderThreads();
  selectedSnapshot = await api.get(id);
  renderConversation();
}

function populateRepositories() {
  const options = appState.repositories.map((repository) => `<option value="${escapeHtml(repository)}">${escapeHtml(repository)}</option>`).join("");
  $("#new-codex-repo").innerHTML = options;
  $("#new-claude-repo").innerHTML = options;
}

function openNewModal() {
  populateRepositories();
  $("#new-modal").classList.remove("hidden");
  $("#new-topic").focus();
}

function closeNewModal() { $("#new-modal").classList.add("hidden"); }

$("#new-button").addEventListener("click", openNewModal);
$("#empty-new-button").addEventListener("click", openNewModal);
$("#new-modal .modal-close").addEventListener("click", closeNewModal);
$("#new-modal .modal-cancel").addEventListener("click", closeNewModal);
$("#settings-button").addEventListener("click", () => $("#settings-modal").classList.remove("hidden"));
$(".settings-close").addEventListener("click", () => { if (!appState.firstRun) $("#settings-modal").classList.add("hidden"); });

$("#new-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  try {
    selectedSnapshot = await api.open({
      topic: $("#new-topic").value,
      codexRepository: $("#new-codex-repo").value,
      claudeRepository: $("#new-claude-repo").value,
      target: $("#new-target").value,
      mode: document.querySelector('input[name="new-mode"]:checked').value,
      turns: Number($("#new-turns").value),
    });
    selectedId = selectedSnapshot.conversation.id;
    closeNewModal();
    $("#new-form").reset();
    await refreshConversations();
  } catch (error) { showToast(errorMessage(error)); }
  finally { button.disabled = false; }
});

$("#reply-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const content = $("#reply-content").value.trim();
  if (!content || !selectedId) return;
  $("#send-button").disabled = true;
  try {
    selectedSnapshot = await api.reply({
      conversationId: selectedId,
      content,
      target: $("#reply-target").value,
      mode: $("#reply-mode").value,
      turns: Number($("#reply-turns").value),
    });
    $("#reply-content").value = "";
    renderConversation();
    await refreshConversations();
  } catch (error) { showToast(errorMessage(error)); }
  finally { $("#send-button").disabled = false; }
});

$("#close-thread-button").addEventListener("click", async () => {
  if (!selectedId) return;
  try {
    selectedSnapshot = await api.close(selectedId);
    await refreshConversations();
  } catch (error) { showToast(errorMessage(error)); }
});

$("#settings-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const agents = [$("#enable-codex"), $("#enable-claude")].filter((input) => input.checked).map((input) => input.value);
  const error = $("#settings-error");
  if (!agents.length) {
    error.textContent = "Choose at least one local agent.";
    error.classList.remove("hidden");
    return;
  }
  error.classList.add("hidden");
  try {
    appState = await api.updateSettings({ agents, allowWrite: $("#allow-write").checked, claudeExecutor: $("#claude-executor").value, advertiseUrl: $("#advertise-url").value });
    renderState();
    $("#settings-modal").classList.add("hidden");
    showToast("Local agents started");
  } catch (cause) {
    error.textContent = errorMessage(cause);
    error.classList.remove("hidden");
  }
});

$("#refresh-health").addEventListener("click", async () => {
  appState = await api.refreshHealth();
  renderState();
  showToast("Connections checked");
});

$("#copy-invite").addEventListener("click", async () => {
  if (!appState.inviteCode) return;
  await api.copy(appState.inviteCode);
  showToast("Pairing code copied");
});

api.onChanged(async () => {
  appState = await api.state();
  renderState();
  await refreshConversations();
});

await loadState();
await refreshConversations();
setInterval(refreshConversations, 2200);
