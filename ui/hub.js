/* No remote scripts or HTML from messages. All user/agent content is escaped. */
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const labels = { open: "Открыт", working: "Агенты работают", waiting: "Нужен человек", resolved: "Решено", error: "Ошибка", paused: "На паузе" };
let appState, data, spaceId = null, channelId = null, threadId = null, renderKey = "", mentionStart = null;
let mentionEnd = null, mentionIndex = -1, visibleMentions = [];
let channelSupport = false;
const outbox = new Map();
const decisionsInFlight = new Set();
const executionsInFlight = new Set();
const readsInFlight = new Map();
let invitationView = null;
const drafts = new Map();
let typingActive = false, typingContext = null, typingStopTimer = 0, typingLastSent = 0, typingVersion = Date.now();
const name = (id) => data?.agents.find((a) => a.id === id)?.name ?? data?.employees.find((e) => e.id === id)?.name ?? "Agent Hub";
const initials = (s) => s.split(/[\s/-]+/).slice(0, 2).map((p) => p[0] ?? "").join("").toUpperCase();
const status = (s) => `<span class="status ${esc(s)}">${labels[s] ?? esc(s)}</span>`;
const threadStatus = (t) => data.participations?.some((p) => p.thread === t.id && p.status === 'pending' && p.request)
  ? '<span class="status waiting">Ожидает разрешения</span>' : status(t.status);
const currentSpace = () => data?.spaces.find((s) => s.id === spaceId);
const currentThread = () => data?.threads.find((t) => t.id === threadId);
const defaultChannel = (space) => `general:${space}`;
const channelOf = (item) => item?.channel ?? (item?.thread ? data?.threads.find((t) => t.id === item.thread)?.channel : null) ?? defaultChannel(item?.space);
const channelsIn = (space) => data?.channels?.filter((c) => c.space === space) ?? (space ? [{ id: defaultChannel(space), space, name: "Общий", description: "Объявления и вопросы команды", owner: data?.spaces.find((s) => s.id === space)?.owner, general: true, archived: false }] : []);
const currentChannel = () => channelsIn(spaceId).find((c) => c.id === channelId);
const draftKey = () => `${spaceId}/${channelId}/${threadId}`;
const sendingIn = (space = spaceId, channel = channelId, thread = threadId) => [...outbox.values()].some((p) => p.state === 'sending'
  && p.author === data?.me.id && p.hub === appState?.settings.url && p.request.space === space && p.channel === channel && (p.request.thread ?? null) === thread);
