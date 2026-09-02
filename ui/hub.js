/* No remote scripts or HTML from messages. All user/agent content is escaped. */
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const labels = { open: "Открыт", working: "Агенты работают", waiting: "Нужен человек", resolved: "Решено", error: "Ошибка", paused: "На паузе" };
let appState, data, spaceId = null, threadId = null, renderKey = "", mentionStart = null;
let draftRequest = null;
const drafts = new Map();
const name = (id) => data?.agents.find((a) => a.id === id)?.name ?? data?.employees.find((e) => e.id === id)?.name ?? "Agent Hub";
const initials = (s) => s.split(/[\s/-]+/).slice(0, 2).map((p) => p[0] ?? "").join("").toUpperCase();
const status = (s) => `<span class="status ${esc(s)}">${labels[s] ?? esc(s)}</span>`;
const currentSpace = () => data?.spaces.find((s) => s.id === spaceId);
const currentThread = () => data?.threads.find((t) => t.id === threadId);
const time = (value) => new Date(value).toLocaleTimeString("ru", { hour: "2-digit", minute: "2-digit" });
const friendly = (text) => String(text).replace(/@\{([au]):([a-zA-Z0-9._-]+)\}/g, (_m, _kind, id) => `@${name(id)}`);
function toast(message) { $("toast").textContent = message; $("toast").classList.remove("hidden"); setTimeout(() => $("toast").classList.add("hidden"), 6000); }
function errorText(error) { return String(error.message ?? error).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ""); }
async function safely(action, target = "modal-error") { try { $(target).textContent = ""; return await action(); } catch (error) { $(target).textContent = errorText(error); } }
function openModal(title, html) { $("modal-title").textContent = title; $("modal-content").innerHTML = html; $("modal-error").textContent = ""; if (!$("modal").open) $("modal").showModal(); }
function closeModal() { $("modal").close(); }
$("modal-close").onclick = closeModal;
function inline(text) {
  return esc(text).replace(/@\{([au]):([a-zA-Z0-9._-]+)\}/g, (_m, _kind, id) => `<span class="mention">@${esc(name(id))}</span>`)
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/`([^`\n]+)`/g, "<code>$1</code>").replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>").replace(/\n/g, "<br>");
}
function markdown(text) {
  return String(text).split(/(```[\s\S]*?```)/g).map((part) => part.startsWith("```") ? `<pre><code>${esc(part.replace(/^```[^\n]*\n?/, "").replace(/```$/, ""))}</code></pre>` : part.split(/\n\n/).filter(Boolean).map((p) => `<p>${inline(p)}</p>`).join("")).join("");
}
document.addEventListener("click", (event) => {
  const link = event.target.closest("a[href]");
  if (link) { event.preventDefault(); void window.hub.openLink(link.getAttribute("href")).catch((e) => toast(errorText(e))); }
});
function receive(value) {
  appState = value; data = value.snapshot;
  $("onboarding").classList.toggle("hidden", Boolean(data)); $("workspace").classList.toggle("hidden", !data);
  if (!data) { if (value.error) $("connect-error").textContent = value.error; return; }
  if (!data.spaces.some((s) => s.id === spaceId)) { spaceId = data.spaces[0]?.id ?? null; threadId = null; renderKey = ""; }
  if (threadId && !data.threads.some((t) => t.id === threadId && t.space === spaceId)) threadId = null;
  $("my-name").textContent = data.me.name; $("avatar").textContent = initials(data.me.name);
  $("connection-dot").classList.toggle("ready", value.connected); $("connection-text").textContent = value.connected ? (value.settings.local ? "Локальный хаб" : "Хаб подключён") : "Связь прервана";
  $("connection-banner").classList.toggle("hidden", !value.error); $("connection-banner").textContent = value.error ? `${value.error}. Восстанавливаем подключение…` : "";
  renderSidebar(); renderTopics(); renderChat();
}
function renderSidebar() {
  $("spaces").innerHTML = data.spaces.map((s) => `<button class="space-button ${s.id === spaceId ? "active" : ""}" data-space="${s.id}"><span>#</span>${esc(s.name)}</button>`).join("");
  $("spaces").querySelectorAll("[data-space]").forEach((b) => b.onclick = () => navigate(b.dataset.space, null));
  $("my-agents").innerHTML = data.agents.filter((a) => a.owner === data.me.id).map((a) => {
    const busy = data.jobs.some((j) => j.agent === a.id && j.status === "running");
    return `<button class="agent-nav" data-agent="${a.id}"><i class="dot ${busy ? "busy" : a.ready && a.enabled ? "ready" : ""}"></i><span>${esc(a.name)}<small>${a.executor} · ${!a.enabled ? "отключён" : busy ? "работает" : a.ready ? "готов" : "не в сети"}</small></span></button>`;
  }).join("") || '<p class="hint">Подключите первого агента через +</p>';
  $("my-agents").querySelectorAll("[data-agent]").forEach((b) => b.onclick = () => editAgent(b.dataset.agent));
  $("inbox-count").textContent = data.notices.length || "";
}
function navigate(space, thread) {
  drafts.set(`${spaceId}/${threadId}`, $("composer").value);
  spaceId = space; threadId = thread; renderKey = ""; draftRequest = null;
  $("composer").value = drafts.get(`${spaceId}/${threadId}`) ?? ""; $("send-error").textContent = "";
  $("mention-picker").classList.add("hidden");
  if (data) { renderSidebar(); renderTopics(); renderChat(); }
}
function renderTopics() {
  const space = currentSpace(); $("space-name").textContent = space?.name ?? "Создайте спейс";
  $("members").textContent = space ? `${space.members.length} участников · Настроить` : "";
  $("general").classList.toggle("active", !threadId);
  $("threads").innerHTML = data.threads.filter((t) => t.space === spaceId).slice().reverse().map((t) => `<button class="thread-card ${t.id === threadId ? "active" : ""}" data-thread="${t.id}"><strong>${esc(t.title)}</strong><div class="meta">${status(t.status)}<span>${data.messages.filter((m) => m.thread === t.id && m.kind !== "system").length} сообщ.</span></div></button>`).join("");
  $("threads").querySelectorAll("[data-thread]").forEach((b) => b.onclick = () => navigate(spaceId, b.dataset.thread));
}
function renderChat() {
  const thread = currentThread(), space = currentSpace();
  $("chat-title").textContent = thread?.title ?? (space ? "Общий чат" : "Добро пожаловать в Agent Hub");
  $("chat-eyebrow").textContent = thread ? `ТРЕД · ${space?.name ?? ""}` : "ОБЩЕНИЕ КОМАНДЫ";
  $("chat-subtitle").innerHTML = thread ? `${status(thread.status)} &nbsp; Начал ${esc(name(thread.owner))}` : "Люди общаются здесь. Агентский разбор уходит в отдельный тред.";
  $("thread-actions").classList.toggle("hidden", !thread);
  $("resolve").textContent = thread?.status === "resolved" ? "↺ Открыть" : "✓ Завершить";
  const messages = data.messages.filter((m) => m.space === spaceId && m.thread === threadId);
  const jobs = data.jobs.filter((j) => j.thread === threadId && ["queued", "running"].includes(j.status));
  $("job-status").classList.toggle("hidden", !jobs.length);
  $("job-status").textContent = jobs.map((j) => `${name(j.agent)} ${j.status === "queued" ? "ожидает свободного раннера" : "работает с контекстом треда"} · ${j.mode === "write" ? "изменения" : "разбор"}`).join(" · ");
  $("send").disabled = !space || !appState.connected;
  const key = JSON.stringify([spaceId, threadId, messages, data.jobs.filter((j) => j.thread === threadId).map((j) => [j.id,j.status])]);
  if (key === renderKey) return;
  const wasNearBottom = $("messages").scrollHeight - $("messages").scrollTop - $("messages").clientHeight < 110;
  const switched = !renderKey; renderKey = key;
  $("messages").innerHTML = messages.map((m) => {
    if (m.kind === "system") return `<div class="system">${inline(m.content)}</div>`;
    const agent = data.agents.find((a) => a.id === m.author);
    return `<article class="message ${m.kind}"><span class="avatar">${esc(initials(name(m.author)))}</span><div class="message-main"><div class="message-head"><strong>${esc(name(m.author))}</strong>${agent ? `<span class="agent-tag">АГЕНТ · ${esc(name(agent.owner))}</span>` : ""}<time>${time(m.createdAt)}</time></div><div class="message-body">${markdown(m.content)}</div></div></article>`;
  }).join("") || `<div class="empty"><div class="symbol">${space ? "↗" : "✳"}</div><h3>${space ? "Начните с вопроса" : "Команда начинается со спейса"}</h3><p>${space ? "Напишите коллеге или вызовите агента через @. Он увидит историю этого треда и сможет подключить другого агента." : "Создайте пространство, добавьте коллег и подключите своих агентов. Никаких заданных ролей."}</p></div>`;
  const ownWrites = data.jobs.filter((j) => j.thread === threadId && j.mode === "write" && data.agents.find((a) => a.id === j.agent)?.owner === data.me.id && j.started);
  for (const job of ownWrites) {
    const div = document.createElement("div"); div.className = "system";
    const button = document.createElement("button"); button.className = "worktree"; button.textContent = `Открыть рабочую копию · ${name(job.agent)}`;
    button.onclick = () => window.hub.openWorktree(job.id).catch((e) => toast(errorText(e))); div.append(button); $("messages").append(div);
  }
  if (switched || wasNearBottom) $("messages").scrollTop = $("messages").scrollHeight;
}

