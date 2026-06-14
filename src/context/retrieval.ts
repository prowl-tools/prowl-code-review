import {
  completeWithTools as defaultCompleteWithTools,
  retrying,
  emptyUsage,
  resolveProviderConfig,
  type ProviderConfig,
  type RetryOptions,
  type ToolCompletionRequest,
  type ToolCompletionResult,
  type ToolDefinition,
  type ToolMessage,
  type ToolResult,
  type TokenUsage
} from "../providers/index.js";
import {
  listRepoFilesDetailed,
  readRepoFile,
  searchRepo,
  type ToolkitOptions
} from "./tools.js";
import { isSensitiveFile, redactSecrets } from "../review/redact.js";
import { totalTokens } from "../cost/pricing.js";

/**
 * Agentic cross-file context retrieval (backlog #4, the #1 bug-catching lever).
 *
 * The model is given read-file / grep / list tools over the checked-out repo and
 * decides what to fetch — no vector DB. The loop runs until the model stops
 * requesting tools or a bound is hit; everything fetched (and any truncation,
 * error, or limit) is returned so it can be added to the cached review prompt
 * and reported (core principle #5).
 */

/** Tool definitions advertised to the model (provider-agnostic). */
export const REVIEW_TOOLS: ToolDefinition[] = [
  {
    name: "read_file",
    description: "Read a UTF-8 text file from the repository.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Repo-relative file path." }
      },
      required: ["path"]
    }
  },
  {
    name: "search_repo",
    description:
      "Search repository file contents with a JavaScript regular expression. Returns path:line: text matches.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "JavaScript regular expression." },
        dir: { type: "string", description: "Optional subdirectory to limit the search." }
      },
      required: ["pattern"]
    }
  },
  {
    name: "list_files",
    description: "List repository files under a directory.",
    parameters: {
      type: "object",
      properties: {
        dir: { type: "string", description: "Optional subdirectory (defaults to repo root)." }
      }
    }
  }
];

export interface RetrievalLimits {
  /** Max tool-use rounds before stopping. Default 6. */
  maxRounds?: number;
  /** Max distinct files the agent may read. Default 20. */
  maxFiles?: number;
  /** Token budget for this stage; the loop stops once accumulated usage hits it (#18). */
  maxTokens?: number;
}

export interface RetrievedFile {
  path: string;
  content: string;
  truncated: boolean;
}

export interface RetrievedToolOutput {
  tool: "search_repo" | "list_files";
  input: Record<string, string>;
  content: string;
  truncated: boolean;
}

export interface GatheredContext {
  /** Distinct files the agent read, in fetch order. */
  files: RetrievedFile[];
  /** Bounded non-file tool outputs the agent used while gathering context. */
  toolOutputs: RetrievedToolOutput[];
  /** Number of tool-use rounds executed. */
  rounds: number;
  /** Summed token usage across rounds. */
  usage: TokenUsage;
  /** True when a bound (rounds/files) cut retrieval short. */
  reachedLimit: boolean;
  /** Human-readable notes: errors, truncations, limit hits (never silent). */
  notes: string[];
}

export interface GatherContextParams {
  /** Sandboxed repo-access configuration. */
  toolkit: ToolkitOptions;
  /** Paths changed in the PR, used to seed the retrieval task. */
  changedPaths: string[];
  /** Provider config; resolved from the environment when omitted. */
  config?: ProviderConfig;
  /** Retrieval bounds. */
  limits?: RetrievalLimits;
  /** Extra system guidance (e.g. review guidelines). */
  system?: string;
  /** Injectable tool-use completion (defaults to the provider dispatcher, wrapped in retry). */
  runCompletion?: (
    request: ToolCompletionRequest,
    config: ProviderConfig
  ) => Promise<ToolCompletionResult>;
  /** Retry/backoff config for transient provider errors (#17). Applied to the default completion. */
  retry?: RetryOptions;
}

