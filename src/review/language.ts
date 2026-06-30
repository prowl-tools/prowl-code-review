/**
 * Language detection (backlog #5).
 *
 * A small, dependency-free map from file path → language, used to make the review
 * language-aware: it tells the specialists which stacks a PR touches, and gives
 * grounding (#16/#16b) a per-language seam for selecting the right linter. It is
 * deliberately lightweight (extension/filename lookup, not parsing) — the
 * cross-file context retrieval is already language-agnostic (grep/read), so this
 * doesn't gate review coverage; unknown languages still review normally, just
 * without language-specific tooling (graceful degradation).
 */

/** Stable language ids and their human labels. */
export const LANGUAGES = {
  typescript: "TypeScript",
  javascript: "JavaScript",
  python: "Python",
  go: "Go",
  ruby: "Ruby",
  java: "Java",
  kotlin: "Kotlin",
  rust: "Rust",
  c: "C",
  cpp: "C++",
  csharp: "C#",
  php: "PHP",
  swift: "Swift",
  scala: "Scala",
  shell: "Shell",
  yaml: "YAML",
  json: "JSON",
  markdown: "Markdown",
  html: "HTML",
  css: "CSS",
  sql: "SQL",
  docker: "Dockerfile",
  make: "Makefile"
} as const;

export type LanguageId = keyof typeof LANGUAGES;

/** True when `value` is a known language id (validates untrusted tool input, #5). */
export function isLanguageId(value: string): value is LanguageId {
  return Object.prototype.hasOwnProperty.call(LANGUAGES, value);
}

/** File extension (without the dot, lowercase) → language id. */
const EXTENSION_TO_LANGUAGE: Record<string, LanguageId> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  pyi: "python",
  go: "go",
  rb: "ruby",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  rs: "rust",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hh: "cpp",
  cs: "csharp",
  php: "php",
  swift: "swift",
  scala: "scala",
  sc: "scala",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  yml: "yaml",
  yaml: "yaml",
  json: "json",
  jsonc: "json",
  md: "markdown",
  markdown: "markdown",
  html: "html",
  htm: "html",
  css: "css",
  scss: "css",
  sass: "css",
  sql: "sql"
};

/** Exact filename (lowercase) → language id, for files without a telling extension. */
const FILENAME_TO_LANGUAGE: Record<string, LanguageId> = {
  dockerfile: "docker",
  makefile: "make",
  gnumakefile: "make"
};

/** Read only declared map entries; object-prototype keys are not language ids. */
function lookupLanguage(map: Record<string, LanguageId>, key: string): LanguageId | undefined {
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
}

/** Return the basename of a repo path, tolerant of either slash style. */
function basename(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  return slash === -1 ? normalized : normalized.slice(slash + 1);
}

/** Detect a file's language by filename then extension, or undefined when unknown. */
export function detectLanguage(path: string): LanguageId | undefined {
  const name = basename(path).toLowerCase();
  const filenameLanguage = lookupLanguage(FILENAME_TO_LANGUAGE, name);
  if (filenameLanguage) {
    return filenameLanguage;
  }
  const dot = name.lastIndexOf(".");
  if (dot <= 0) {
    return undefined; // no extension, or a dotfile like ".gitignore"
  }
  return lookupLanguage(EXTENSION_TO_LANGUAGE, name.slice(dot + 1));
}

/** True when a path is JavaScript or TypeScript (the ESLint-eligible languages). */
export function isJavaScriptFamily(path: string): boolean {
  const language = detectLanguage(path);
  return language === "javascript" || language === "typescript";
}

/** One language's share of a changed-file set. */
export interface LanguageCount {
  id: LanguageId;
  label: string;
  files: number;
}

/**
 * Summarize the languages across a set of paths, most-files-first. Unknown files
 * are simply omitted (they still review — this only drives language-aware extras).
 */
export function summarizeLanguages(paths: string[]): LanguageCount[] {
  const counts = new Map<LanguageId, number>();
  for (const path of paths) {
    const id = detectLanguage(path);
    if (id) {
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([id, files]) => ({ id, label: LANGUAGES[id], files }))
    .sort((a, b) => b.files - a.files || a.label.localeCompare(b.label));
}
