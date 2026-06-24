import { describe, expect, it, vi } from "vitest";
import { withHeartbeat } from "../src/review/heartbeat.js";

/** A controllable scheduler: the test fires ticks manually and asserts cancellation. */
function fakeScheduler() {
  let cb: (() => void) | null = null;
  const cancel = vi.fn(() => {
    cb = null;
  });
  const schedule = vi.fn((callback: () => void) => {
    cb = callback;
    return cancel;
  });
  return { schedule, cancel, fire: () => cb?.() };
}

describe("withHeartbeat (#17)", () => {
  it("returns the result and cancels the timer", async () => {
    const { schedule, cancel } = fakeScheduler();
    const result = await withHeartbeat(async () => "done", { onTick: () => {}, schedule });
    expect(result).toBe("done");
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("emits ticks with elapsed time + count while pending", async () => {
    const { schedule, fire } = fakeScheduler();
    const ticks: Array<{ elapsedMs: number; tick: number }> = [];
    let clock = 1000;
    const now = () => clock;

    await withHeartbeat(
      async () => {
        clock = 31_000;
        fire(); // simulate the interval firing mid-flight
        clock = 61_000;
        fire();
        return "ok";
      },
      { onTick: (info) => ticks.push(info), now, schedule }
    );

    expect(ticks).toEqual([
      { elapsedMs: 30_000, tick: 1 },
      { elapsedMs: 60_000, tick: 2 }
    ]);
  });

  it("cancels the timer even when the operation throws", async () => {
    const { schedule, cancel } = fakeScheduler();
    await expect(
      withHeartbeat(async () => {
        throw new Error("boom");
      }, { onTick: () => {}, schedule })
    ).rejects.toThrow("boom");
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
