/**
 * Linked-issue reference parsing for issue/ticket validation (#32).
 *
 * Pure: scans a PR's title + body for the GitHub issues it links, so the
 * pipeline can fetch their acceptance criteria and validate the diff against
 * them. We recognize prowl-review issue-validation links: a closing keyword
 * (`Closes #12`, `Fixes owner/repo#5`) or an explicit issue URL rather than
 * every bare `#n`, which is usually an incidental mention, not a requirement.
 */

/** A referenced GitHub issue: repository coordinates + number. */
export interface IssueRef {
  owner: string;
  repo: string;
  number: number;
}

/** GitHub's closing keywords; any of these before a reference links the issue. */
const CLOSING_KEYWORD = "(?:close[sd]?|fix(?:es|ed)?|resolve[sd]?)";
const OWNER_REPO = "[A-Za-z0-9._-]+";
type IssueReferenceMatch = { index: number; owner: string; repo: string; number: number };
/** `Closes #12` / `Fixes owner/repo#5` / `Resolves https://github.com/o/r/issues/7`. */
const KEYWORD_RE = new RegExp(
  `\\b${CLOSING_KEYWORD}\\b\\s*:?\\s+` +
    `(?:#(\\d+)` +
    `|(${OWNER_REPO})\\/(${OWNER_REPO})#(\\d+)` +
    `|https?:\\/\\/github\\.com\\/(${OWNER_REPO})\\/(${OWNER_REPO})\\/issues\\/(\\d+))`,
  "gi"
);
/** A bare GitHub issue URL counts as an explicit link even without a keyword. */
const URL_RE = new RegExp(
  `https?:\\/\\/github\\.com\\/(${OWNER_REPO})\\/(${OWNER_REPO})\\/issues\\/(\\d+)`,
  "gi"
);

/** Append a valid, deduped issue reference while preserving caller order. */
function pushRef(into: IssueRef[], seen: Set<string>, owner: string, repo: string, number: number): void {
  if (!owner || !repo || !Number.isInteger(number) || number <= 0) {
    return;
  }
  const key = `${owner.toLowerCase()}/${repo.toLowerCase()}#${number}`;
  if (seen.has(key)) {
    return;
  }
  seen.add(key);
  into.push({ owner, repo, number });
}

/**
 * Parse the GitHub issues a PR links via its title/body. Bare `#n` references
 * need a closing keyword; issue URLs are always honored. References without a
 * repo resolve against `defaultRepo` (the PR's own repo). Deduped; order of
 * first appearance preserved.
 */
export function parseIssueReferences(
  text: string | null | undefined,
  defaultRepo: { owner: string; repo: string }
): IssueRef[] {
  if (!text) {
    return [];
  }
  const refs: IssueRef[] = [];
  const seen = new Set<string>();
  const matches: IssueReferenceMatch[] = [];

  for (const match of text.matchAll(KEYWORD_RE)) {
    const [, bare, ownerRepoOwner, ownerRepoRepo, ownerRepoNum, urlOwner, urlRepo, urlNum] = match;
    const index = match.index ?? Number.MAX_SAFE_INTEGER;
    if (bare) {
      matches.push({ index, owner: defaultRepo.owner, repo: defaultRepo.repo, number: Number(bare) });
    } else if (ownerRepoNum) {
      matches.push({ index, owner: ownerRepoOwner, repo: ownerRepoRepo, number: Number(ownerRepoNum) });
    } else if (urlNum) {
      matches.push({ index, owner: urlOwner, repo: urlRepo, number: Number(urlNum) });
    }
  }
  for (const match of text.matchAll(URL_RE)) {
    matches.push({
      index: match.index ?? Number.MAX_SAFE_INTEGER,
      owner: match[1],
      repo: match[2],
      number: Number(match[3])
    });
  }
  matches.sort((a, b) => a.index - b.index);
  for (const match of matches) {
    pushRef(refs, seen, match.owner, match.repo, match.number);
  }
  return refs;
}

/** Render an issue reference as `#n` (same repo) or `owner/repo#n` (cross-repo). */
export function formatIssueRef(ref: IssueRef, defaultRepo: { owner: string; repo: string }): string {
  const sameRepo =
    ref.owner.toLowerCase() === defaultRepo.owner.toLowerCase() &&
    ref.repo.toLowerCase() === defaultRepo.repo.toLowerCase();
  return sameRepo ? `#${ref.number}` : `${ref.owner}/${ref.repo}#${ref.number}`;
}
