/** Maximum JSON array payload accepted from a model response. */
export const DEFAULT_MAX_JSON_ARRAY_CHARS = 1_048_576;

/**
 * Find the closing bracket for a JSON array, ignoring brackets inside strings.
 */
function findJsonArrayEnd(text: string, start: number): number | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
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
      depth += 1;
    } else if (char === "]") {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
  }
  return null;
}

/**
 * Strip markdown fences and isolate the first valid JSON array, if present.
 */
export function extractJsonArray(text: string, maxChars = DEFAULT_MAX_JSON_ARRAY_CHARS): string | null {
  if (text.length > maxChars) {
    return null;
  }
  const withoutFences = text.replace(/```(?:json)?/gi, "");
  let searchFrom = 0;
  while (searchFrom < withoutFences.length) {
    const start = withoutFences.indexOf("[", searchFrom);
    if (start === -1) {
      return null;
    }
    const end = findJsonArrayEnd(withoutFences, start);
    if (end === null) {
      searchFrom = start + 1;
      continue;
    }
    const json = withoutFences.slice(start, end + 1);
    if (json.length <= maxChars) {
      try {
        const parsed: unknown = JSON.parse(json);
        if (Array.isArray(parsed)) {
          return json;
        }
      } catch {
        // Keep scanning; this bracketed region was prose, not JSON.
      }
    }
    searchFrom = start + 1;
  }
  return null;
}
