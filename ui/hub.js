/* No remote scripts or HTML from messages. All user/agent content is escaped. */
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const labels = { open: "Открыт", working: "Агенты работают", waiting: "Нужен человек", resolved: "Решено", error: "Ошибка", paused: "На паузе" };
let appState, data, spaceId = null, channelId = null, threadId = null, renderKey = "", mentionStart = null;
let channelSupport = false;
let draftRequest = null;
let invitationView = null;
const drafts = new Map();
const name = (id) => data?.agents.find((a) => a.id === id)?.name ?? data?.employees.find((e) => e.id === id)?.name ?? "Agent Hub";
const initials = (s) => s.split(/[\s/-]+/).slice(0, 2).map((p) => p[0] ?? "").join("").toUpperCase();
const status = (s) => `<span class="status ${esc(s)}">${labels[s] ?? esc(s)}</span>`;
const currentSpace = () => data?.spaces.find((s) => s.id === spaceId);
const currentThread = () => data?.threads.find((t) => t.id === threadId);
const defaultChannel = (space) => `general:${space}`;
const channelOf = (item) => item?.channel ?? (item?.thread ? data?.threads.find((t) => t.id === item.thread)?.channel : null) ?? defaultChannel(item?.space);
const channelsIn = (space) => data?.channels?.filter((c) => c.space === space) ?? (space ? [{ id: defaultChannel(space), space, name: "Общий", description: "Объявления и вопросы команды", owner: data?.spaces.find((s) => s.id === space)?.owner, general: true, archived: false }] : []);
const currentChannel = () => channelsIn(spaceId).find((c) => c.id === channelId);
const draftKey = () => `${spaceId}/${channelId}/${threadId}`;
const time = (value) => new Date(value).toLocaleTimeString("ru", { hour: "2-digit", minute: "2-digit" });
const friendly = (text) => String(text).replace(/@\{([au]):([a-zA-Z0-9._-]+)\}/g, (_m, _kind, id) => `@${name(id)}`);
function toast(message) { $("toast").textContent = message; $("toast").classList.remove("hidden"); setTimeout(() => $("toast").classList.add("hidden"), 6000); }
function errorText(error) { return String(error.message ?? error).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ""); }
async function safely(action, target = "modal-error") {
  const buttons = target === "modal-error" ? [...$("modal-content").querySelectorAll("button")] : target === "connect-error" ? [...$("connect-form").querySelectorAll("button")] : [];
  const disabled = buttons.map((b) => b.disabled); buttons.forEach((b) => b.disabled = true);
  try { $(target).textContent = ""; return await action(); }
  catch (error) { $(target).textContent = errorText(error); }
  finally { buttons.forEach((b, i) => b.disabled = disabled[i]); }
}
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
document.addEventListener("change", (event) => {
  if (!event.target.matches("[data-theme-choice]")) return;
  const before = appState?.settings.theme ?? "system", selected = event.target.value;
  applyTheme(selected);
  void window.hub.preferences({ theme: selected }).catch((error) => { applyTheme(before); toast(errorText(error)); });
});
function receive(value) {
  appState = value; data = value.snapshot;
  channelSupport = Array.isArray(data?.channels);
  applyTheme(value.settings.theme ?? "system");
  $("onboarding").classList.toggle("hidden", Boolean(data)); $("workspace").classList.toggle("hidden", !data);
  if (!data) { if (value.error) $("connect-error").textContent = value.error; return; }
  if (!data.spaces.some((s) => s.id === spaceId)) { spaceId = data.spaces[0]?.id ?? null; threadId = null; renderKey = ""; }
  if (threadId && !data.threads.some((t) => t.id === threadId && t.space === spaceId)) threadId = null;
  if (threadId) channelId = channelOf(currentThread());
  else if (!channelsIn(spaceId).some((c) => c.id === channelId)) { channelId = spaceId ? defaultChannel(spaceId) : null; renderKey = ""; }
  $("my-name").textContent = data.me.name; $("avatar").textContent = initials(data.me.name);
  $("connection-dot").classList.toggle("ready", value.connected); $("connection-text").textContent = value.connected ? (value.settings.local ? "Локальный хаб" : "Хаб подключён") : "Связь прервана";
  $("connection-banner").classList.toggle("hidden", !value.error); $("connection-banner").textContent = value.error ? `${value.error}. Восстанавливаем подключение…` : "";
  renderSidebar(); renderTopics(); renderChat();
  if ($("modal").open && $("group-invite-form")) {
    const key = JSON.stringify(data.groupInvitations);
    if (invitationView !== key) {
      const space = $("invite-space").value, days = $("invite-days").value, limit = $("invite-limit").value;
      const personalName = $("invite-name").value, code = $("space-invitation").value;
      openInvitations(space);
      $("invite-days").value = days; $("invite-limit").value = limit;
      $("invite-name").value = personalName; $("space-invitation").value = code;
    }
  }
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
function navigate(space, thread, channel) {
  drafts.set(draftKey(), $("composer").value);
  spaceId = space; threadId = thread;
  channelId = thread ? channelOf(data?.threads.find((t) => t.id === thread)) : channel ?? (space ? defaultChannel(space) : null);
  renderKey = ""; draftRequest = null;
  $("composer").value = drafts.get(draftKey()) ?? ""; $("send-error").textContent = "";
  $("mention-picker").classList.add("hidden");
  if (data) { renderSidebar(); renderTopics(); renderChat(); }
}
function renderTopics() {
  const space = currentSpace(); $("space-name").textContent = space?.name ?? "Создайте спейс";
  $("members").textContent = space ? `${space.members.length} участников · Настроить` : "";
  $("general").classList.toggle("active", !threadId);
  renderChannels();
  $("threads").innerHTML = data.threads.filter((t) => t.space === spaceId && channelOf(t) === channelId).slice().reverse().map((t) => `<button class="thread-card ${t.id === threadId ? "active" : ""}" data-thread="${t.id}"><strong>${esc(t.title)}</strong><div class="meta">${status(t.status)}<span>${data.messages.filter((m) => m.thread === t.id && m.kind !== "system").length} сообщ.</span></div></button>`).join("");
  $("threads").querySelectorAll("[data-thread]").forEach((b) => b.onclick = () => navigate(spaceId, b.dataset.thread));
}
function renderChannels() {
  const channels = channelsIn(spaceId), selected = currentChannel();
  const render = (archived) => channels.filter((c) => c.archived === archived).map((c) => {
    const muted = data.channelPreferences?.some((p) => p.channel === c.id && p.muted);
    return `<button class="channel-button ${c.id === channelId ? 'active' : ''}" data-channel="${esc(c.id)}" title="${esc(c.description)}"><span>#</span><strong>${esc(c.name)}</strong>${muted ? '<small>тихо</small>' : ''}${c.archived ? '<small>архив</small>' : ''}</button>`;
  }).join('');
  $("channels").innerHTML = render(false); $("archived-channels").innerHTML = render(true);
  $("channel-archive").classList.toggle("hidden", !channels.some((c) => c.archived));
  if (selected?.archived) $("channel-archive").open = true;
  document.querySelectorAll("[data-channel]").forEach((b) => b.onclick = () => navigate(spaceId, null, b.dataset.channel));
  $("add-channel").disabled = !spaceId || !channelSupport || !appState.connected;
  $("channel-settings").disabled = !selected || !channelSupport;
  $("mute-channel").disabled = !selected || !channelSupport;
  const muted = data.channelPreferences?.some((p) => p.channel === channelId && p.muted) ?? false;
  $("mute-channel").textContent = muted ? "Уведомления заглушены" : "Уведомления включены";
  $("mute-channel").setAttribute("aria-pressed", String(muted));
  $("general").textContent = `← Чат # ${selected?.name ?? 'Общий'}`;
  $("threads-label").textContent = `ТРЕДЫ · ${selected?.name ?? 'Общий'}`;
}
function editChannel(existing = false) {
  if (!spaceId || !channelSupport) return toast("Для каналов обновите сервер хаба до 0.2.5");
  const channel = existing ? currentChannel() : null;
  const canEdit = !channel || channel.owner === data.me.id || currentSpace().owner === data.me.id;
  openModal(channel ? `Канал · ${channel.name}` : "Новый канал", `<form id="channel-form"><label>Название<input id="channel-name" required maxlength="80" placeholder="Геймификация, Игра 1, Математика…" value="${esc(channel?.name ?? '')}" ${!canEdit || channel?.general ? 'readonly' : ''}></label><label>Описание<textarea id="channel-description" maxlength="1000" rows="3" ${canEdit ? '' : 'readonly'} placeholder="Какие вопросы обсуждаем в этом канале">${esc(channel?.description ?? '')}</textarea></label><p class="hint">Все участники спейса видят канал, его сообщения и треды. Приглашения и доступ настраиваются на уровне спейса.</p>${canEdit ? `<div class="modal-actions"><button class="primary">${channel ? 'Сохранить' : 'Создать канал'}</button></div>` : '<p class="hint">Канал меняет его создатель или владелец спейса.</p>'}</form>${channel && !channel.general && canEdit ? `<div class="divider"></div><p class="hint">${channel.archived ? 'Восстановление снова разрешит сообщения. Агентов нужно будет вызвать вручную.' : 'Архив сохранит всю историю для чтения, запретит новые сообщения и остановит работающих здесь агентов. Возможные изменения останутся в их рабочих копиях.'}</p><button id="archive-channel" class="quiet danger">${channel.archived ? 'Восстановить канал' : 'Архивировать канал и остановить агентов'}</button>` : ''}`);
  $("channel-form").onsubmit = (e) => { e.preventDefault(); if (!canEdit) return; void safely(async () => {
    const result = await window.hub.call("channel", { space: spaceId, ...(channel ? { id: channel.id } : {}), name: $("channel-name").value, description: $("channel-description").value });
    closeModal(); navigate(result.space, null, result.id);
  }); };
  if ($("archive-channel")) $("archive-channel").onclick = () => void safely(async () => {
    await window.hub.call("channel-state", { channel: channel.id, archived: !channel.archived });
    closeModal(); navigate(channel.space, null, channel.id);
    toast(channel.archived ? "Канал восстановлен. Работа агентов сама не запускается." : "Канал в архиве. История сохранена.");
  });
}
$("add-channel").onclick = () => editChannel();
$("channel-settings").onclick = () => editChannel(true);
$("mute-channel").onclick = () => void safely(async () => {
  const muted = !(data.channelPreferences?.some((p) => p.channel === channelId && p.muted) ?? false);
  await window.hub.call("channel-preference", { channel: channelId, muted });
  toast(muted ? "Баннеры этого канала выключены, включая упоминания. Записи останутся в «Уведомлениях»." : "Уведомления канала включены.");
}, "send-error");
$("follow-thread").onclick = () => void safely(async () => {
  const following = !(data.threadSubscriptions?.some((f) => f.thread === threadId && f.following) ?? false);
  await window.hub.call("thread-subscription", { thread: threadId, following });
  toast(following ? "Вы подписаны на новые ответы. Заглушение канала имеет приоритет." : "Подписка снята. Прямые обращения и результаты ваших запросов останутся.");
}, "send-error");
function generalThreadCards() {
  const messages = new Map();
  for (const m of data.messages) {
    if (m.space !== spaceId || channelOf(m) !== channelId || !m.thread || m.kind === "system") continue;
    if (!messages.has(m.thread)) messages.set(m.thread, []);
    messages.get(m.thread).push(m);
  }
  return data.threads.filter((t) => t.space === spaceId && channelOf(t) === channelId).map((thread) => {
    const replies = messages.get(thread.id) ?? [];
    return { thread, root: replies[0], replies: Math.max(0, replies.length - 1), createdAt: thread.createdAt ?? replies[0]?.createdAt ?? 0 };
  });
}
function renderThreadCard(card) {
  const t = card.thread;
  const preview = friendly(card.root?.content ?? "").replace(/```[\s\S]*?```/g, "[Фрагмент кода]").slice(0, 260);
  return `<article class="message thread-announcement"><span class="avatar">${esc(initials(name(t.owner)))}</span><div class="message-main"><div class="message-head"><strong>${esc(name(t.owner))}</strong><span class="agent-tag">НАЧАЛ ОБСУЖДЕНИЕ</span><time>${time(card.createdAt)}</time></div><button type="button" class="thread-link-card" data-open-thread="${esc(t.id)}" aria-label="Открыть тред: ${esc(t.title)}. ${esc(labels[t.status] ?? t.status)}. Ответов: ${card.replies}"><span class="thread-link-label">↗ ОБСУЖДЕНИЕ В ТРЕДЕ</span><strong>${esc(t.title)}</strong>${preview ? `<span class="thread-link-preview">${esc(preview)}</span>` : ""}<span class="thread-link-meta">${status(t.status)}<span>Ответов: ${card.replies}</span><span class="thread-link-open">Открыть тред →</span></span></button></div></article>`;
}
function renderChat() {
  const thread = currentThread(), space = currentSpace(), channel = currentChannel();
  const archived = channel?.archived === true;
  $("chat-title").textContent = thread?.title ?? (channel ? `# ${channel.name}` : "Добро пожаловать в Agent Hub");
  $("chat-eyebrow").textContent = thread ? `${space?.name ?? ""} / # ${channel?.name ?? "Общий"} / ТРЕД` : `${space?.name ?? ""} / КАНАЛ`;
  $("chat-subtitle").innerHTML = thread ? `${status(thread.status)} &nbsp; Начал ${esc(name(thread.owner))}` : esc(channel?.description || "Обсуждения команды. Один вопрос — один тред.");
  $("thread-actions").classList.toggle("hidden", !thread);
  $("resolve").textContent = thread?.status === "resolved" ? "↺ Открыть" : "✓ Завершить";
  const messages = data.messages.filter((m) => m.space === spaceId && channelOf(m) === channelId && m.thread === threadId);
  const cards = threadId ? [] : generalThreadCards();
  const jobs = data.jobs.filter((j) => j.thread === threadId && ["queued", "running"].includes(j.status));
  const needsPerson = thread && ["waiting", "paused"].includes(thread.status);
  $("job-status").classList.toggle("hidden", !archived && !jobs.length && !needsPerson);
  $("job-status").textContent = archived ? "Канал в архиве: история доступна для чтения. Восстановите канал в его настройках, чтобы продолжить." : jobs.length ? jobs.map((j) => `${name(j.agent)} ${j.status === "queued" ? "ожидает свободного раннера" : "работает с контекстом треда"} · ${j.mode === "write" ? "изменения" : "разбор"}`).join(" · ") : needsPerson ? "Чтобы продолжить: напишите ответ или уточнение и укажите через @ агента, который должен подхватить разбор." : "";
  document.querySelector(".composer-hint").innerHTML = thread ? "@агент — продолжить разбор · без @ — добавить контекст · @сотрудник — уведомить <span>⌘ / Ctrl + Enter</span>" : "@сотрудник — уведомить · @агент — создать тред · без @ — обычный чат <span>⌘ / Ctrl + Enter</span>";
  for (const id of ["send", "composer", "mode", "mention-button", "new-thread", "stop", "resolve"]) $(id).disabled = archived || !space || !appState.connected;
  $("follow-thread").classList.toggle("hidden", !thread || !channelSupport);
  const following = data.threadSubscriptions?.some((f) => f.thread === threadId && f.following) ?? false;
  $("follow-thread").textContent = following ? "✓ Вы подписаны на тред" : "Подписаться на тред";
  $("follow-thread").setAttribute("aria-pressed", String(following));
  const key = JSON.stringify([spaceId, channelId, threadId, messages, cards, thread?.memory, data.employees, data.agents.map((a) => [a.id, a.name, a.owner]), data.jobs.filter((j) => j.thread === threadId).map((j) => [j.id,j.status])]);
  if (key === renderKey) return;
  const wasNearBottom = $("messages").scrollHeight - $("messages").scrollTop - $("messages").clientHeight < 110;
  const switched = !renderKey; renderKey = key;
  const entries = [...messages.map((message) => ({ message, createdAt: message.createdAt, id: message.id })),
    ...cards.map((card) => ({ card, createdAt: card.createdAt, id: card.thread.id }))]
    .sort((a, b) => a.createdAt - b.createdAt);
  $("messages").innerHTML = entries.map((entry) => {
    if (entry.card) return renderThreadCard(entry.card);
    const m = entry.message;
    if (m.kind === "system") return `<div class="system">${inline(m.content)}</div>`;
    const agent = data.agents.find((a) => a.id === m.author);
    return `<article class="message ${m.kind}"><span class="avatar">${esc(initials(name(m.author)))}</span><div class="message-main"><div class="message-head"><strong>${esc(name(m.author))}</strong>${agent ? `<span class="agent-tag">АГЕНТ · ${esc(name(agent.owner))}</span>` : ""}<time>${time(m.createdAt)}</time></div><div class="message-body">${markdown(m.content)}</div></div></article>`;
  }).join("") || `<div class="empty"><div class="symbol">${space ? "↗" : "✳"}</div><h3>${space ? "Начните с вопроса" : "Команда начинается со спейса"}</h3><p>${space ? "Напишите коллеге или вызовите агента через @. Он увидит историю этого треда и сможет подключить другого агента." : "Создайте пространство, добавьте коллег и подключите своих агентов. Никаких заданных ролей."}</p></div>`;
  $("messages").querySelectorAll("[data-open-thread]").forEach((button) => button.onclick = () => navigate(spaceId, button.dataset.openThread));
  const contextJobs = data.jobs.filter((j) => j.thread === threadId && j.contextStats);
  if (thread && (thread.memory || contextJobs.length)) {
    const panel = document.createElement("details"); panel.className = "context-memory";
    const last = contextJobs.at(-1)?.contextStats;
    const counts = last ? `<p class="hint">Последний вызов: история ${last.historyChars.toLocaleString()} символов → запрос ${last.promptChars.toLocaleString()} символов. Сжатие: вход ${last.summaryInputChars.toLocaleString()}, выход ${last.summaryOutputChars.toLocaleString()} символов. Это не счётчик токенов или стоимости; чтение файлов агентом учитывается провайдером отдельно.</p>` : "";
    panel.innerHTML = `<summary>◈ Память треда ${thread.memory ? "· слепок сохранён" : "· исходные сообщения"}</summary><p class="hint">Полная переписка сохранена. Слепок — рабочие заметки агента, не разрешение на действия. Для исправления добавьте сообщение в тред.</p>${thread.memory ? `<div class="message-body">${markdown(thread.memory.summary)}</div><p class="hint">Обновил ${esc(name(thread.memory.agent))}. Источники: ${thread.memory.citations.map(esc).join(", ")}</p>` : ""}${counts}`;
    $("messages").prepend(panel);
  }
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
    if (currentChannel()?.archived) throw new Error("Канал в архиве");
    const request = { space: spaceId, ...(channelSupport ? { channel: channelId } : {}), thread: threadId, content, mode: $("mode").value };
    const key = JSON.stringify(request); if (!draftRequest || draftRequest.key !== key) draftRequest = { key, id: crypto.randomUUID() };
    $("send").disabled = true;
    try {
      const result = await window.hub.call("post", { ...request, requestId: draftRequest.id });
      $("composer").value = ""; drafts.delete(draftKey()); draftRequest = null;
      if (!threadId && result.thread) navigate(spaceId, result.thread.id);
    } finally { $("send").disabled = currentChannel()?.archived || !appState.connected; }
  }, "send-error");
};
$("general").onclick = () => navigate(spaceId, null, channelId);
$("thread-actions").prepend($("follow-thread"));
$("stop").onclick = () => void safely(() => window.hub.call("thread-state", { thread: threadId, status: "paused" }), "send-error");
$("resolve").onclick = () => void safely(() => window.hub.call("thread-state", { thread: threadId, status: currentThread()?.status === "resolved" ? "open" : "resolved" }), "send-error");
$("new-thread").onclick = () => {
  if (!spaceId) return toast("Сначала создайте спейс");
  if (currentChannel()?.archived) return toast("Сначала восстановите канал из архива");
  openModal("Новый тред", '<form id="thread-form"><label>Тема<input id="thread-title" required maxlength="160" placeholder="Например: контракт новой геймификации"></label><label>С чего начнём?<textarea id="thread-message" rows="5" required placeholder="Опишите вопрос, добавьте ссылки на Jira, Confluence или PR"></textarea></label><p class="hint">После создания вызовите нужного агента через @ в строке сообщения.</p><div class="modal-actions"><button class="primary">Создать тред</button></div></form>');
  $("thread-form").onsubmit = (e) => { e.preventDefault(); void safely(async () => { const result = await window.hub.call("post", { space: spaceId, ...(channelSupport ? { channel: channelId } : {}), title: $("thread-title").value, content: $("thread-message").value, newThread: true }); closeModal(); navigate(spaceId, result.thread.id); }); };
};
$("add-space").onclick = () => editSpace(false);
$("members").onclick = () => editSpace(true);
function editSpace(existing) {
  const space = existing ? currentSpace() : null; if (existing && !space) return;
  if (space && space.owner !== data.me.id) { openModal("Участники спейса", space.members.map((id) => `<p>${esc(name(id))}</p>`).join("") + '<p class="hint">Состав участников меняет создатель спейса.</p>'); return; }
  openModal(existing ? "Участники спейса" : "Новый спейс", `<form id="space-form"><label>Название<input id="new-space-name" required maxlength="80" value="${esc(space?.name ?? "")}" placeholder="Интеграция бэка и фронта"></label><p class="hint">Участники видят весь чат и все треды спейса. Их подключённые агенты доступны через @.</p><div class="member-list">${data.employees.filter((e) => e.id !== data.me.id).map((e) => `<label class="check"><input name="member" type="checkbox" value="${e.id}" ${space?.members.includes(e.id) ? "checked" : ""}> ${esc(e.name)}</label>`).join("") || '<p class="hint">Пока здесь только вы. Коллег можно пригласить из настроек.</p>'}</div><div class="modal-actions"><button class="primary">${existing ? "Сохранить" : "Создать спейс"}</button></div></form>`);
  $("space-form").onsubmit = (e) => { e.preventDefault(); void safely(async () => {
    const members = [...document.querySelectorAll('input[name="member"]:checked')].map((i) => i.value);
    const result = await window.hub.call(existing ? "members" : "space", { members, name: $("new-space-name").value, ...(existing ? { space: space.id } : {}) }); closeModal(); navigate(result.id, null);
  }); };
  if (space && !appState.settings.local && data.groupInvitations) {
    const invite = document.createElement("button"); invite.type = "button"; invite.className = "quiet";
    invite.textContent = "Пригласить команду в этот спейс"; invite.onclick = () => openInvitations(space.id);
    $("modal-content").append(invite);
  }
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
  openModal("Настройки", `<div class="settings-section"><form id="profile-form"><label>Ваше имя<div class="row"><input id="profile-name" value="${esc(data.me.name)}" required maxlength="80"><button>Сохранить</button></div></label></form><p class="hint">Хаб: ${esc(appState.settings.url)}<br>Agent Hub ${esc(appState.version)} · ${esc(data.me.id)}</p><div class="divider"></div><h3>Оформление</h3><label>Тема приложения<select data-theme-choice aria-label="Тема приложения"><option value="system">Как в системе</option><option value="light">Светлая</option><option value="dark">Тёмная</option></select></label><p class="hint">Сохраняется на этом компьютере. «Как в системе» автоматически следует оформлению ОС.</p><div class="divider"></div><h3>Системные уведомления</h3><label class="check"><input id="notifications-toggle" type="checkbox" ${appState.settings.notifications ? "checked" : ""}> Упоминания, ответы, ошибки и запросы решения</label><p class="hint">Содержание кода и переписки не показывается на экране блокировки. Закрытие окна сворачивает приложение в трей — агенты продолжают работать. «Выйти» останавливает их. Автозапуска пока нет.</p><button id="notification-test" class="quiet">Отправить тестовое уведомление</button><div class="divider"></div><h3>Приглашения</h3><p class="hint">Пригласите сразу команду в свой спейс или одного коллегу лично. Уже есть приглашение в другой спейс? Вступите под текущим аккаунтом.</p><button id="open-invitations" ${appState.settings.local ? "disabled" : ""}>Пригласить команду / вступить в спейс</button>${appState.settings.local ? '<p class="hint">Для приглашений с других компьютеров нужен удалённый HTTPS-хаб.</p>' : ''}</div>`);
  applyTheme();
  $("profile-form").onsubmit = (e) => { e.preventDefault(); void safely(async () => { await window.hub.call("profile", { name: $("profile-name").value }); toast("Имя сохранено"); }); };
  $("notifications-toggle").onchange = () => void safely(() => window.hub.preferences({ notifications: $("notifications-toggle").checked }));
  $("notification-test").onclick = () => void safely(async () => { await window.hub.testNotification(); toast("Тест отправлен. Если баннера нет, проверьте разрешения Agent Hub в настройках уведомлений ОС."); });
  $("open-invitations").onclick = () => openInvitations();
};
function openInvitations(selectedSpace = spaceId) {
  invitationView = JSON.stringify(data.groupInvitations);
  const owned = data.spaces.filter((s) => s.owner === data.me.id);
  const supported = Array.isArray(data.groupInvitations);
  const canCreate = supported && owned.length && !appState.settings.local;
  const now = Date.now();
  const invites = (data.groupInvitations ?? []).slice().reverse();
  openModal("Приглашения команды", `<div class="settings-section"><h3>Одно приглашение — вся команда</h3><p class="hint">Скопируйте код в закрытый командный чат. Каждый коллега установит Agent Hub, вставит код, укажет своё имя и сразу попадёт в выбранный спейс.</p>${!supported ? '<p class="banner">Сначала обновите сервер хаба до 0.2.4 для общих приглашений.</p>' : !owned.length ? '<p class="hint">Создайте свой спейс или попросите его владельца выдать общее приглашение.</p>' : ''}<form id="group-invite-form"><label>В какой спейс приглашаем<select id="invite-space" required>${owned.map((s) => `<option value="${esc(s.id)}" ${s.id === selectedSpace ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label><div class="invite-options"><label>Срок действия<select id="invite-days"><option value="1">1 день</option><option value="7" selected>7 дней</option><option value="30">30 дней</option></select></label><label>Максимум входов<input id="invite-limit" type="number" min="1" max="1000" value="100" required></label></div><p class="invite-warning">Любой получивший код сможет вступить и прочитать всю историю этого спейса, а также обращаться к его агентам. Другие спейсы не открываются. Не публикуйте код в интернете.</p><button class="primary" ${canCreate ? '' : 'disabled'}>Создать и скопировать общее приглашение</button></form><div class="divider"></div><h3>Мои общие приглашения</h3><div class="invite-list">${invites.map((i) => {
    const active = !i.revoked && i.expiresAt > now && i.uses < i.maxUses;
    const state = i.revoked ? 'Отключено' : i.expiresAt <= now ? 'Истекло' : i.uses >= i.maxUses ? 'Лимит исчерпан' : 'Действует';
    return `<div class="invite-item"><div><strong>${esc(data.spaces.find((s) => s.id === i.space)?.name ?? 'Спейс')}</strong><small>${state} · ${i.uses} / ${i.maxUses} входов<br>До ${esc(new Date(i.expiresAt).toLocaleString('ru'))}</small></div><button class="quiet danger" data-revoke-invite="${esc(i.id)}" ${active ? '' : 'disabled'}>Отключить</button></div>`;
  }).join('') || '<p class="hint">Пока нет общих приглашений.</p>'}</div><p class="hint">Отключение запрещает новые входы. Уже вошедшие останутся участниками — удалить их можно в настройках спейса. Сам код хранится только у того, кто его скопировал.</p><details><summary>Личное одноразовое приглашение</summary><form id="invite-form"><label>Имя коллеги<div class="row"><input id="invite-name" required maxlength="80" placeholder="Например: Pavel"><button ${appState.settings.local ? 'disabled' : ''}>Скопировать</button></div></label></form><p class="hint">Действует 48 часов, отправляется лично. Коллегу нужно будет отдельно добавить в спейс.</p></details><div class="divider"></div><h3>Вступить по общему приглашению</h3><form id="join-space-form"><label>Код из командного чата<textarea id="space-invitation" rows="2" required placeholder="AH2:…"></textarea></label><p class="hint">Вы сохраните текущий аккаунт и своих агентов. Приглашение должно быть в этот же хаб.</p><button ${supported ? '' : 'disabled'}>Вступить в спейс</button></form></div>`);
  $("group-invite-form").onsubmit = (e) => { e.preventDefault(); void safely(async () => {
    const space = $("invite-space").value;
    await window.hub.invite({ kind: "group", space, days: Number($("invite-days").value), maxUses: Number($("invite-limit").value) });
    openInvitations(space); toast("Общее приглашение скопировано. Отправьте код в закрытый чат команды.");
  }); };
  $("modal-content").querySelectorAll("[data-revoke-invite]").forEach((b) => b.onclick = () => void safely(async () => {
    await window.hub.call("revoke-invite", { id: b.dataset.revokeInvite }); openInvitations(selectedSpace); toast("Новые входы по этому приглашению отключены. Участники остались в спейсе.");
  }));
  $("invite-form").onsubmit = (e) => { e.preventDefault(); void safely(async () => { await window.hub.invite({ kind: "personal", name: $("invite-name").value }); $("invite-name").value = ""; toast("Одноразовое приглашение скопировано. Отправьте его коллеге лично."); }); };
  $("join-space-form").onsubmit = (e) => { e.preventDefault(); void safely(async () => {
    const result = await window.hub.joinInvite($("space-invitation").value.trim()); closeModal(); navigate(result.space, null); toast("Вы в спейсе. Можно общаться и подключать агентов.");
  }); };
}
$("inbox").onclick = () => {
  openModal("Уведомления", data.notices.slice().reverse().slice(0, 100).map((n, i) => `<button class="inbox-item" data-index="${i}"><strong>${esc(n.title)}</strong><small>${esc(friendly(n.body))}</small></button>`).join("") || '<p class="hint">Пока нет уведомлений. Здесь появятся упоминания и ответы на ваши запросы.</p>');
  const notices = data.notices.slice().reverse().slice(0, 100);
  $("modal-content").querySelectorAll("[data-index]").forEach((b) => b.onclick = () => { const n = notices[Number(b.dataset.index)]; closeModal(); navigate(n.space, n.thread, n.channel); });
};
$("connect-form").onsubmit = (e) => { e.preventDefault(); void safely(async () => { const result = await window.hub.connect({ url: $("hub-url").value.trim(), credential: $("credential").value.trim(), name: $("join-name").value.trim(), type: $("raw-token").checked ? "token" : "invite" }); $("credential").value = ""; receive(result); }, "connect-error"); };
$("local-test").onclick = () => void safely(async () => receive(await window.hub.local()), "connect-error");
window.hub.onChanged(receive);
window.hub.onNavigate(({ space, thread, channel }) => navigate(space, thread, channel));
void window.hub.state().then(receive);