function mentionOptions() {
  const members = currentSpace()?.members ?? [];
  return [
    ...data.employees.filter((e) => members.includes(e.id)).map((e) => ({ id: e.id, kind: "u", title: e.name, insert: `@«${e.name}»`, sub: "Сотрудник · отправить уведомление" })),
    ...data.agents.filter((a) => members.includes(a.owner) && a.enabled).map((a) => ({ id: a.id, kind: "a", title: a.name, insert: `@«${name(a.owner)} / ${a.name}»`, sub: `${name(a.owner)} · ${a.executor} · ${a.ready ? "готов" : "не в сети"}` })),
  ];
}
function showMentions(forced = false) {
  if (!data || !spaceId) return;
  const before = $("composer").value.slice(0, $("composer").selectionStart);
  const match = /(?:^|\s)@([^@«\n]*)$/.exec(before);
  if (!match && !forced) { $("mention-picker").classList.add("hidden"); mentionStart = null; return; }
  const query = forced ? "" : match[1].toLowerCase();
  mentionStart = match ? before.lastIndexOf("@") : $("composer").selectionStart;
  const options = mentionOptions().filter((o) => `${o.title} ${o.sub}`.toLowerCase().includes(query));
  $("mention-picker").innerHTML = options.map((o, index) => `<button type="button" class="mention-option" data-index="${index}"><span class="avatar">${o.kind === "a" ? "↗" : esc(initials(o.title))}</span><span>${esc(o.title)}<small>${esc(o.sub)}</small></span></button>`).join("") || '<div class="hint">Нет подходящих участников. Добавьте коллегу в спейс.</div>';
  $("mention-picker").classList.remove("hidden");
  $("mention-picker").querySelectorAll("button").forEach((button) => button.onclick = () => {
    const option = options[Number(button.dataset.index)]; const input = $("composer");
    const start = mentionStart ?? input.selectionStart;
    input.setRangeText(`${option.insert} `, start, input.selectionStart, "end");
    $("mention-picker").classList.add("hidden"); input.focus();
  });
}
function encodeMentions(text) { for (const option of mentionOptions()) text = text.split(option.insert).join(`@{${option.kind}:${option.id}}`); return text; }
$("composer").addEventListener("input", () => { draftRequest = null; showMentions(); });
$("composer").addEventListener("keydown", (event) => { if (event.key === "Escape") $("mention-picker").classList.add("hidden"); if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); $("composer-form").requestSubmit(); } });
$("mention-button").onclick = () => { $("composer").focus(); showMentions(true); };
$("composer-form").onsubmit = (event) => {
  event.preventDefault(); void safely(async () => {
    const content = encodeMentions($("composer").value.trim()); if (!content) return;
    const request = { space: spaceId, thread: threadId, content, mode: $("mode").value };
    const key = JSON.stringify(request); if (!draftRequest || draftRequest.key !== key) draftRequest = { key, id: crypto.randomUUID() };
    $("send").disabled = true;
    try {
      const result = await window.hub.call("post", { ...request, requestId: draftRequest.id });
      $("composer").value = ""; drafts.delete(`${spaceId}/${threadId}`); draftRequest = null;
      if (!threadId && result.thread) navigate(spaceId, result.thread.id);
    } finally { $("send").disabled = false; }
  }, "send-error");
};
$("general").onclick = () => navigate(spaceId, null);
$("stop").onclick = () => void safely(() => window.hub.call("thread-state", { thread: threadId, status: "paused" }), "send-error");
$("resolve").onclick = () => void safely(() => window.hub.call("thread-state", { thread: threadId, status: currentThread()?.status === "resolved" ? "open" : "resolved" }), "send-error");
$("new-thread").onclick = () => {
  if (!spaceId) return toast("Сначала создайте спейс");
  openModal("Новый тред", '<form id="thread-form"><label>Тема<input id="thread-title" required maxlength="160" placeholder="Например: контракт новой геймификации"></label><label>С чего начнём?<textarea id="thread-message" rows="5" required placeholder="Опишите вопрос, добавьте ссылки на Jira, Confluence или PR"></textarea></label><p class="hint">После создания вызовите нужного агента через @ в строке сообщения.</p><div class="modal-actions"><button class="primary">Создать тред</button></div></form>');
  $("thread-form").onsubmit = (e) => { e.preventDefault(); void safely(async () => { const result = await window.hub.call("post", { space: spaceId, title: $("thread-title").value, content: $("thread-message").value, newThread: true }); closeModal(); navigate(spaceId, result.thread.id); }); };
};
$("add-space").onclick = () => editSpace(false);
$("members").onclick = () => editSpace(true);
function editSpace(existing) {
  const space = existing ? currentSpace() : null; if (existing && !space) return;
  if (space && space.owner !== data.me.id) { openModal("Участники спейса", space.members.map((id) => `<p>${esc(name(id))}</p>`).join("") + '<p class="hint">Состав участников меняет создатель спейса.</p>'); return; }
  openModal(existing ? "Участники спейса" : "Новый спейс", `<form id="space-form">${existing ? "" : '<label>Название<input id="new-space-name" required maxlength="80" placeholder="Интеграция бэка и фронта"></label>'}<p class="hint">Участники видят весь чат и все треды спейса. Их подключённые агенты доступны через @.</p><div class="member-list">${data.employees.filter((e) => e.id !== data.me.id).map((e) => `<label class="check"><input name="member" type="checkbox" value="${e.id}" ${space?.members.includes(e.id) ? "checked" : ""}> ${esc(e.name)}</label>`).join("") || '<p class="hint">Пока здесь только вы. Коллег можно пригласить из настроек.</p>'}</div><div class="modal-actions"><button class="primary">${existing ? "Сохранить" : "Создать спейс"}</button></div></form>`);
  $("space-form").onsubmit = (e) => { e.preventDefault(); void safely(async () => {
    const members = [...document.querySelectorAll('input[name="member"]:checked')].map((i) => i.value);
    const result = await window.hub.call(existing ? "members" : "space", { members, ...(existing ? { space: space.id } : { name: $("new-space-name").value }) }); closeModal(); navigate(result.id, null);
  }); };
}
$("add-agent").onclick = () => editAgent();
function editAgent(id) {
  const agent = appState.settings.agents.find((a) => a.id === id);
  if (id && !agent) return toast("Этот агент настроен на другом компьютере владельца.");
  openModal(agent ? `Настройки · ${agent.name}` : "Подключить агента", `<form id="agent-form"><div class="agent-editor-header"><label>Имя агента<input id="agent-name" required maxlength="80" value="${esc(agent?.name ?? "")}" placeholder="Например: Backend reviewer"></label><label>Исполнитель<select id="agent-executor">${["codex", "claude", "cursor"].map((p) => `<option value="${p}" ${agent?.executor === p ? "selected" : ""}>${p === "claude" ? "Claude Code" : p === "cursor" ? "Cursor CLI" : "Codex"}</option>`).join("")}</select></label></div><label>Рабочая папка<div class="row"><input id="agent-directory" required value="${esc(agent?.directory ?? "")}" placeholder="Папка проекта или документов"><button type="button" id="choose-directory">Выбрать</button></div></label><label>Описание и контекст<textarea id="agent-description" rows="3" placeholder="С чем работает агент, какие вопросы ему адресовать">${esc(agent?.description ?? "")}</textarea></label><label>Резервный агент<select id="agent-fallback"><option value="">Не назначен — показать ошибку в треде</option>${appState.settings.agents.filter((a) => a.id !== id).map((a) => `<option value="${a.id}" ${agent?.fallback === a.id ? "selected" : ""}>${esc(a.name)}</option>`).join("")}</select></label><details><summary class="hint">Путь к исполняемому файлу CLI (если не найден автоматически)</summary><label><div class="row"><input id="agent-binary" value="${esc(agent?.binary ?? "")}" placeholder="Автоматически"><button type="button" id="choose-binary">Выбрать</button></div></label></details><label class="check"><input id="agent-enabled" type="checkbox" ${agent?.enabled !== false ? "checked" : ""}> Принимать адресные запросы участников моих спейсов</label><label class="check"><input id="agent-write" type="checkbox" ${agent?.allowWrite ? "checked" : ""}> Разрешить мне запускать изменения в отдельной Git-копии</label><p class="hint">Вход в аккаунт — через установленный CLI. Обсуждения и ответы передаются провайдеру агента и участникам спейса. Для изменений нужен Git-репозиторий. Push, merge и деплой приложение не выполняет. CLI-интеграции и их разрешения настраиваются отдельно.</p><p id="agent-health" class="inline-state"></p><div class="modal-actions"><button id="check-agent" type="button" class="quiet">Проверить подключение</button><button class="primary">Сохранить агента</button></div></form>`);
  const input = () => ({ id: agent?.id ?? "", name: $("agent-name").value, executor: $("agent-executor").value, directory: $("agent-directory").value, description: $("agent-description").value, binary: $("agent-binary").value, fallback: $("agent-fallback").value || null, enabled: $("agent-enabled").checked, allowWrite: $("agent-write").checked });
  $("choose-directory").onclick = async () => { const path = await window.hub.directory(); if (path) $("agent-directory").value = path; };
  $("choose-binary").onclick = async () => { const path = await window.hub.binary(); if (path) $("agent-binary").value = path; };
  $("check-agent").onclick = () => void safely(async () => { $("agent-health").textContent = "Проверяем папку, установку и авторизацию…"; $("check-agent").disabled = true; try { const result = await window.hub.checkAgent(input()); $("agent-health").textContent = `✓ ${result.detail}`; } finally { $("check-agent").disabled = false; } });
  $("agent-form").onsubmit = (e) => { e.preventDefault(); void safely(async () => { await window.hub.saveAgent(input()); closeModal(); toast("Агент сохранён. Проверяем готовность раннера."); }); };
}
$("settings").onclick = () => {
  openModal("Настройки", `<div class="settings-section"><form id="profile-form"><label>Ваше имя<div class="row"><input id="profile-name" value="${esc(data.me.name)}" required maxlength="80"><button>Сохранить</button></div></label></form><p class="hint">Хаб: ${esc(appState.settings.url)}<br>Agent Hub ${esc(appState.version)} · ${esc(data.me.id)}</p><div class="divider"></div><h3>Системные уведомления</h3><label class="check"><input id="notifications-toggle" type="checkbox" ${appState.settings.notifications ? "checked" : ""}> Упоминания, ответы, ошибки и запросы решения</label><p class="hint">Содержание кода и переписки не показывается на экране блокировки. Закрытие окна сворачивает приложение в трей — агенты продолжают работать. «Выйти» останавливает их. Автозапуска пока нет.</p><button id="notification-test" class="quiet">Отправить тестовое уведомление</button><div class="divider"></div><h3>Пригласить коллегу</h3><form id="invite-form"><label>Имя сотрудника<div class="row"><input id="invite-name" required placeholder="Например: Pavel"><button ${appState.settings.local ? "disabled" : ""}>Создать приглашение</button></div></label></form><p class="hint">Одноразовое приглашение действует 48 часов. Скопируется в буфер обмена — отправьте коллеге лично, не в общий чат. После входа добавьте коллегу в нужные спейсы.</p></div>`);
  $("profile-form").onsubmit = (e) => { e.preventDefault(); void safely(async () => { await window.hub.call("profile", { name: $("profile-name").value }); toast("Имя сохранено"); }); };
  $("notifications-toggle").onchange = () => void safely(() => window.hub.preferences({ notifications: $("notifications-toggle").checked }));
  $("notification-test").onclick = () => void safely(async () => { await window.hub.testNotification(); toast("Тест отправлен. Если баннера нет, проверьте разрешения Agent Hub в настройках уведомлений ОС."); });
  $("invite-form").onsubmit = (e) => { e.preventDefault(); void safely(async () => { await window.hub.invite($("invite-name").value); toast("Одноразовое приглашение скопировано. Отправьте его коллеге лично."); $("invite-name").value = ""; }); };
};
$("inbox").onclick = () => {
  openModal("Уведомления", data.notices.slice().reverse().slice(0, 100).map((n, i) => `<button class="inbox-item" data-index="${i}"><strong>${esc(n.title)}</strong><small>${esc(friendly(n.body))}</small></button>`).join("") || '<p class="hint">Пока нет уведомлений. Здесь появятся упоминания и ответы на ваши запросы.</p>');
  const notices = data.notices.slice().reverse().slice(0, 100);
  $("modal-content").querySelectorAll("[data-index]").forEach((b) => b.onclick = () => { const n = notices[Number(b.dataset.index)]; closeModal(); navigate(n.space, n.thread); });
};
$("connect-form").onsubmit = (e) => { e.preventDefault(); void safely(async () => { const result = await window.hub.connect({ url: $("hub-url").value.trim(), credential: $("credential").value.trim(), type: $("raw-token").checked ? "token" : "invite" }); $("credential").value = ""; receive(result); }, "connect-error"); };
$("local-test").onclick = () => void safely(async () => receive(await window.hub.local()), "connect-error");
window.hub.onChanged(receive);
window.hub.onNavigate(({ space, thread }) => navigate(space, thread));
void window.hub.state().then(receive);
