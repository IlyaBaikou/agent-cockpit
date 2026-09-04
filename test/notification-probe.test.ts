import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { probeNotification } from "../src/notification-probe.js";

class FakeNotification extends EventEmitter { show = vi.fn(); }
afterEach(() => vi.useRealTimers());
describe("native notification acknowledgement", () => {
  it("waits for show rather than assuming that show() returning means success", async () => {
    const n = new FakeNotification(); let settled = false;
    const result = probeNotification(n).then((v) => { settled = true; return v; });
    await Promise.resolve(); expect(n.show).toHaveBeenCalledOnce(); expect(settled).toBe(false);
    n.emit("show"); expect((await result).status).toBe("accepted");
    expect(n.listenerCount("failed")).toBe(0);
  });
  it("reports asynchronous OS rejection including the native reason", async () => {
    const n = new FakeNotification(), result = probeNotification(n);
    n.emit("failed", {}, "application is not signed");
    await expect(result).rejects.toThrow("application is not signed");
    expect(n.listenerCount("show")).toBe(0);
  });
  it("marks a missing response unconfirmed and cleans up listeners", async () => {
    vi.useFakeTimers(); const n = new FakeNotification(), result = probeNotification(n, 50);
    await vi.advanceTimersByTimeAsync(50);
    expect((await result).status).toBe("unconfirmed"); expect(n.eventNames()).toHaveLength(0);
    n.emit("show");
  });
  it("handles synchronous throws and synchronous show events without leaks", async () => {
    const a = new FakeNotification(); a.show.mockImplementation(() => { throw Error("OS unavailable"); });
    await expect(probeNotification(a)).rejects.toThrow("OS unavailable"); expect(a.eventNames()).toHaveLength(0);
    const b = new FakeNotification(); b.show.mockImplementation(() => { b.emit("show"); });
    expect((await probeNotification(b)).status).toBe("accepted"); expect(b.eventNames()).toHaveLength(0);
  });
});
