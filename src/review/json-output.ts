/** Maximum JSON array payload accepted from a model response. */
export const DEFAULT_MAX_JSON_ARRAY_CHARS = 1_048_576;

/**
 * Map JSON array opening brackets to their closing brackets in one pass,
 * ignoring bracket characters inside strings.
 */
function findJsonArrayEnds(text: string): Map<number, number> {
  const starts: number[] = [];
  const ends = new Map<number, number>();
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }
    if (char === "\"") {
      inString = true;
    } else if (char === "[") {
      starts.push(i);
    } else if (char === "]") {
      const start = starts.pop();
      if (start !== undefined) {
        ends.set(start, i);
      }
    }
  }
  return ends;
}

export interface ExtractedJsonArray {
  json: string;
  value: unknown[];
}

export interface ExtractJsonArrayOptions {
  maxChars?: number;
  acceptJson?: (json: string) => boolean;
  accept?: (value: unknown[]) => boolean;
}

/**
 * Strip markdown fences and isolate the first acceptable JSON array, if present.
 */
export function extractJsonArrayCandidate(
  text: string,
  options: ExtractJsonArrayOptions = {}
): ExtractedJsonArray | null {
  const maxChars = options.maxChars ?? DEFAULT_MAX_JSON_ARRAY_CHARS;
  if (text.length > maxChars) {
    return null;
  }
  const withoutFences = text.replace(/```(?:json)?/gi, "");
  const ends = findJsonArrayEnds(withoutFences);
  let searchFrom = 0;
  while (searchFrom < withoutFences.length) {
    const start = withoutFences.indexOf("[", searchFrom);
    if (start === -1) {
      return null;
    }
    const end = ends.get(start);
    if (end === undefined) {
      searchFrom = start + 1;
      continue;
    }
    const json = withoutFences.slice(start, end + 1);
    if (json.length <= maxChars && (!options.acceptJson || options.acceptJson(json))) {
      try {
        const parsed: unknown = JSON.parse(json);
        if (Array.isArray(parsed) && (!options.accept || options.accept(parsed))) {
          return { json, value: parsed };
        }
      } catch {
        // Keep scanning; this bracketed region was prose, not JSON.
      }
    }
    searchFrom = start + 1;
  }
  return null;
}

/**
 * Strip markdown fences and isolate the first valid JSON array, if present.
 */
export function extractJsonArray(text: string, maxChars = DEFAULT_MAX_JSON_ARRAY_CHARS): string | null {
  return extractJsonArrayCandidate(text, { maxChars })?.json ?? null;
}
