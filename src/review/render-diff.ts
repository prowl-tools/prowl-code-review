import type { DiffFile } from "./diff-types.js";

/**
 * Render size-guarded diff files into compact, LLM-friendly text (backlog #11).
 *
 * We render the *included* (guarded) files rather than the raw diff so size
 * caps actually bound the review input, and we annotate every changed line with
 * its new-side line number — that's the number specialists must cite, which in
 * turn lets findings map cleanly to inline comments (#10).
 */
export function renderGuardedDiff(files: DiffFile[]): string {
  const blocks: string[] = [];

  for (const file of files) {
    if (file.binary) {
      blocks.push(`### ${file.path} (${file.status}, binary — not shown)`);
      continue;
    }

    const header =
      (file.status === "renamed" || file.status === "copied") && file.oldPath
        ? `### ${file.oldPath} → ${file.path} (${file.status})`
        : `### ${file.path} (${file.status})`;
    const lines: string[] = [header];

    for (const hunk of file.hunks) {
      lines.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
      for (const line of hunk.lines) {
        const marker = line.type === "add" ? "+" : line.type === "del" ? "-" : " ";
        // New-side line number for added/context lines; blank for deletions.
        const lineNo = line.newLine !== undefined ? String(line.newLine).padStart(6) : " ".repeat(6);
        lines.push(`${lineNo} ${marker}${line.content}`);
      }
    }

    blocks.push(lines.join("\n"));
  }

  return blocks.join("\n\n");
}