export class ContextRetrievalError extends Error {
  readonly usage: TokenUsage;
  readonly rounds: number;
  readonly notes: string[];

  constructor(message: string, options: { usage: TokenUsage; rounds: number; notes: string[] }) {
    super(message);
    this.name = "ContextRetrievalError";
    this.usage = options.usage;
    this.rounds = options.rounds;
    this.notes = [...options.notes];
  }
}

interface ExecutedTool {
  content: string;
  reachedLimit: boolean;
}

function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  const cacheWriteInputTokens = (a.cacheWriteInputTokens ?? 0) + (b.cacheWriteInputTokens ?? 0);
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    ...(cacheWriteInputTokens > 0 ? { cacheWriteInputTokens } : {})
  };
}

function seedPrompt(changedPaths: string[]): string {
  return [
    "You are gathering cross-file context to review a pull request.",
    "",
    "Changed files:",
    ...changedPaths.map((p) => `- ${p}`),
    "",
    "Use the tools to read the definitions and callers of the changed code, plus any",
    "closely related files needed to catch broken callers, contract/interface",
    "violations, and inconsistent patterns. Fetch only what is relevant. When you",
    "have enough context, reply without calling any tools."
  ].join("\n");
}

function toolExecution(content: string, reachedLimit = false): ExecutedTool {
  return { content, reachedLimit };
}

