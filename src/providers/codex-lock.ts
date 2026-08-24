import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Machine-wide Codex serialization lock (backlog #45).
 *
 * OpenAI requires **one `auth.json` per serialized stream**, and #64 runs several
 * self-hosted runner instances against a single shared `CODEX_HOME`. An advisory
 * file lock at `$CODEX_HOME/.prowl-review.lock` serializes `codex` spawns across
 * every process on the host so two runs never share the one login concurrently.
 *
 * The lock is created **atomically** to avoid two races: the record is written to
 * a per-pid temp file and `link(2)`ed into place (so the lock file is never
 * observed empty mid-write), and a stale lock is reclaimed by `rename(2)` (so only
 * one of several concurrent reclaimers wins and no one deletes a freshly re-created
 * lock). An unreadable/empty record is treated as *held* unless the file is older
 * than a short grace.
 *
 * Within a single prowl-review process, an in-process queue serializes codex
 * operations too (so the specialist fan-out shares one lock holder rather than
 * self-contending on the file lock — the documented tradeoff is that codex passes
 * run sequentially, not in parallel). A lock whose recorded pid is dead is
 * reclaimed immediately; the max-age reclaim is a backstop for pid reuse and is
 * kept `>=` the child exec timeout so a live holder is never reclaimed before its
 * own timeout fires. prowl-review never reads, copies, or logs `auth.json` — only
 * the `codex` binary does.
 */

export const CODEX_LOCK_FILENAME = ".prowl-review.lock";

/** Resolve `$CODEX_HOME` (or an explicit override), defaulting to `~/.codex`. */
export function resolveCodexHome(env: NodeJS.ProcessEnv = process.env, override?: string): string {
  const raw = override?.trim() || env.CODEX_HOME?.trim();
  return raw && raw.length > 0 ? raw : join(homedir(), ".codex");
}

/** Path to the advisory lock file inside a `CODEX_HOME`. */
export function codexLockPath(codexHome: string): string {
  return join(codexHome, CODEX_LOCK_FILENAME);
}

interface LockRecord {
  pid: number;
  ts: number;
}

export interface AcquireLockOptions {
  /** Poll interval while waiting for a held lock, ms. Default 50. */
  pollIntervalMs?: number;
  /** Max time to wait before giving up, ms. Default 600_000 (10 min). */
  timeoutMs?: number;
  /**
   * Backstop for pid reuse: a lock held by a *live* pid older than this is treated
   * as stale, ms. Default 15 min. Keep it `>=` the child exec timeout so a live
   * holder mid-`codex exec` is never reclaimed before its own timeout fires.
   */
  maxAgeMs?: number;
  /**
   * Grace for an unreadable/empty lock record before it may be reclaimed, ms.
   * Default 5000 — a competitor mid-write is treated as held, not stale.
   */
  graceMs?: number;
  /** Injectable "is this pid alive?" check (default: `process.kill(pid, 0)`). */
  isProcessAlive?: (pid: number) => boolean;
  /** Injectable lock-file age (ms since its mtime); default reads `statSync`. */
  fileAgeMs?: (path: string) => number | null;
  /** Injectable clock (ms since epoch). */
  now?: () => number;
  /** Injectable sleep. */
  sleep?: (ms: number) => Promise<void>;
}

/** Default liveness probe: signal 0 succeeds for a live pid, EPERM means it exists. */
function defaultIsProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but we can't signal it (still alive).
    // ESRCH: no such process (dead → reclaimable).
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readLockRecord(lockPath: string): LockRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, "utf8")) as Partial<LockRecord>;
    if (typeof parsed?.pid === "number") {
      return { pid: parsed.pid, ts: typeof parsed.ts === "number" ? parsed.ts : 0 };
    }
    return null;
  } catch {
    return null;
  }
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Default lock-file age: `now - mtime`, or null when the file is gone. */
function defaultFileAgeMs(lockPath: string): number | null {
  try {
    return Math.max(0, Date.now() - statSync(lockPath).mtimeMs);
  } catch {
    return null;
  }
}

/**
 * Atomically reclaim a stale lock via rename: only one of several concurrent
 * reclaimers renames the file away (the losers get ENOENT), so no one deletes a
 * lock another has since freshly re-created. Returns true when this caller won.
 */
