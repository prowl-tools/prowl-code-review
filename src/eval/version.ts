import { createHash } from "node:crypto";
import { buildSharedSystem, buildSpecialistDirective, DEFAULT_SPECIALISTS } from "../review/specialists.js";
import { buildVerifySystem } from "../review/verify.js";

/**
 * Prompt fingerprint (backlog #13).
 *
 * A short, stable hash of everything that defines how the reviewer prompts the
 * model — the shared specialist system block, the specialist set, and the
 * verifier system block. Stamped onto every eval report so a score is tied to
 * the exact prompts that produced it: change a prompt and the fingerprint
 * changes, making score movements attributable instead of mysterious.
 *
 * Guidelines are deliberately excluded (they're per-repo, not part of the
 * reviewer's own prompting), so the fingerprint is reproducible across repos.
 */
export function promptFingerprint(): string {
  const material = JSON.stringify({
    shared: buildSharedSystem({}),
    specialists: DEFAULT_SPECIALISTS.map((specialist) => ({
      key: specialist.key,
      model: specialist.model ?? null,
      directive: buildSpecialistDirective(specialist)
    })),
    verify: buildVerifySystem()
  });
  return createHash("sha256").update(material).digest("hex").slice(0, 12);
}