function executeTool(
  call: { name: string; input: Record<string, unknown> },
  options: ToolkitOptions,
  files: Map<string, RetrievedFile>,
  toolOutputs: RetrievedToolOutput[],
  maxFiles: number,
  notes: string[]
): ExecutedTool {
  try {
    if (call.name === "read_file") {
      const path = typeof call.input.path === "string" ? call.input.path : "";
      if (!path) {
        return toolExecution("Error: read_file requires a 'path'.");
      }
      if (isSensitiveFile(path)) {
        notes.push(`Refused to read sensitive file ${path} (kept out of context)`);
        return toolExecution(`Refused to read sensitive file: ${path}.`, true);
      }
      if (!files.has(path) && files.size >= maxFiles) {
        notes.push(`File budget reached (${maxFiles}); skipped ${path}`);
        return toolExecution(`File budget reached (${maxFiles}); not reading ${path}.`, true);
      }
      // Repo tools enforce root confinement, symlink rejection, ignore rules, and read caps.
      const result = readRepoFile(options, path);
      const { text: safeContent, count: redactions } = redactSecrets(result.content);
      if (redactions > 0) {
        notes.push(`Redacted ${redactions} secret(s) from ${result.path}`);
      }
      files.set(result.path, {
        path: result.path,
        content: safeContent,
        truncated: result.truncated
      });
      if (result.truncated) {
        notes.push(`Truncated ${result.path} to ${result.bytes} bytes`);
      }
      return toolExecution(
        result.truncated ? `${safeContent}\n…[truncated]` : safeContent,
        result.truncated
      );
    }

    if (call.name === "search_repo") {
      const pattern = typeof call.input.pattern === "string" ? call.input.pattern : "";
      if (!pattern) {
        return toolExecution("Error: search_repo requires a 'pattern'.");
      }
      const dir = typeof call.input.dir === "string" ? call.input.dir : ".";
      // searchRepo validates regex complexity and confines traversal to the repo root.
      const result = searchRepo(options, pattern, dir, {
        shouldSearchFile: (path) => !isSensitiveFile(path)
      });
      const safeMatches = result.matches.filter((match) => !isSensitiveFile(match.path));
      const skippedSensitive = result.matches.length - safeMatches.length;
      const skippedSensitiveFiles = result.skippedFiles ?? 0;
      if (skippedSensitiveFiles > 0) {
        notes.push(`Skipped ${skippedSensitiveFiles} sensitive file(s) during search`);
      }
      if (skippedSensitive > 0) {
        notes.push(`Skipped ${skippedSensitive} search result(s) from sensitive file(s)`);
      }
      const rawBody = safeMatches.map((m) => `${m.path}:${m.line}: ${m.text}`).join("\n");
      const { text: body, count: redactions } = redactSecrets(rawBody);
      if (redactions > 0) {
        notes.push(`Redacted ${redactions} secret(s) from search results`);
      }
      const content = (body || "(no matches)") + (result.truncated ? "\n…[more matches omitted]" : "");
      if (result.truncated) {
        notes.push(`Search results truncated for '${pattern}' under ${dir}`);
      }
      toolOutputs.push({
        tool: "search_repo",
        input: { pattern, dir },
        content,
        truncated: result.truncated
      });
      return toolExecution(content, result.truncated);
    }

    if (call.name === "list_files") {
      const dir = typeof call.input.dir === "string" ? call.input.dir : ".";
      // Listing shares the same repo-root confinement and symlink/ignore guards.
      const result = listRepoFilesDetailed(options, dir);
      const body = result.files.join("\n") || "(empty)";
      const content = body + (result.truncated ? "\n…[more files omitted]" : "");
      if (result.truncated) {
        notes.push(`Listed first ${result.files.length} files under ${dir}; more omitted`);
      }
      toolOutputs.push({
        tool: "list_files",
        input: { dir },
        content,
        truncated: result.truncated
      });
      return toolExecution(content, result.truncated);
    }

    return toolExecution(`Error: unknown tool '${call.name}'.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    notes.push(`Tool ${call.name} error: ${message}`);
    return toolExecution(`Error: ${message}`);
  }
}

/** Run the agentic retrieval loop and return the gathered cross-file context. */
export async function gatherContext(params: GatherContextParams): Promise<GatheredContext> {
  const run = params.runCompletion ?? retrying(defaultCompleteWithTools, params.retry);
  const config = params.config ?? resolveProviderConfig();
  const maxRounds = params.limits?.maxRounds ?? 6;
  const maxFiles = params.limits?.maxFiles ?? 20;
  const maxTokens = params.limits?.maxTokens;

  const files = new Map<string, RetrievedFile>();
  const toolOutputs: RetrievedToolOutput[] = [];
  const notes: string[] = [];
  const messages: ToolMessage[] = [{ role: "user", text: seedPrompt(params.changedPaths) }];

  let usage = emptyUsage();
  let rounds = 0;
  let reachedLimit = false;

  for (;;) {
    if (rounds >= maxRounds) {
      reachedLimit = true;
      notes.push(`Reached max tool rounds (${maxRounds}).`);
      break;
    }
    rounds += 1;

    let result: ToolCompletionResult;
    try {
      result = await run(
        { system: params.system, messages, tools: REVIEW_TOOLS },
        config
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ContextRetrievalError(message, { usage, rounds, notes });
    }
    usage = addUsage(usage, result.usage);

    // Stop the (otherwise unbounded) retrieval loop once it has spent its token
    // budget, so a huge PR can't run up cost here (#18).
    if (maxTokens !== undefined && totalTokens(usage) >= maxTokens) {
      reachedLimit = true;
      notes.push(`Reached context token budget (${maxTokens}).`);
      break;
    }

    if (result.stopReason !== "tool_use" || result.toolCalls.length === 0) {
      break;
    }

    messages.push({
      role: "assistant",
      text: result.text,
      toolCalls: result.toolCalls,
      providerMetadata: result.providerMetadata
    });

    const results: ToolResult[] = result.toolCalls.map((call) => {
      const executed = executeTool(call, params.toolkit, files, toolOutputs, maxFiles, notes);
      if (executed.reachedLimit) {
        reachedLimit = true;
      }
      return { callId: call.id, content: executed.content };
    });
    messages.push({ role: "tool", results });
  }

  return {
    files: [...files.values()],
    toolOutputs,
    rounds,
    usage,
    reachedLimit,
    notes
  };
}
