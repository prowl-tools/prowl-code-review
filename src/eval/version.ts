import { createHash } from "node:crypto";
import {
  buildSharedSystem,
  buildSpecialistPrompt,
  DEFAULT_SPECIALISTS,
  type Specialist
} from "../review/specialists.js";
import { buildVerifyPrompt, buildVerifySystem } from "../review/verify.js";
import type { Finding } from "../review/findings.js";

/**
 * Prompt fingerprint (backlog #13).
 *
 * A short, stable hash of everything that defines how the reviewer prompts the
 * model — the shared specialist system block, specialist prompt templates, and
 * verifier prompt templates. Stamped onto every eval report so a score is tied to
 * the exact prompts that produced it: change a prompt and the fingerprint
 * changes, making score movements attributable instead of mysterious.
 *
 * Guidelines are deliberately excluded (they're per-repo, not part of the
 * reviewer's own prompting), so the fingerprint is reproducible across repos.
 */

const PROMPT_PLACEHOLDERS = {
  diff: "{{PROWL_EVAL_DIFF}}",
  context: "{{PROWL_EVAL_CONTEXT}}"
};

const VERIFY_FINDING_PLACEHOLDER: Finding = {
  file: "{{PROWL_EVAL_FILE}}",
  line: 1,
  severity: "major",
  category: "correctness",
  title: "{{PROWL_EVAL_TITLE}}",
  body: "{{PROWL_EVAL_BODY}}",
  confidence: 0.5
};

export function promptFingerprint(specialists: readonly Specialist[] = DEFAULT_SPECIALISTS): string {
  const material = JSON.stringify({
    shared: buildSharedSystem({}),
    specialists: specialists.map((specialist) => ({
      key: specialist.key,
      model: specialist.model ?? null,
      prompt: {
        withoutContext: buildSpecialistPrompt({
          specialist,
          diff: PROMPT_PLACEHOLDERS.diff
        }),
        withContext: buildSpecialistPrompt({
          specialist,
          diff: PROMPT_PLACEHOLDERS.diff,
          context: PROMPT_PLACEHOLDERS.context
        })
      }
    })),
    verify: {
      system: buildVerifySystem(),
      prompt: {
        withoutContext: buildVerifyPrompt({
          candidates: [VERIFY_FINDING_PLACEHOLDER],
          diff: PROMPT_PLACEHOLDERS.diff
        }),
        withContext: buildVerifyPrompt({
          candidates: [VERIFY_FINDING_PLACEHOLDER],
          diff: PROMPT_PLACEHOLDERS.diff,
          context: PROMPT_PLACEHOLDERS.context
        })
      }
    }
  });
  return createHash("sha256").update(material).digest("hex").slice(0, 12);
}
