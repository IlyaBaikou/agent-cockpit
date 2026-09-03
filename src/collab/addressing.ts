export type Mention = { kind: "a" | "u"; id: string };

// Preserve offsets/line breaks. Examples, quotations and URLs must not call agents.
export function addressingText(content: string): string {
  const blank = (value: string): string => value.replace(/[^\n]/g, " ");
  let fence: string | undefined;
  return content.split("\n").map((line) => {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length && /^\s*$/.test(line.slice(line.indexOf(marker) + marker.length))) fence = undefined;
      return blank(line);
    }
    if (marker) { fence = marker; return blank(line); }
    if (/^(?:\s*>| {4}|\t)/.test(line)) return blank(line);
    return line.replace(/(`+)[\s\S]*?\1/g, blank)
      .replace(/\[[^\]]*\]\([^)]*\)/g, blank)
      .replace(/https?:\/\/\S+/g, blank);
  }).join("\n");
}

export function mentions(content: string): Mention[] {
  return [...addressingText(content).matchAll(/@\{([au]):([a-zA-Z0-9._-]+)\}/g)]
    .map((m) => ({ kind: m[1] as Mention["kind"], id: m[2]! }));
}

export function addressReply(content: string, requester: string, self: string, members: string[], agents: string[]): { content: string; route?: string; error?: string } {
  const match = /(?:^|\n)ROUTE: (agent:[a-zA-Z0-9._-]+|human:[a-zA-Z0-9._-]+|done|unable)\s*$/.exec(content);
  const directive = match && addressingText(content).slice(match.index).trim() === match[0].trim() ? match : null;
  let visible = (directive ? content.slice(0, directive.index).trim() : content) || "Обработка завершена.";
  let route = directive?.[1];
  const addressed = mentions(visible);
  const peerIds = [...new Set(addressed.filter((m) => m.kind === "a").map((m) => m.id))];
  const humanIds = [...new Set(addressed.filter((m) => m.kind === "u" && members.includes(m.id)).map((m) => m.id))];
  let error: string | undefined;
  if (addressed.some((m) => m.kind === "u" && !members.includes(m.id))) error = "Агент упомянул сотрудника вне спейса. Уточните адресата вручную.";
  else if (peerIds.length > 1) error = "В ответе указано несколько агентов. Вызовите одного адресата для продолжения.";
  else if (peerIds[0] && route && route !== `agent:${peerIds[0]}`) error = "Упоминание агента и команда продолжения противоречат друг другу. Уточните адресата вручную.";
  else if (!route && peerIds[0]) route = `agent:${peerIds[0]}`;
  else if (!route && humanIds.length === 1) route = `human:${humanIds[0]}`;
  if (route?.startsWith("agent:")) {
    const id = route.slice(6);
    if (id === self) error = "Агент вызвал сам себя. Укажите другого агента или человека.";
    else if (!agents.includes(id)) error = "Указанный агент недоступен или не входит в этот спейс.";
  }
  if (route?.startsWith("human:") && !members.includes(route.slice(6))) error = "Агент запросил сотрудника вне спейса.";
  const recipient: Mention = !error && route?.startsWith("agent:") ? { kind: "a", id: route.slice(6) }
    : !error && route?.startsWith("human:") ? { kind: "u", id: route.slice(6) } : { kind: "u", id: requester };
  if ((recipient.kind === "a" || members.includes(recipient.id)) && !addressed.some((m) => m.kind === recipient.kind && m.id === recipient.id)) {
    visible = `@{${recipient.kind}:${recipient.id}}\n\n${visible}`;
  }
  return { content: visible, ...(route ? { route } : {}), ...(error ? { error } : {}) };
}
