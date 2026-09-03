import type { EventEmitter } from "node:events";

type NativeNotification = Pick<EventEmitter, "once" | "removeListener"> & { show(): void };
export type NotificationProbeResult = { status: "accepted" | "unconfirmed"; detail: string };

// isSupported() and show() returning are not delivery acknowledgements.
// Keep the object alive in this closure until the OS responds or we time out.
export function probeNotification(notification: NativeNotification, timeoutMs = 20_000): Promise<NotificationProbeResult> {
  return new Promise((resolve, reject) => {
    let finished = false;
    const cleanup = (): boolean => {
      if (finished) return false;
      finished = true; clearTimeout(timer);
      notification.removeListener("show", shown); notification.removeListener("failed", failed);
      return true;
    };
    const shown = (): void => {
      if (cleanup()) resolve({ status: "accepted", detail: "Система приняла тестовое уведомление. Если баннера нет, проверьте разрешение Agent Hub, стиль уведомлений и режим фокусирования в настройках ОС." });
    };
    const failed = (_event: unknown, error: unknown): void => {
      if (cleanup()) reject(new Error(`Система отклонила уведомление: ${String(error || "причина не указана").slice(0, 800)}. Проверьте разрешение уведомлений. На Mac используйте корректно подписанную сборку Agent Hub из папки «Программы».`));
    };
    const timer = setTimeout(() => {
      if (cleanup()) resolve({ status: "unconfirmed", detail: "Подтверждение от системы не получено. Проверьте запрос разрешения и настройки уведомлений Agent Hub, затем повторите тест. Доставка не подтверждена." });
    }, timeoutMs);
    timer.unref();
    notification.once("show", shown); notification.once("failed", failed);
    try { notification.show(); }
    catch (error) { failed(null, error instanceof Error ? error.message : error); }
  });
}
