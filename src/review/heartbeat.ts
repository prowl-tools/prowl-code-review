/**
 * Heartbeat progress logging (backlog #17).
 *
 * A multi-pass ensemble review can spend minutes in provider "thinking" with no
 * output — easy to mistake for a hung job in CI. `withHeartbeat` ticks a
 * progress callback on an interval while a long operation is in flight and stops
 * as soon as it settles. The timer + clock are injectable so it's unit-testable
 * without real time, and the real timer is `unref`'d so it never keeps the
 * process alive.
 */

export interface HeartbeatOptions {
  /** Tick interval in ms. Default 30000. */
  intervalMs?: number;
  /** Called on each tick with elapsed time + tick count. */
  onTick: (info: { elapsedMs: number; tick: number }) => void;
  /** Clock (injectable for tests). */
  now?: () => number;
  /** Scheduler returning a canceller (injectable for tests). */
  schedule?: (callback: () => void, ms: number) => () => void;
}

const DEFAULT_INTERVAL_MS = 30_000;

const defaultSchedule = (callback: () => void, ms: number): (() => void) => {
  const timer = setInterval(callback, ms);
  // Don't let the heartbeat keep the process alive after the work is done.
  (timer as { unref?: () => void }).unref?.();
  return () => clearInterval(timer);
};

/** Run `fn`, emitting a heartbeat tick every `intervalMs` until it settles. */
export async function withHeartbeat<T>(fn: () => Promise<T>, options: HeartbeatOptions): Promise<T> {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const now = options.now ?? (() => Date.now());
  const schedule = options.schedule ?? defaultSchedule;
  const start = now();
  let tick = 0;
  const cancel = schedule(() => {
    tick += 1;
    options.onTick({ elapsedMs: now() - start, tick });
  }, intervalMs);
  try {
    return await fn();
  } finally {
    cancel();
  }
}
