import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

/** Default directory for prowl-review local/debug artifacts, relative to a workspace root. */
export const DEFAULT_DEBUG_LOG_DIR = ".prowl-review";

/** Default relative path for the debug/verbose JSONL run trace (#49). */
export const DEFAULT_DEBUG_LOG_FILENAME = `${DEFAULT_DEBUG_LOG_DIR}/debug.jsonl`;

/** True when `path` resolves inside `workspace`, using lexical path confinement. */
export function isWorkspaceConfinedPath(path: string, workspace: string): boolean {
  const workspaceRoot = resolve(workspace);
  const resolvedPath = resolve(workspaceRoot, path);
  const relativePath = relative(workspaceRoot, resolvedPath);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

/** True when any existing path component is a symlink. Missing tail segments may be allowed. */
export function hasSymlinkComponent(
  path: string,
  workspace: string,
  options: { allowMissingTail?: boolean } = {}
): boolean {
  const workspaceRoot = resolve(workspace);
  const resolvedPath = resolve(workspaceRoot, path);
  const relativePath = relative(workspaceRoot, resolvedPath);
  const segments = relativePath.split(/[\\/]+/).filter(Boolean);
  let current = workspaceRoot;

  for (let index = 0; index < segments.length; index += 1) {
    current = join(current, segments[index]);
    try {
      if (lstatSync(current).isSymbolicLink()) {
        return true;
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return options.allowMissingTail !== true;
      }
      throw new Error("Debug trace path component could not be inspected.", { cause: error });
    }
  }

  return false;
}

function assertDirectoryWithoutSymlink(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) {
    throw new Error("Debug trace path includes a symlink.");
  }
  if (!stat.isDirectory()) {
    throw new Error("Debug trace parent is not a directory.");
  }
}

function ensureDirectoryWithoutSymlinks(path: string, workspace: string): void {
  const workspaceRoot = resolve(workspace);
  const resolvedPath = resolve(workspaceRoot, path);
  const relativePath = relative(workspaceRoot, resolvedPath);
  const segments = relativePath.split(/[\\/]+/).filter(Boolean);
  let current = workspaceRoot;

  for (const segment of segments) {
    current = join(current, segment);
    try {
      assertDirectoryWithoutSymlink(current);
      continue;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        throw error;
      }
    }

    try {
      mkdirSync(current, { mode: 0o700 });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        throw error;
      }
    }
    assertDirectoryWithoutSymlink(current);
  }
}

/**
 * Prepare a debug trace path for writing and assert the resolved parent/file
 * remain inside the workspace without symlinked components.
 */
export function prepareDebugLogPathForWrite(path: string, workspace: string): string {
  const workspaceRoot = resolve(workspace);
  const resolvedPath = resolve(workspaceRoot, path);
  if (!isWorkspaceConfinedPath(resolvedPath, workspaceRoot)) {
    throw new Error("Debug trace path escapes the workspace.");
  }

  ensureDirectoryWithoutSymlinks(dirname(resolvedPath), workspaceRoot);

  if (hasSymlinkComponent(resolvedPath, workspaceRoot, { allowMissingTail: true })) {
    throw new Error("Debug trace path includes a symlink.");
  }

  const realWorkspace = realpathSync(workspaceRoot);
  const realParent = realpathSync(dirname(resolvedPath));
  if (!isWorkspaceConfinedPath(realParent, realWorkspace)) {
    throw new Error("Debug trace parent escapes the workspace.");
  }
  return resolvedPath;
}