function reclaimStaleLock(lockPath: string, pid: number, stamp: number): boolean {
  const staleName = `${lockPath}.stale-${pid}-${stamp}`;
  try {
    renameSync(lockPath, staleName);
  } catch {
    // ENOENT (or a transient error): another reclaimer already moved it — the
    // caller loops and re-evaluates cleanly.
    return false;
  }
  try {
    rmSync(staleName, { force: true });
  } catch {
    // Best-effort cleanup; the rename already freed the lock path.
  }
  return true;
}

/**
 * Acquire the advisory file lock, waiting (with stale-lock reclaim) until it is
 * free or the timeout elapses. Returns an idempotent release function.
 */
export async function acquireFileLock(
  lockPath: string,
  options: AcquireLockOptions = {}
): Promise<() => void> {
  const pollIntervalMs = options.pollIntervalMs ?? 50;
  const timeoutMs = options.timeoutMs ?? 600_000;
  const maxAgeMs = options.maxAgeMs ?? 15 * 60_000;
  const graceMs = options.graceMs ?? 5000;
  const isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
  const fileAgeMs = options.fileAgeMs ?? defaultFileAgeMs;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const start = now();

  mkdirSync(dirname(lockPath), { recursive: true });
  const tmpPath = `${lockPath}.${process.pid}.tmp`;

  for (;;) {
    // Atomic create: write the record to a per-pid temp file, then hard-link it
    // into place. link() fails EEXIST when the lock is held, and the lock file is
    // never observed empty because it appears fully-formed via the link.
    try {
      writeFileSync(tmpPath, JSON.stringify({ pid: process.pid, ts: now() }));
      try {
        linkSync(tmpPath, lockPath);
      } finally {
        rmSync(tmpPath, { force: true });
      }
      let released = false;
      return () => {
        if (released) {
          return;
        }
        released = true;
        try {
          rmSync(lockPath, { force: true });
        } catch {
          // Best-effort: another reclaim may have already removed it.
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }

    // The lock is held. Decide whether it is stale (reclaimable) or live (wait).
    const record = readLockRecord(lockPath);
    let stale: boolean;
    if (record === null) {
      // Unreadable/empty (possibly a competitor mid-write): treat as held unless
      // the file itself is older than the grace.
      const age = fileAgeMs(lockPath);
      stale = age !== null && age > graceMs;
    } else {
      // Dead pid → reclaim now. Live pid → only reclaim past maxAge (pid reuse).
      stale = !isProcessAlive(record.pid) || (record.ts > 0 && now() - record.ts > maxAgeMs);
    }

    if (stale) {
      reclaimStaleLock(lockPath, process.pid, now());
      continue;
    }

    if (now() - start >= timeoutMs) {
      const heldBy = record ? `pid ${record.pid}` : "an in-progress writer";
      throw new Error(
        `Timed out after ${timeoutMs}ms waiting for the Codex lock at ${lockPath} ` +
          `(held by ${heldBy}). Another prowl-review Codex run may be in progress on this machine.`
      );
    }
    await sleep(pollIntervalMs);
  }
}

// In-process queue: serialize every codex operation in THIS process so the
// specialist fan-out shares one lock holder instead of self-contending on the
// file lock. Kept module-global on purpose (one CODEX_HOME per host).
let processChain: Promise<unknown> = Promise.resolve();

function runExclusiveInProcess<T>(fn: () => Promise<T>): Promise<T> {
  const result = processChain.then(fn, fn);
  // Keep the chain moving whether fn resolved or rejected, without leaking the
  // rejection to the next queued op (each caller still sees its own result).
  processChain = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

export interface CodexLockConfig {
  /** When false, run without any locking (opt-out for single-instance hosts). */
  enabled: boolean;
  /** Absolute path to the advisory lock file. */
  lockPath: string;
  /** Injectable acquire (for tests). */
  acquire?: typeof acquireFileLock;
  /** Options forwarded to the acquire call. */
  acquireOptions?: AcquireLockOptions;
}

/**
 * Run `fn` while holding the machine-wide Codex lock (and the in-process queue),
 * releasing both afterwards. With `enabled: false` it runs `fn` directly.
 */
export async function withCodexLock<T>(lock: CodexLockConfig, fn: () => Promise<T>): Promise<T> {
  if (!lock.enabled) {
    return fn();
  }
  const acquire = lock.acquire ?? acquireFileLock;
  return runExclusiveInProcess(async () => {
    const release = await acquire(lock.lockPath, lock.acquireOptions);
    try {
      return await fn();
    } finally {
      release();
    }
  });
}
