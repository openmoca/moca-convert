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