const time = (value) => new Date(value).toLocaleTimeString("ru", { hour: "2-digit", minute: "2-digit" });
const badge = (count) => count ? `<b class="unread-badge" aria-label="Непрочитанных сообщений: ${count}">${count > 99 ? '99+' : count}</b>` : '';
function unreadMessages() {
  if (data?.readVersion !== 1) return [];
  return data.messages.filter((m) => m.kind !== 'system' && !(m.kind === 'human' && m.author === data.me.id)
    && m.seq > Math.max(data.readBaseline ?? 0, data.readPositions?.find((p) => p.channel === channelOf(m) && p.thread === m.thread)?.through ?? 0));
}
function markCurrentRead() {
  if (!appState?.connected || data?.readVersion !== 1 || document.visibilityState !== 'visible' || !document.hasFocus() || $('modal').open) return;
  const box = $('messages');
  if (box.scrollHeight - box.scrollTop - box.clientHeight > 30) return;
  const latest = data.messages.filter((m) => m.space === spaceId && channelOf(m) === channelId && m.thread === threadId && m.seq).at(-1);
  const noticeThrough = data.sequence;
  const unseenNotices = data.notices.some((n) => !n.read && n.space === spaceId && channelOf(n) === channelId && n.thread === threadId);
  const key = `${data.me.id}/${channelId}/${threadId}`, before = Math.max(data.readBaseline ?? 0,
    data.readPositions?.find((p) => p.channel === channelId && p.thread === threadId)?.through ?? 0);
  const stamp = `${latest?.seq ?? 0}/${noticeThrough}`;
  if (((latest?.seq ?? 0) <= before && !unseenNotices) || readsInFlight.has(key) || !channelId) return;
  const employee = data.me.id, account = appState.settings.url, channel = channelId, thread = threadId;
  readsInFlight.set(key, stamp);
  void window.hub.call('read', { channel, thread, ...(latest ? { through: latest.id } : {}), noticeThrough }).then(() => {
    if (data.me.id !== employee || appState.settings.url !== account) return;
    if (latest) {
      const positions = data.readPositions ??= [], p = positions.find((p) => p.channel === channel && p.thread === thread);
      if (p) p.through = Math.max(p.through, latest.seq); else positions.push({ employee, channel, thread, through: latest.seq });
    }
    for (const n of data.notices) if (n.seq <= noticeThrough && channelOf(n) === channel && n.thread === thread) n.read = true;
    renderSidebar(); renderTopics();
    // Channel cards carry badges too. Re-render without changing the scroll position.
    renderChat();
  }).catch(() => {}).finally(() => { if (readsInFlight.get(key) === stamp) readsInFlight.delete(key); });
}
let readFrame = 0;
function scheduleRead() { if (!readFrame) readFrame = requestAnimationFrame(() => { readFrame = 0; markCurrentRead(); }); }
window.addEventListener('focus', scheduleRead);
document.addEventListener('visibilitychange', scheduleRead);
$('messages').addEventListener('scroll', scheduleRead, { passive: true });
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
function diagnosticHtml(d, job) {
  const stages = { workspace: "Рабочая папка", version: "Поиск и версия CLI", auth: "Авторизация", run: "Запуск CLI", response: "Обработка ответа" };
  const fields = [["Задание", job || "Проверка подключения"], ["Этап", stages[d.stage] || d.stage], ["Причина", d.code],
    ["Завершение", d.exitCode === null ? "Процесс не завершился штатно / не запущен" : d.exitCode], ["Системная ошибка", d.systemCode || d.signal || "—"],
    ["ОС", `${d.platform} ${d.osVersion} ${d.arch}`], ["Agent Hub", d.appVersion], ["Версия CLI", d.cliVersion], ["Файл CLI", d.binary || "—"], ["Время", new Date(d.at).toLocaleString()]];
  return `<section class="diagnostic"><p><strong>${esc(d.summary)}</strong></p><p>${esc(d.hint)}</p><dl>${fields.map(([k,v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl><h4>Диагностический вывод (stderr)</h4><pre>${esc(d.stderr || "Нет вывода")}</pre><h4>Вывод программы (stdout)</h4><pre>${esc(d.stdout || "Нет вывода")}</pre><p class="hint">${d.outputTruncated ? "Вывод сокращён. " : ""}Известные секреты скрыты; запрос и параметры запуска не сохраняются. Вывод всё же может содержать приватные сведения: проверьте его перед пересылкой. На хабе подробности доступны владельцу агента и оператору хаба в этом спейсе, хранятся до 14 дней (не более 200 отчётов).</p></section>`;
}
function showDiagnostic(jobId) {
  const job = data.jobs.find((j) => j.id === jobId);
  if (job?.diagnostic) openModal("Подробности ошибки", diagnosticHtml(job.diagnostic, jobId));
}
$("modal-close").onclick = closeModal;
function inline(text) {
  return String(text).split(/(`+[^`\n]*`+|\[[^\]\n]+\]\(https?:\/\/[^\s)]+\)|https?:\/\/\S+|^\s*>[^\n]*|^ {4}[^\n]*)/gm).map((part) => {
    if (part.startsWith('`')) return `<code>${esc(part.replace(/^`+|`+$/g, ''))}</code>`;
    const link = /^\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)$/.exec(part);
    if (link) return `<a href="${esc(link[2])}">${esc(link[1])}</a>`;
    if (/^(?:https?:\/\/|\s*>| {4})/.test(part)) return esc(part);
    return esc(part).replace(/@\{([au]):([a-zA-Z0-9._-]+)\}/g, (_m, kind, id) => {
      const option = data && mentionOptions().find((o) => o.kind === kind && o.id === id);
      return option ? `<button type="button" class="mention mention-link" data-mention-kind="${kind}" data-mention-id="${id}" title="Упомянуть в ответе · ${esc(option.sub)}">@${esc(option.title)}</button>` : `<span class="mention">@${esc(name(id))}</span>`;
    }).replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  }).join('').replace(/\n/g, '<br>');
}
function markdown(text) {
  let fence = null, lines = [], result = '';
  const prose = () => { result += lines.join('\n').split(/\n\n/).filter(Boolean).map((p) => `<p>${inline(p)}</p>`).join(''); lines = []; };
  const code = () => { result += `<pre><code>${esc(lines.join('\n'))}</code></pre>`; lines = []; };
  for (const line of String(text).split('\n')) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length && /^\s*$/.test(line.slice(line.indexOf(marker) + marker.length))) { code(); fence = null; }
      else lines.push(line);
    } else if (marker) { prose(); fence = marker; }
    else lines.push(line);
  }
  if (fence) code(); else prose();
  return result;
}
document.addEventListener("click", (event) => {
  const mention = event.target.closest('[data-mention-id]');
  if (mention) {
    const option = mentionOptions().find((o) => o.kind === mention.dataset.mentionKind && o.id === mention.dataset.mentionId);
    const input = $('composer');
    if (option && !input.disabled) {
      const prefix = input.selectionStart && !/\s$/.test(input.value.slice(0, input.selectionStart)) ? ' ' : '';
      input.setRangeText(`${prefix}${option.insert} `, input.selectionStart, input.selectionEnd, 'end');
      drafts.set(draftKey(), input.value); input.focus();
    }
    return;
  }
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
  if (data?.me.id && (value.snapshot?.me.id !== data.me.id || value.settings.url !== appState.settings.url)) { stopTyping(); outbox.clear(); drafts.clear(); readsInFlight.clear(); }
  appState = value; data = value.snapshot;
  if (data) {
    for (const [id, pending] of outbox) {
      if (data.messages.some((m) => m.author === pending.author && (m.clientRequestId === id || m.id === pending.result?.message?.id))) outbox.delete(id);
      else if (pending.result?.thread && data.spaces.some((s) => s.id === pending.request.space) && !data.threads.some((t) => t.id === pending.result.thread.id)) data.threads.push(pending.result.thread);
    }
  }
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
  if ($('modal').open && $('inbox-list')) renderInbox();
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
  const unread = unreadMessages();
  $("spaces").innerHTML = data.spaces.map((s) => `<button class="space-button ${s.id === spaceId ? "active" : ""}" data-space="${s.id}"><span>#</span><span class="space-title">${esc(s.name)}</span>${badge(unread.filter((m) => m.space === s.id).length)}</button>`).join("");
  $("spaces").querySelectorAll("[data-space]").forEach((b) => b.onclick = () => navigate(b.dataset.space, null));
  const primary = primaryAgent(data.me.id);
  $("my-agents").innerHTML = data.agents.filter((a) => a.owner === data.me.id)
    .sort((a, b) => Number(b.id === primary?.id) - Number(a.id === primary?.id)).map((a) => {
    const busy = data.jobs.some((j) => j.agent === a.id && j.status === "running");
    return `<button class="agent-nav" data-agent="${a.id}"><i class="dot ${busy ? "busy" : a.ready && a.enabled ? "ready" : ""}"></i><span>${esc(a.name)}<small>${a.id === primary?.id ? "по умолчанию · " : ""}${a.executor} · ${!a.enabled ? "отключён" : busy ? "работает" : a.ready ? "готов" : "не в сети"}</small></span></button>`;
  }).join("") || '<p class="hint">Подключите первого агента через +</p>';
  $("my-agents").querySelectorAll("[data-agent]").forEach((b) => b.onclick = () => editAgent(b.dataset.agent));
  $("inbox-count").textContent = data.notices.filter((n) => !n.read).length || "";
}
function navigate(space, thread, channel) {
  drafts.set(draftKey(), $("composer").value);
  stopTyping();
  spaceId = space; threadId = thread;
  channelId = thread ? channelOf(data?.threads.find((t) => t.id === thread)) : channel ?? (space ? defaultChannel(space) : null);
  renderKey = ""; draftRequest = null;
  $("composer").value = drafts.get(draftKey()) ?? ""; $("send-error").textContent = "";
  hideMentions();
  if (data) { renderSidebar(); renderTopics(); renderChat(); }
}
function renderTopics() {
  const space = currentSpace(); $("space-name").textContent = space?.name ?? "Создайте спейс";
  $("members").textContent = space ? `${space.members.length} участников · Настроить` : "";
  $("general").classList.toggle("active", !threadId);
  renderChannels();
  const unread = unreadMessages();
  $("threads").innerHTML = data.threads.filter((t) => t.space === spaceId && channelOf(t) === channelId).slice().reverse().map((t) => `<button class="thread-card ${t.id === threadId ? "active" : ""}" data-thread="${t.id}"><div class="thread-title"><strong>${esc(t.title)}</strong>${badge(unread.filter((m) => m.thread === t.id).length)}</div><div class="meta">${threadStatus(t)}<span>${data.messages.filter((m) => m.thread === t.id && m.kind !== "system").length} сообщ.</span></div></button>`).join("");
  $("threads").querySelectorAll("[data-thread]").forEach((b) => b.onclick = () => navigate(spaceId, b.dataset.thread));
}
function renderChannels() {
  const channels = channelsIn(spaceId), selected = currentChannel();
  const unread = unreadMessages();
  const render = (archived) => channels.filter((c) => c.archived === archived).map((c) => {
    const muted = data.channelPreferences?.some((p) => p.channel === c.id && p.muted);
    return `<button class="channel-button ${c.id === channelId ? 'active' : ''}" data-channel="${esc(c.id)}" title="${esc(c.description)}"><span>#</span><strong>${esc(c.name)}</strong>${muted ? '<small>тихо</small>' : ''}${c.archived ? '<small>архив</small>' : ''}${badge(unread.filter((m) => channelOf(m) === c.id).length)}</button>`;
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
  $("general").innerHTML = `← Чат # ${esc(selected?.name ?? 'Общий')} ${badge(unread.filter((m) => channelOf(m) === channelId && !m.thread).length)}`;
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
  return `<article class="message thread-announcement"><span class="avatar">${esc(initials(name(t.owner)))}</span><div class="message-main"><div class="message-head"><strong>${esc(name(t.owner))}</strong><span class="agent-tag">НАЧАЛ ОБСУЖДЕНИЕ</span><time>${time(card.createdAt)}</time></div><button type="button" class="thread-link-card" data-open-thread="${esc(t.id)}" aria-label="Открыть тред: ${esc(t.title)}. ${esc(labels[t.status] ?? t.status)}. Ответов: ${card.replies}"><span class="thread-link-label">↗ ОБСУЖДЕНИЕ В ТРЕДЕ ${badge(unreadMessages().filter((m) => m.thread === t.id).length)}</span><strong>${esc(t.title)}</strong>${preview ? `<span class="thread-link-preview">${esc(preview)}</span>` : ""}<span class="thread-link-meta">${threadStatus(t)}<span>Ответов: ${card.replies}</span><span class="thread-link-open">Открыть тред →</span></span></button></div></article>`;
}
function participationHtml(p, thread) {
  const agent = data.agents.find((a) => a.id === p.agent), owner = agent?.owner === data.me.id;
  const pending = Boolean(p.request) && ['pending', 'denied'].includes(p.status);
  const source = data.messages.find((m) => m.id === p.request?.sourceMessage);
  const disabled = decisionsInFlight.has(p.id) || !appState.connected || currentChannel()?.archived;
  const button = (action, label, runs) => `<button type="button" class="${action === 'allow' ? 'primary' : 'quiet'}" data-participation="${esc(p.id)}" data-action="${action}" ${runs ? `data-runs="${runs}"` : ''} ${disabled ? 'disabled' : ''}>${label}</button>`;
  return `<section class="participation-card ${p.status}" aria-label="Участие ${esc(name(p.agent))}"><div class="participation-heading"><strong>${esc(name(p.agent))}</strong><span>${p.status === 'pending' ? 'Ожидает разрешения' : p.status === 'denied' ? 'Участие отклонено' : p.status === 'revoked' ? 'Разрешение отозвано' : `Доступно запусков: ${p.remaining}`}</span></div><p class="hint">Владелец: ${esc(name(agent?.owner))} · По разрешениям использовано: ${p.used}</p>${pending ? `<p>Инициатор: ${esc(name(p.request.requestedBy))}${source?.kind === 'agent' ? ` · Передал: ${esc(name(source.author))}` : ''}</p><blockquote>${esc(friendly(source?.content ?? 'Откройте контекст обсуждения выше.').slice(0, 600))}</blockquote><p class="hint">До подтверждения модель не запускается. Разрешение действует только на этого агента в этом треде, в режиме разбора.</p>` : ''}<div class="participation-actions">${owner && pending ? `${button('allow', 'Один ответ', 1)}${button('allow', p.used ? 'Продолжить ещё на 3 запуска' : 'Разрешить обсуждение · 3 запуска', 3)}${p.status !== 'denied' ? button('deny', 'Отклонить') : ''}` : pending ? `<p class="hint">Решение принимает ${esc(name(agent?.owner))}.</p>` : ''}${owner && p.status === 'allowed' ? button('revoke', 'Отозвать и остановить') : ''}</div>${owner && pending ? '<p class="hint">Лимит резервируется при постановке задания в очередь. Ошибки не возвращают запуск. Один запуск — одна задача, иногда со сжатием контекста; это не лимит токенов.</p>' : ''}</section>`;
}
async function decideParticipation(button) {
  const p = data.participations?.find((p) => p.id === button.dataset.participation), thread = currentThread();
  if (!p || !thread || decisionsInFlight.has(p.id)) return;
  const body = { id: p.id, revision: p.revision, threadRevision: thread.revision, action: button.dataset.action, runs: Number(button.dataset.runs), requestId: crypto.randomUUID() };
  decisionsInFlight.add(p.id); renderChat();
  try { await window.hub.call('participation', body); }
  catch (error) { toast(errorText(error)); }
  finally { decisionsInFlight.delete(p.id); renderChat(); }
}
function executableAgentReply(message, messages) {
  if (message.kind !== 'agent' || !message.thread) return null;
  const agent = data.agents.find((a) => a.id === message.author);
  if (!agent || agent.owner !== data.me.id) return null;
  const last = messages.filter((m) => m.kind !== 'system').at(-1);
  if (last?.id !== message.id) return null;
  const sourceJob = message.agentJob
    ? data.jobs.find((j) => j.id === message.agentJob)
    : data.jobs.filter((j) => j.thread === message.thread && j.agent === agent.id && j.createdAt <= message.createdAt).at(-1);
  return sourceJob?.mode === 'read' && sourceJob.status === 'done' ? agent : null;
}
async function executeProposal(button) {
  const message = button.dataset.execute, thread = currentThread();
  if (!message || !thread || executionsInFlight.has(message)) return;
  executionsInFlight.add(message); renderChat();
  try {
    const result = await window.hub.call('execute', { message, threadRevision: thread.revision, requestId: crypto.randomUUID() });
    if (result.message && !data.messages.some((m) => m.id === result.message.id)) data.messages.push(result.message);
    if (result.thread) Object.assign(thread, result.thread);
  } catch (error) { toast(errorText(error)); }
  finally { executionsInFlight.delete(message); renderChat(); }
}
function renderChat() {
  const thread = currentThread(), space = currentSpace(), channel = currentChannel();
  const archived = channel?.archived === true;
  $("chat-title").textContent = thread?.title ?? (channel ? `# ${channel.name}` : "Добро пожаловать в Agent Hub");
  $("chat-eyebrow").textContent = thread ? `${space?.name ?? ""} / # ${channel?.name ?? "Общий"} / ТРЕД` : `${space?.name ?? ""} / КАНАЛ`;
  $("chat-subtitle").innerHTML = thread ? `${threadStatus(thread)} &nbsp; Начал ${esc(name(thread.owner))}` : esc(channel?.description || "Обсуждения команды. Один вопрос — один тред.");
  $("thread-actions").classList.toggle("hidden", !thread);
  $("resolve").textContent = thread?.status === "resolved" ? "↺ Открыть" : "✓ Завершить";
  const pending = [...outbox.values()].filter((p) => p.request.space === spaceId && p.channel === channelId && (p.result?.message?.thread ?? p.request.thread ?? null) === threadId
    && !data.messages.some((m) => m.author === p.author && (m.clientRequestId === p.id || m.id === p.result?.message?.id)))
    .map((p) => ({ id: p.result?.message?.id ?? p.id, space: p.request.space, channel: p.channel, thread: p.request.thread, kind: "human", author: p.author,
      content: p.request.content, createdAt: p.createdAt, delivery: p.state, deliveryError: p.error, requestId: p.id }));
  const messages = [...data.messages.filter((m) => m.space === spaceId && channelOf(m) === channelId && m.thread === threadId), ...pending];
  const cards = threadId ? [] : generalThreadCards();
  const jobs = data.jobs.filter((j) => j.thread === threadId && ["queued", "running"].includes(j.status));
  const needsPerson = thread && ["waiting", "paused"].includes(thread.status);
  const participations = data.participations?.filter((p) => p.thread === threadId) ?? [];
  const approval = participations.find((p) => p.request && p.status === 'pending');
  $("job-status").classList.toggle("hidden", !archived && !jobs.length && !needsPerson);
  $("job-status").textContent = archived ? "Канал в архиве: история доступна для чтения. Восстановите канал в его настройках, чтобы продолжить." : jobs.length ? jobs.map((j) => `${name(j.agent)} ${j.status === "queued" ? "ожидает свободного раннера" : "работает с контекстом треда"} · ${j.mode === "write" ? "изменения" : "разбор"}`).join(" · ") : needsPerson ? "Чтобы продолжить: напишите ответ или уточнение и укажите через @ агента, который должен подхватить разбор." : "";
  if (!archived && approval && !jobs.length) $('job-status').textContent = `${name(approval.agent)} ожидает разрешения владельца. Модель пока не запускается.`;
  renderTyping();
  document.querySelector(".composer-hint").innerHTML = thread ? "@агент — продолжить разбор · без @ — добавить контекст · @сотрудник — уведомить <span>⌘ / Ctrl + Enter</span>" : "@сотрудник — уведомить · @агент — создать тред · без @ — обычный чат <span>⌘ / Ctrl + Enter</span>";
  for (const id of ["send", "composer", "mode", "mention-button", "new-thread", "stop", "resolve"]) $(id).disabled = archived || !space || !appState.connected;
  const sending = sendingIn();
  $('send').disabled ||= sending;
  $('send').textContent = sending ? 'Отправляется…' : 'Отправить ↑';
  $('send').setAttribute('aria-busy', String(sending));
  $('new-thread').disabled ||= sendingIn(spaceId, channelId, null);
  $("follow-thread").classList.toggle("hidden", !thread || !channelSupport);
  const following = data.threadSubscriptions?.some((f) => f.thread === threadId && f.following) ?? false;
  $("follow-thread").textContent = following ? "✓ Вы подписаны на тред" : "Подписаться на тред";
  $("follow-thread").setAttribute("aria-pressed", String(following));
  const key = JSON.stringify([spaceId, channelId, threadId, messages, cards, thread?.memory, thread?.revision, participations, [...decisionsInFlight], [...executionsInFlight], data.readPositions, data.employees, data.agents.map((a) => [a.id, a.name, a.owner, a.allowWrite]), data.jobs.filter((j) => j.thread === threadId).map((j) => [j.id,j.status,j.mode,Boolean(j.diagnostic)])]);
  if (key === renderKey) { scheduleRead(); return; }
  const previousTop = $('messages').scrollTop;
  const wasNearBottom = $("messages").scrollHeight - $("messages").scrollTop - $("messages").clientHeight < 110;
  const switched = !renderKey; renderKey = key;
  const entries = [...messages.map((message) => ({ message, createdAt: message.createdAt, id: message.id })),
    ...cards.map((card) => ({ card, createdAt: card.createdAt, id: card.thread.id }))]
    .sort((a, b) => a.createdAt - b.createdAt);
  $("messages").innerHTML = entries.map((entry) => {
    if (entry.card) return renderThreadCard(entry.card);
    const m = entry.message;
    if (m.kind === "system") return `<div class="system">${inline(m.content)}${m.diagnosticJob ? (data.jobs.some((j) => j.id === m.diagnosticJob && j.diagnostic) ? ` <button class="quiet diagnostic-button" data-diagnostic="${esc(m.diagnosticJob)}">Подробности ошибки</button>` : '<br><small>Подробности доступны владельцу агента / оператору хаба, если срок хранения не истёк.</small>') : ""}</div>`;
    const agent = data.agents.find((a) => a.id === m.author);
    const executable = executableAgentReply(m, messages);
    const executing = executionsInFlight.has(m.id);
    const executeAction = executable ? `<div class="message-actions"><button type="button" class="primary" data-execute="${esc(m.id)}" ${executing || archived || !appState.connected || !executable.allowWrite ? 'disabled' : ''}>${executing ? 'Запускаю…' : 'Действуй — внести изменения'}</button><small>${executable.allowWrite ? 'Агент начнёт работу в отдельной Git-копии. Коммиты и push не выполняются.' : 'Сначала включите разрешение на изменения в настройках агента.'}</small></div>` : '';
    const delivery = m.delivery === "sending" ? '<span class="delivery sending" role="status">Отправляется…</span>' : m.delivery === "failed" ? '<span class="delivery failed" role="status">Отправка не подтверждена</span>' : m.author === data.me.id && m.kind === "human" ? '<span class="delivery sent" title="Принято хабом — это не отметка о прочтении">✓ Отправлено</span>' : '';
    return `<article class="message ${m.kind} ${m.delivery ?? ''}" data-message="${esc(m.id)}"><span class="avatar">${esc(initials(name(m.author)))}</span><div class="message-main"><div class="message-head"><strong>${esc(name(m.author))}</strong>${agent ? `<span class="agent-tag">АГЕНТ · ${esc(name(agent.owner))}</span>` : ""}<time>${time(m.createdAt)}</time>${delivery}</div><div class="message-body">${markdown(m.content)}</div>${executeAction}${m.delivery === 'failed' ? `<div class="delivery-error">${esc(m.deliveryError)} <button type="button" class="quiet" data-retry="${esc(m.requestId)}">Повторить отправку</button><small>Повтор использует тот же идентификатор и не запускает агента второй раз. Сообщение остаётся здесь, пока приложение открыто.</small></div>` : ''}</div></article>`;
  }).join("") || `<div class="empty"><div class="symbol">${space ? "↗" : "✳"}</div><h3>${space ? "Начните с вопроса" : "Команда начинается со спейса"}</h3><p>${space ? "Напишите коллеге или вызовите агента через @. Он увидит историю этого треда и сможет подключить другого агента." : "Создайте пространство, добавьте коллег и подключите своих агентов. Никаких заданных ролей."}</p></div>`;
  $("messages").querySelectorAll("[data-open-thread]").forEach((button) => button.onclick = () => navigate(spaceId, button.dataset.openThread));
  $("messages").querySelectorAll("[data-diagnostic]").forEach((button) => button.onclick = () => showDiagnostic(button.dataset.diagnostic));
  $("messages").querySelectorAll("[data-execute]").forEach((button) => button.onclick = () => void executeProposal(button));
  $("messages").querySelectorAll("[data-retry]").forEach((button) => {
    button.disabled = sending || archived || !appState.connected;
    button.onclick = () => { const pending = outbox.get(button.dataset.retry); if (pending) void deliverPost(pending); };
  });
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
  if (thread && participations.length) {
    const panel = document.createElement('div'); panel.className = 'participation-list';
    panel.innerHTML = participations.map((p) => participationHtml(p, thread)).join('');
    panel.querySelectorAll('[data-participation]').forEach((button) => button.onclick = () => void decideParticipation(button));
    $('messages').append(panel);
  }
  // Native immediate positioning, before paint. Never animate the entire history.
  $('messages').scrollTo({ top: switched || wasNearBottom ? $('messages').scrollHeight : previousTop, behavior: 'instant' });
  scheduleRead();
}

function primaryAgent(owner) {
  const owned = data?.agents.filter((a) => a.owner === owner) ?? [];
  return owned.find((a) => a.primary) ?? owned[0];
}
function mentionOptions() {
  const members = currentSpace()?.members ?? [];
  const colleagues = data.employees.filter((e) => e.id !== data.me.id && members.includes(e.id));
  const peerAgents = colleagues.map((employee) => primaryAgent(employee.id)).filter((agent) => agent?.enabled);
  const ownPrimary = primaryAgent(data.me.id);
  // Colleagues do not choose between another employee's local executors. They
  // address that employee's default; owners retain explicit access to all of theirs.
  const ownAgents = data.agents.filter((a) => a.owner === data.me.id && a.enabled)
    .sort((a, b) => Number(b.id === ownPrimary?.id) - Number(a.id === ownPrimary?.id));
  return [
    ...colleagues.map((e) => ({ id: e.id, kind: "u", title: e.name, insert: `@«${e.name}»`, sub: "Сотрудник · отправить уведомление" })),
    ...peerAgents.map((a) => ({ id: a.id, kind: "a", title: a.name, insert: `@«${name(a.owner)} / ${a.name}»`, sub: `${name(a.owner)} · агент по умолчанию · ${a.ready ? "готов" : "не в сети"}` })),
    ...ownAgents.map((a) => ({ id: a.id, kind: "a", title: a.name, insert: `@«${name(a.owner)} / ${a.name}»`, sub: `Ваш агент${a.id === ownPrimary?.id ? " · по умолчанию" : ""} · ${a.executor} · ${a.ready ? "готов" : "не в сети"}` })),
  ];
}
function hideMentions() {
  $('mention-picker').classList.add('hidden');
  $('composer').setAttribute('aria-expanded', 'false'); $('composer').removeAttribute('aria-activedescendant');
  mentionStart = mentionEnd = null; mentionIndex = -1; visibleMentions = [];
}
function highlightMention(index) {
  mentionIndex = visibleMentions.length ? (index + visibleMentions.length) % visibleMentions.length : -1;
  $('mention-picker').querySelectorAll('[data-index]').forEach((button, i) => {
    button.classList.toggle('active', i === mentionIndex); button.setAttribute('aria-selected', String(i === mentionIndex));
    if (i === mentionIndex) { $('composer').setAttribute('aria-activedescendant', button.id); button.scrollIntoView({ block: 'nearest' }); }
  });
  if (mentionIndex < 0) $('composer').removeAttribute('aria-activedescendant');
}
function chooseMention(index) {
  const option = visibleMentions[index], input = $('composer');
  if (option && mentionStart !== null && mentionEnd !== null && !input.disabled && mentionOptions().some((o) => o.kind === option.kind && o.id === option.id)) {
    input.setRangeText(`${option.insert} `, mentionStart, mentionEnd, 'end');
    drafts.set(draftKey(), input.value);
    updateTyping();
  }
  hideMentions(); input.focus();
}
function showMentions(forced = false) {
  if (!data || !spaceId || $('composer').disabled) { hideMentions(); return; }
  const before = $("composer").value.slice(0, $("composer").selectionStart);
  const match = /(?:^|\s)@([^@«\n]*)$/.exec(before);
  if (!match && !forced) { hideMentions(); return; }
  const query = forced ? "" : match[1].toLowerCase();
  mentionStart = match ? before.lastIndexOf("@") : $("composer").selectionStart;
  mentionEnd = $('composer').selectionEnd;
  visibleMentions = mentionOptions().filter((o) => `${o.title} ${o.sub}`.toLowerCase().includes(query));
  $("mention-picker").innerHTML = visibleMentions.map((o, index) => `<button type="button" role="option" tabindex="-1" id="mention-option-${index}" class="mention-option" data-index="${index}"><span class="avatar">${o.kind === "a" ? "↗" : esc(initials(o.title))}</span><span>${esc(o.title)}<small>${esc(o.sub)}</small></span></button>`).join("") || '<div class="hint">Нет подходящих участников. Добавьте коллегу в спейс.</div>';
  $("mention-picker").classList.remove("hidden");
  $('composer').setAttribute('aria-expanded', 'true'); highlightMention(0);
  $("mention-picker").querySelectorAll("button").forEach((button) => {
    button.onpointerdown = (event) => event.preventDefault();
    button.onpointermove = () => highlightMention(Number(button.dataset.index));
    button.onclick = () => chooseMention(Number(button.dataset.index));
  });
}
function encodeMentions(text) { for (const option of mentionOptions()) text = text.split(option.insert).join(`@{${option.kind}:${option.id}}`); return text; }
function nextTypingVersion() { typingVersion = Math.max(Date.now(), typingVersion + 1); return typingVersion; }
function sameTypingContext(left, right) { return left && right && left.space === right.space && left.channel === right.channel && left.thread === right.thread; }
function sendTyping(context, active) {
  if (!context || !window.hub.typing) return;
  void window.hub.typing({ ...context, active, version: nextTypingVersion() }).catch(() => {});
}
function stopTyping() {
  clearTimeout(typingStopTimer); typingStopTimer = 0;
  const context = typingContext, active = typingActive;
  typingContext = null; typingActive = false; typingLastSent = 0;
  if (active) sendTyping(context, false);
}
function updateTyping() {
  const context = spaceId && channelId ? { space: spaceId, channel: channelId, thread: threadId } : null;
  if (!$("composer").value.trim() || !appState?.connected || currentChannel()?.archived || !context) { stopTyping(); return; }
  if (typingContext && !sameTypingContext(typingContext, context)) stopTyping();
  typingContext = context;
  const now = Date.now();
  if (!typingActive || now - typingLastSent >= 2_000) { typingActive = true; typingLastSent = now; sendTyping(context, true); }
  clearTimeout(typingStopTimer); typingStopTimer = setTimeout(stopTyping, 3_000);
}
function renderTyping() {
  const active = (appState?.typing ?? []).filter((entry) => entry.employee !== data?.me.id && entry.active && entry.expiresAt > Date.now()
    && entry.space === spaceId && entry.channel === channelId && entry.thread === threadId);
  const people = [...new Set(active.map((entry) => name(entry.employee)))];
  $("typing-status").classList.toggle("hidden", !people.length);
  $("typing-status").textContent = people.length === 1 ? `${people[0]} печатает…` : people.length === 2 ? `${people[0]} и ${people[1]} печатают…` : people.length ? `${people.slice(0, 2).join(", ")} и ещё ${people.length - 2} печатают…` : "";
}
$("composer").addEventListener("input", () => { showMentions(); updateTyping(); });
window.addEventListener("blur", stopTyping);
$('composer').setAttribute('role', 'combobox');
$('composer').setAttribute('aria-autocomplete', 'list'); $('composer').setAttribute('aria-controls', 'mention-picker'); $('composer').setAttribute('aria-expanded', 'false');
$('mention-picker').setAttribute('role', 'listbox'); $('mention-picker').setAttribute('aria-label', 'Адресаты');
$('composer').addEventListener('blur', hideMentions);
$('composer').addEventListener('click', () => showMentions());
document.addEventListener('pointerdown', (event) => {
  if (!event.target.closest('#composer, #mention-picker, #mention-button')) hideMentions();
});
$("composer").addEventListener("keydown", (event) => {
  if (event.isComposing || event.keyCode === 229) return;
  if (!$('mention-picker').classList.contains('hidden')) {
    if (['ArrowDown', 'ArrowUp'].includes(event.key) && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault(); highlightMention(mentionIndex + (event.key === 'ArrowDown' ? 1 : -1)); return;
    }
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); chooseMention(mentionIndex); return; }
    if (event.key === 'Escape') { event.preventDefault(); hideMentions(); return; }
    if (['Tab', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) hideMentions();
  }
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); $("composer-form").requestSubmit(); }
});
$("mention-button").onclick = () => { $("composer").focus(); showMentions(true); };
function queuePost(request) {
  if (sendingIn(request.space, channelId, request.thread ?? null)) return;
  const pending = { id: crypto.randomUUID(), author: data.me.id, hub: appState.settings.url, request, channel: channelId,
    createdAt: Date.now(), state: "queued", error: "", result: null };
  outbox.set(pending.id, pending);
  void deliverPost(pending);
}
async function deliverPost(pending) {
  if (pending.state === "sending" || sendingIn(pending.request.space, pending.channel, pending.request.thread ?? null)) return;
  pending.state = "sending"; pending.error = ""; renderChat();
  $("messages").scrollTop = $("messages").scrollHeight;
  try {
    const result = await window.hub.call("post", { ...pending.request, requestId: pending.id });
    if (data?.me.id !== pending.author || appState.settings.url !== pending.hub) return;
    pending.result = result; pending.state = "sent";
    if (data.spaces.some((s) => s.id === pending.request.space)) {
      if (result.thread && !data.threads.some((t) => t.id === result.thread.id)) data.threads.push(result.thread);
      if (result.message && !data.messages.some((m) => m.id === result.message.id)) data.messages.push(result.message);
      // Do not redirect someone who switched channels or started their next draft.
      if (!pending.request.thread && result.thread && spaceId === pending.request.space && channelId === pending.channel && !threadId && !$("composer").value) navigate(spaceId, result.thread.id, pending.channel);
    }
  } catch (error) {
    pending.state = "failed"; pending.error = errorText(error);
    if (!outbox.has(pending.id)) return; // A poll already confirmed acceptance.
    if (spaceId !== pending.request.space || channelId !== pending.channel) toast("Отправка сообщения не подтверждена. Оно сохранено в исходном чате с кнопкой повтора.");
  }
  if (data?.me.id === pending.author && appState.settings.url === pending.hub) { renderTopics(); renderChat(); }
}
$("composer-form").onsubmit = (event) => {
  event.preventDefault();
  if (sendingIn()) return;
  const content = encodeMentions($("composer").value.trim()); if (!content) return;
  if (!spaceId || !appState.connected || currentChannel()?.archived) { $("send-error").textContent = "Нет подключения к хабу или канал в архиве. Текст сохранён в поле ввода."; return; }
  const request = { space: spaceId, ...(channelSupport ? { channel: channelId } : {}), thread: threadId, content, mode: $("mode").value };
  stopTyping();
  $("composer").value = ""; drafts.delete(draftKey()); $("send-error").textContent = ""; hideMentions();
  queuePost(request); $("composer").focus();
};
$("general").onclick = () => navigate(spaceId, null, channelId);
$("thread-actions").prepend($("follow-thread"));
$("stop").onclick = () => void safely(() => window.hub.call("thread-state", { thread: threadId, status: "paused" }), "send-error");
$("resolve").onclick = () => void safely(() => window.hub.call("thread-state", { thread: threadId, status: currentThread()?.status === "resolved" ? "open" : "resolved" }), "send-error");
$("new-thread").onclick = () => {
  if (!spaceId) return toast("Сначала создайте спейс");
  if (sendingIn(spaceId, channelId, null)) return toast('Дождитесь подтверждения отправки в этот канал.');
  if (currentChannel()?.archived) return toast("Сначала восстановите канал из архива");
  openModal("Новый тред", '<form id="thread-form"><label>Тема<input id="thread-title" required maxlength="160" placeholder="Например: контракт новой геймификации"></label><label>С чего начнём?<textarea id="thread-message" rows="5" required placeholder="Опишите вопрос, добавьте ссылки на Jira, Confluence или PR"></textarea></label><p class="hint">После создания вызовите нужного агента через @ в строке сообщения.</p><div class="modal-actions"><button class="primary">Создать тред</button></div></form>');
  $("thread-form").onsubmit = (e) => { e.preventDefault();
    if (sendingIn(spaceId, channelId, null)) { $('modal-error').textContent = 'Дождитесь подтверждения предыдущей отправки. Текст сохранён.'; return; }
    if (!appState.connected || currentChannel()?.archived) { $("modal-error").textContent = "Нет подключения или канал в архиве. Текст не отправлен."; return; }
    const request = { space: spaceId, ...(channelSupport ? { channel: channelId } : {}), title: $("thread-title").value, content: $("thread-message").value, newThread: true };
    closeModal(); navigate(spaceId, null, channelId); queuePost(request);
  };
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
  const defaultAgent = primaryAgent(data.me.id), isPrimary = agent ? defaultAgent?.id === agent.id : !defaultAgent;
  const localAgents = appState.settings.agents.slice().sort((a, b) => Number(b.id === defaultAgent?.id) - Number(a.id === defaultAgent?.id));
  openModal(agent ? `Настройки · ${agent.name}` : "Подключить агента", `<form id="agent-form"><div class="agent-editor-header"><label>Имя агента<input id="agent-name" required maxlength="80" value="${esc(agent?.name ?? "")}" placeholder="Например: Backend reviewer"></label><label>Исполнитель<select id="agent-executor">${["codex", "claude", "cursor"].map((p) => `<option value="${p}" ${agent?.executor === p ? "selected" : ""}>${p === "claude" ? "Claude Code" : p === "cursor" ? "Cursor CLI" : "Codex"}</option>`).join("")}</select></label></div><label>Рабочая папка<div class="row"><input id="agent-directory" required value="${esc(agent?.directory ?? "")}" placeholder="Папка проекта или документов"><button type="button" id="choose-directory">Выбрать</button></div></label><label>Описание и контекст<textarea id="agent-description" rows="3" placeholder="С чем работает агент, какие вопросы ему адресовать">${esc(agent?.description ?? "")}</textarea></label><label class="check"><input id="agent-primary" type="checkbox" ${isPrimary ? "checked" : ""} ${isPrimary && agent ? "disabled" : ""}> Агент по умолчанию для входящих обращений</label>${isPrimary && agent ? '<p class="hint">Чтобы сменить агента по умолчанию, откройте другой агент и включите этот пункт.</p>' : ''}<label>Резервный агент<select id="agent-fallback"><option value="">Не назначен — показать ошибку в треде</option>${localAgents.filter((a) => a.id !== id).map((a) => `<option value="${a.id}" ${agent?.fallback === a.id ? "selected" : ""}>${esc(a.name)}${a.id === defaultAgent?.id ? " · по умолчанию" : ""}</option>`).join("")}</select></label><details><summary class="hint">Путь к исполняемому файлу CLI (если не найден автоматически)</summary><label><div class="row"><input id="agent-binary" value="${esc(agent?.binary ?? "")}" placeholder="Автоматически"><button type="button" id="choose-binary">Выбрать</button></div></label></details><label class="check"><input id="agent-enabled" type="checkbox" ${agent?.enabled !== false ? "checked" : ""}> Разрешить участникам спейсов запрашивать участие агента</label><label class="check"><input id="agent-write" type="checkbox" ${agent?.allowWrite ? "checked" : ""}> Разрешить мне запускать изменения в отдельной Git-копии</label><p class="hint">Коллеги и их агенты видят одно агентское обращение к вам: хаб направляет его агенту по умолчанию. Настроенный резерв включается только при недоступности основного. Чужие обращения и автоматические передачи требуют вашего разрешения на 1 или 3 задачи в треде. Резервному агенту нужно отдельное разрешение. Сохранение настроек отзывает текущие разрешения. Вход в аккаунт — через установленный CLI. Обсуждения и ответы передаются провайдеру агента и участникам спейса. Для изменений нужен Git-репозиторий. Push, merge и деплой приложение не выполняет. CLI-интеграции и их разрешения настраиваются отдельно.</p><p id="agent-health" class="inline-state"></p><div class="modal-actions"><button id="check-agent" type="button" class="quiet">Проверить подключение</button><button class="primary">Сохранить агента</button></div></form>`);
  const input = () => ({ id: agent?.id ?? "", name: $("agent-name").value, executor: $("agent-executor").value, directory: $("agent-directory").value, description: $("agent-description").value, binary: $("agent-binary").value, fallback: $("agent-fallback").value || null, primary: $("agent-primary").checked, enabled: $("agent-enabled").checked, allowWrite: $("agent-write").checked });
  $("choose-directory").onclick = async () => { const path = await window.hub.directory(); if (path) $("agent-directory").value = path; };
  $("choose-binary").onclick = async () => { const path = await window.hub.binary(); if (path) $("agent-binary").value = path; };
  $("check-agent").onclick = () => void safely(async () => {
    const output = $("agent-health"), button = $("check-agent");
    output.textContent = "Проверяем папку, установку и авторизацию…"; button.disabled = true;
    try {
      const result = await window.hub.checkAgent(input());
      if (!output.isConnected) return;
      output.innerHTML = `${result.ok === false ? '✕' : '✓'} ${esc(result.detail)}${result.diagnostic ? `<details><summary>Подробности ошибки</summary>${diagnosticHtml(result.diagnostic)}</details>` : ''}`;
    } catch (error) { if (output.isConnected) output.textContent = `✕ ${errorText(error)}`; }
    finally { button.disabled = false; }
  });
  $("agent-form").onsubmit = (e) => { e.preventDefault(); void safely(async () => { await window.hub.saveAgent(input()); closeModal(); toast("Агент сохранён. Проверяем готовность раннера."); }); };
}
$("settings").onclick = () => {
  openModal("Настройки", `<div class="settings-section"><form id="profile-form"><label>Ваше имя<div class="row"><input id="profile-name" value="${esc(data.me.name)}" required maxlength="80"><button>Сохранить</button></div></label></form><p class="hint">Хаб: ${esc(appState.settings.url)}<br>Agent Hub ${esc(appState.version)} · ${esc(data.me.id)}</p><div class="divider"></div><h3>Оформление</h3><label>Тема приложения<select data-theme-choice aria-label="Тема приложения"><option value="system">Как в системе</option><option value="light">Светлая</option><option value="dark">Тёмная</option></select></label><p class="hint">Сохраняется на этом компьютере. «Как в системе» автоматически следует оформлению ОС.</p><div class="divider"></div><h3>Системные уведомления</h3><label class="check"><input id="notifications-toggle" type="checkbox" ${appState.settings.notifications ? "checked" : ""}> Упоминания, ответы, ошибки и запросы решения</label><p class="hint">Содержание кода и переписки не показывается на экране блокировки. Закрытие окна сворачивает приложение в трей — агенты продолжают работать. «Выйти» останавливает их. Автозапуска пока нет.</p><button id="notification-test" class="quiet">Отправить тестовое уведомление</button><div class="divider"></div><h3>Приглашения</h3><p class="hint">Пригласите сразу команду в свой спейс или одного коллегу лично. Уже есть приглашение в другой спейс? Вступите под текущим аккаунтом.</p><button id="open-invitations" ${appState.settings.local ? "disabled" : ""}>Пригласить команду / вступить в спейс</button>${appState.settings.local ? '<p class="hint">Для приглашений с других компьютеров нужен удалённый HTTPS-хаб.</p>' : ''}</div>`);
  applyTheme();
  $("profile-form").onsubmit = (e) => { e.preventDefault(); void safely(async () => { await window.hub.call("profile", { name: $("profile-name").value }); toast("Имя сохранено"); }); };
  $("notifications-toggle").onchange = () => void safely(() => window.hub.preferences({ notifications: $("notifications-toggle").checked }));
  const notificationStatus = document.createElement('p'); notificationStatus.id = 'notification-status'; notificationStatus.className = 'hint'; notificationStatus.setAttribute('role', 'status');
  notificationStatus.textContent = appState.health?.notifications?.detail ?? 'Тест проверит ответ системы. Разрешение и показ баннеров управляются настройками macOS / Windows.';
  $('notification-test').after(notificationStatus);
  $('notification-test').disabled = appState.notificationsSupported === false;
  $('notification-test').onclick = async () => {
    const button = $('notification-test'), output = $('notification-status');
    if (button.disabled) return;
    button.disabled = true; button.textContent = 'Ждём ответ системы…'; button.setAttribute('aria-busy', 'true');
    output.textContent = 'Отправляем тест. Если macOS спросит разрешение, выберите нужный вариант в системном окне.';
    try { const result = await window.hub.testNotification(); output.textContent = result?.detail ?? 'Система не вернула результат проверки. Обновите приложение.'; }
    catch (error) { output.textContent = errorText(error); }
    finally { button.disabled = appState.notificationsSupported === false; button.textContent = 'Отправить тестовое уведомление'; button.setAttribute('aria-busy', 'false'); }
  };
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
function renderInbox() {
  const notices = data.notices.slice().reverse(), unread = notices.filter((n) => !n.read), seen = notices.filter((n) => n.read);
  const render = (items) => items.slice(0, 100).map((n) => `<button class="inbox-item ${n.read ? 'read' : 'unread'}" data-notice="${n.seq}"><strong>${esc(n.title)}</strong><small>${esc(friendly(n.body))}</small></button>`).join('');
  const expanded = $('read-notices')?.open ?? false, through = data.sequence;
  $('modal-content').innerHTML = `<section id="inbox-list"><div class="inbox-actions"><button id="read-all-notices" class="quiet" ${!unread.length || data.readVersion !== 1 ? 'disabled' : ''}>Отметить все прочитанными</button><button id="clear-read-notices" class="quiet" ${!seen.length || data.readVersion !== 1 ? 'disabled' : ''}>Очистить прочитанные</button></div><h3>Новые · ${unread.length}</h3>${render(unread) || '<p class="hint">Новых уведомлений нет.</p>'}<details id="read-notices" ${expanded ? 'open' : ''}><summary>Прочитанные · ${seen.length}</summary>${render(seen)}</details><p class="hint">Показано до 100 в каждой группе. Очистка затрагивает только ваши уведомления — сообщения и запросы согласования останутся. Отметка уведомлений не помечает переписку прочитанной.</p></section>`;
  $('modal-content').querySelectorAll('[data-notice]').forEach((b) => b.onclick = () => { const n = notices.find((n) => n.seq === Number(b.dataset.notice)); closeModal(); navigate(n.space, n.thread, n.channel); });
  for (const [id, action] of [['read-all-notices', 'read'], ['clear-read-notices', 'clear-read']]) $(id).onclick = () => {
    $(id).disabled = true;
    void window.hub.call('notices', { action, through }).then(() => { if ($('modal').open && $('inbox-list')) renderInbox(); }).catch((e) => { toast(errorText(e)); if ($('modal').open && $('inbox-list')) renderInbox(); });
  };
}
$('inbox').onclick = () => { openModal('Уведомления', ''); renderInbox(); };
$("connect-form").onsubmit = (e) => { e.preventDefault(); void safely(async () => { const result = await window.hub.connect({ url: $("hub-url").value.trim(), credential: $("credential").value.trim(), name: $("join-name").value.trim(), type: $("raw-token").checked ? "token" : "invite" }); $("credential").value = ""; receive(result); }, "connect-error"); };
$("local-test").onclick = () => void safely(async () => receive(await window.hub.local()), "connect-error");
window.hub.onChanged(receive);
window.hub.onNavigate(({ space, thread, channel }) => navigate(space, thread, channel));
void window.hub.state().then(receive);
