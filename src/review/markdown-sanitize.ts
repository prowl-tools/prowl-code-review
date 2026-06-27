const DANGEROUS_MARKDOWN_LINK_PROTOCOL_RE =
  /(\]\(\s*)(?:j\s*a\s*v\s*a\s*s\s*c\s*r\s*i\s*p\s*t|d\s*a\s*t\s*a|v\s*b\s*s\s*c\s*r\s*i\s*p\s*t)\s*:/gi;
const DANGEROUS_REFERENCE_LINK_PROTOCOL_RE =
  /^(\s*\[[^\]\r\n]+\]:\s*)(?:j\s*a\s*v\s*a\s*s\s*c\s*r\s*i\s*p\s*t|d\s*a\s*t\s*a|v\s*b\s*s\s*c\s*r\s*i\s*p\s*t)\s*:/gim;
const MARKDOWN_LINK_DESTINATION_RE = /\]\(([^)\r\n]*)\)/g;
const REFERENCE_LINK_DESTINATION_RE = /^(\s*\[[^\]\r\n]+\]:\s*)(\S+)(.*)$/gm;
const DANGEROUS_LINK_PROTOCOLS = ["javascript", "data", "vbscript"];
const UNSAFE_ENTITY_RE = /&(?!(?:amp|lt|gt|quot|apos|#39|#x27|#64);)(?=(?:#\d+|#x[0-9a-f]+|[a-z][a-z0-9]+);)/gi;
const HTML_ENTITY_RE = /&(?:#(\d+)|#x([0-9a-f]+)|([a-z][a-z0-9]+));/gi;
const NAMED_PROTOCOL_ENTITIES: Record<string, string> = {
  colon: ":",
  tab: "\t",
  newline: "\n"
};

/** Escape raw HTML/entity tricks without disabling normal GitHub-flavored Markdown. */
function escapeRawHtml(value: string): string {
  return value.replace(UNSAFE_ENTITY_RE, "&amp;").replaceAll("<", "&lt;");
}

/** Render mention markers as entities so generated Markdown cannot notify users or teams. */
function neutralizeMentions(value: string): string {
  return value.replaceAll("@", "&#64;");
}

function decodeProtocolHtmlEntity(match: string, decimal: string, hex: string, named: string): string {
  const codePoint = decimal ? Number.parseInt(decimal, 10) : hex ? Number.parseInt(hex, 16) : Number.NaN;
  if (Number.isFinite(codePoint)) {
    try {
      return String.fromCodePoint(codePoint);
    } catch {
      return match;
    }
  }
  return NAMED_PROTOCOL_ENTITIES[named?.toLowerCase()] ?? match;
}

function decodeProtocolPercentEncoding(value: string): string {
  return value.replace(/%([0-9a-f]{2})/gi, (match, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16))
  );
}

function normalizedLinkDestination(value: string): string {
  let normalized = value.trimStart().slice(0, 256);
  for (let index = 0; index < 3; index += 1) {
    const decoded = decodeProtocolPercentEncoding(normalized).replace(
      HTML_ENTITY_RE,
      decodeProtocolHtmlEntity
    );
    if (decoded === normalized) {
      break;
    }
    normalized = decoded;
  }
  return normalized
    .normalize("NFKC")
    .split("")
    .filter((char) => {
      const codePoint = char.codePointAt(0) ?? 0;
      return !/\s/.test(char) && codePoint > 0x1f && codePoint !== 0x7f;
    })
    .join("")
    .toLowerCase();
}

function hasDangerousLinkProtocol(destination: string): boolean {
  const normalized = normalizedLinkDestination(destination);
  return DANGEROUS_LINK_PROTOCOLS.some((protocol) => normalized.startsWith(`${protocol}:`));
}

/** Defang unsafe link protocols while preserving the surrounding Markdown link text. */
function neutralizeDangerousMarkdownLinks(value: string): string {
  return value
    .replace(DANGEROUS_MARKDOWN_LINK_PROTOCOL_RE, "$1#blocked-")
    .replace(DANGEROUS_REFERENCE_LINK_PROTOCOL_RE, "$1#blocked-")
    .replace(MARKDOWN_LINK_DESTINATION_RE, (match, destination: string) =>
      hasDangerousLinkProtocol(destination) ? match.replace(destination, `#blocked-${destination.trimStart()}`) : match
    )
    .replace(REFERENCE_LINK_DESTINATION_RE, (match, prefix: string, destination: string, suffix: string) =>
      hasDangerousLinkProtocol(destination) ? `${prefix}#blocked-${destination}${suffix}` : match
    );
}

/**
 * Sanitize generated Markdown before it is posted to GitHub. GitHub also
 * sanitizes comment rendering, but this keeps raw HTML, unsafe link protocols,
 * encoded-tag tricks, and surprise mentions out of the body we submit.
 */
export function sanitizeGitHubMarkdown(markdown: string): string {
  return neutralizeMentions(escapeRawHtml(neutralizeDangerousMarkdownLinks(markdown)));
}
