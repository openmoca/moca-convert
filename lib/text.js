// Helpers shared by adapters that write Markdown from text that was not
// written as Markdown (YouTube descriptions, text extracted from PDFs).

// Source text is shown as written, not interpreted as Markdown: characters
// that would start emphasis, links or HTML are escaped. Bare URLs become
// autolinks.
export function escapeInline(text) {
  return String(text)
    .split(/(https?:\/\/[^\s<>]+)/)
    .map((part, i) => (i % 2 === 1 ? `<${part}>` : part.replace(/([\\`*_[\]<>|])/g, '\\$1')))
    .join('');
}

// Multi-line text: blank lines separate paragraphs and single line breaks are
// kept as hard breaks. A line that would start a heading, list, quote or
// code block is escaped.
export function escapeText(text) {
  return text
    .split(/\n\s*\n/)
    .map((para) =>
      para
        .split('\n')
        .map((line) => escapeLineStart(escapeInline(line.trim())))
        .filter(Boolean)
        .join('\\\n'))
    .filter(Boolean)
    .join('\n\n');
}

/** Escapes a line start that Markdown would read as a heading, list or quote. */
export function escapeLineStart(line) {
  return line.replace(/^([#>+-])/, '\\$1').replace(/^(\d+)([.)])/, '$1\\$2');
}

/** First non-empty line, trimmed. */
export function firstLine(text) {
  return text.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
}

/** A one-line summary for `description`: the first line, cut at a sentence when long. */
export function summary(text) {
  const line = firstLine(text ?? '');
  if (line.length <= 300) return line || undefined;
  const cut = line.slice(0, 300);
  const stop = cut.lastIndexOf('. ');
  return stop > 80 ? cut.slice(0, stop + 1) : `${cut.slice(0, cut.lastIndexOf(' '))}…`;
}

/** `base`, or `base-2`, `base-3`… when `taken` already has it; records the result. */
export function uniqueSlug(base, taken) {
  let slug = base;
  for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`;
  taken.add(slug);
  return slug;
}

export function turtleString(text) {
  return `"${String(text).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r')}"`;
}

/**
 * An http or https URL from input, parsed and rebuilt, or undefined. The
 * rebuilt form percent-encodes spaces, quotes and angle brackets, so it is
 * safe inside a Markdown link destination (`<...>`) and in YAML. URLs with
 * other schemes, or with a user name or password, are refused.
 * @param {unknown} value
 * @returns {string|undefined}
 */
export function httpUrl(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u001f\u007f\s]/.test(value)) return undefined;
  let url;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password || !url.hostname) return undefined;
  return url.href;
}

/**
 * A path as an IRI fragment or path: each `/`-separated segment
 * percent-encoded, so spaces, quotes and angle brackets cannot end a Turtle
 * IRI (`<...>`) early.
 * @param {string} path
 */
export function iriPath(path) {
  return path.split('/').map((segment) => encodeURIComponent(segment)).join('/');
}

/**
 * Short text from input shown on one line, such as a PDF page label: control
 * and format characters removed, white space collapsed, at most `max`
 * characters. Undefined when nothing is left.
 * @param {unknown} value
 * @param {number} [max]
 */
export function oneLine(value, max = 32) {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, max).trim();
  return text || undefined;
}

/**
 * A YYYYMMDD date that exists, as YYYY-MM-DD, or undefined.
 * @param {unknown} value
 */
export function compactDate(value) {
  const m = typeof value === 'string' ? /^(\d{4})(\d{2})(\d{2})$/.exec(value) : null;
  if (!m) return undefined;
  const iso = `${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(iso) ? iso : undefined;
}
