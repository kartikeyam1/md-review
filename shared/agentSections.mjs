// Agent-only sections (#28) and speaker notes (#29) — one definition for the
// server and the FE (00 §4.8: pure, dependency-free ESM; the server loads it
// with require(), the FE through the `@shared` alias), so the raw/MCP human
// view and the rendered human view can never disagree about what is hidden.
//
//   <!-- agent -->            opens an agent-only section (optional label:
//   <!-- agent: Raw SQL -->   `<!-- agent: <label> -->`)
//   <!-- /agent -->           closes it
//   <!-- notes --> … <!-- /notes -->   reserved for #29 speaker notes
//
// A marker is a whole line (≤ 3 leading spaces, any trailing whitespace, case
// and inner whitespace free) at the document top level: never inside front
// matter, fenced code, HTML blocks, list items or blockquotes. No nesting: an
// opener inside an open section is ignored, the first closer ends it, a stray
// closer is ignored, an unclosed opener runs to the end of the document.
// The scan is line based (the server has no markdown parser); its container
// tracking follows CommonMark closely enough for marker lines.

// The grammar of rule 1 — open `^ {0,3}<!--\s*agent(?:\s*:\s*(.*?))?\s*-->\s*$` (i),
// close `^ {0,3}<!--\s*\/agent\s*-->\s*$` (i) — matched without a backtracking regex:
// that pattern is cubic on a long `<!-- agent: …` line with no `-->` (ReDoS).

/** The comment body of a whole-line `<!-- … -->` (≤ 3 leading spaces), trimmed; null otherwise. */
function commentBody(line) {
  let i = 0
  while (i < 3 && line[i] === ' ') i++
  if (!line.startsWith('<!--', i)) return null
  const t = line.trimEnd()
  if (t.length < i + 7 || !t.endsWith('-->')) return null
  return t.slice(i + 4, -3).trim()
}

/** `word` opener (`<!-- word -->`, or with `: label` when `withLabel`): { label } or null. */
function matchOpen(line, word, withLabel) {
  const body = commentBody(line)
  if (body === null || body.slice(0, word.length).toLowerCase() !== word) return null
  const rest = body.slice(word.length).trimStart()
  if (rest === '') return { label: '' }
  return withLabel && rest[0] === ':' ? { label: rest.slice(1).trim() } : null
}

/** `word` closer: `<!-- /word -->`. */
function matchClose(line, word) {
  const body = commentBody(line)
  return body !== null && body.toLowerCase() === `/${word}`
}

const AGENT = { maybe: /<!--\s*\/?agent/i, open: (l) => matchOpen(l, 'agent', true), close: (l) => matchClose(l, 'agent') }
const NOTES = { maybe: /<!--\s*\/?notes/i, open: (l) => matchOpen(l, 'notes', false), close: (l) => matchClose(l, 'notes') }
const isMarkerLine = (l) => !!(AGENT.open(l) || AGENT.close(l) || NOTES.open(l) || NOTES.close(l))

/** Max label length (rule 4), in code points; longer labels end in `…`. */
export const AGENT_LABEL_MAX = 80

// Same leading block as src/markdown/frontMatter.ts (it counts only with a `key: value` row).
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/

const FENCE_OPEN_RE = /^( {0,3})(`{3,}|~{3,})(.*)$/
const LIST_ITEM_RE = /^( {0,3})([-+*]|\d{1,9}[.)])( {1,4}(?=\S)| (?= {4})|[ \t]*\r?$)/
const HR_RE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/
const ATX_RE = /^ {0,3}#{1,6}(?:[ \t]|$)/
const QUOTE_RE = /^ {0,3}>/
const HTML_RAW_RE = /^ {0,3}<(script|pre|style|textarea)(?=[\s>]|$)/i
const HTML_RAW_END_RE = /<\/(script|pre|style|textarea)>/i
const HTML_COMMENT_RE = /^ {0,3}<!--/
const HTML_BLOCK_TAGS = 'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h1|h2|h3|h4|h5|h6|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul'
const HTML_BLOCK_RE = new RegExp(`^ {0,3}</?(?:${HTML_BLOCK_TAGS})(?=[\\s/>]|$)`, 'i')

const isBlank = (line) => /^[ \t\r]*$/.test(line)

const isSpace = (c) => c === ' ' || c === '\t' || c === '\r'
const isAlpha = (c) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
const isTagChar = (c) => isAlpha(c) || (c >= '0' && c <= '9') || c === '-'
const isAttrStart = (c) => isAlpha(c) || c === '_' || c === ':'
const isAttrChar = (c) => isAttrStart(c) || (c >= '0' && c <= '9') || c === '.' || c === '-'

/**
 * CommonMark HTML block type 7: a line that is one complete open or close tag
 * (any name) and nothing else. Hand-written, linear (no backtracking regex).
 */
function isCompleteTagLine(line) {
  let i = 0
  while (i < 3 && line[i] === ' ') i++
  if (line[i] !== '<') return false
  i++
  const closing = line[i] === '/'
  if (closing) i++
  if (!isAlpha(line[i] ?? '')) return false
  while (i < line.length && isTagChar(line[i])) i++
  if (closing) {
    while (isSpace(line[i] ?? '')) i++
    if (line[i] !== '>') return false
    i++
  } else {
    for (;;) {
      const before = i
      while (isSpace(line[i] ?? '')) i++
      if (line[i] === '/' || line[i] === '>') break
      if (i === before || !isAttrStart(line[i] ?? '')) return false
      while (i < line.length && isAttrChar(line[i])) i++
      const afterName = i
      while (isSpace(line[i] ?? '')) i++
      if (line[i] !== '=') { i = afterName; continue }
      i++
      while (isSpace(line[i] ?? '')) i++
      const q = line[i]
      if (q === '"' || q === "'") {
        const end = line.indexOf(q, i + 1)
        if (end < 0) return false
        i = end + 1
      } else {
        const start = i
        while (i < line.length && !isSpace(line[i]) && !'"\'=<>`'.includes(line[i])) i++
        if (i === start) return false
      }
    }
    if (line[i] === '/') i++
    if (line[i] !== '>') return false
    i++
  }
  return isBlank(line.slice(i))
}

/** CommonMark HTML block types 3–5: `<?` … `?>`, `<!X` … `>`, `<![CDATA[` … `]]>` → the end marker. */
function rawBlockEnd(line) {
  const t = line.replace(/^ {0,3}/, '')
  if (t.startsWith('<?')) return '?>'
  if (t.startsWith('<![CDATA[')) return ']]>'
  if (t.startsWith('<!') && isAlpha(t[2] ?? '')) return '>'
  return null
}
/** Leading columns (a tab counts to the next multiple of 4). */
function indentOf(line) {
  let col = 0
  for (const ch of line) {
    if (ch === ' ') col++
    else if (ch === '\t') col += 4 - (col % 4)
    else break
  }
  return col
}

/** Lines the front matter spans (0 when there is none), as src/markdown/frontMatter.ts counts them. */
function frontMatterLines(src) {
  const m = src.match(FRONTMATTER_RE)
  if (!m || !m[1].split(/\r?\n/).some((l) => l.includes(':'))) return 0
  return m[0].split('\n').length - 1
}

/**
 * For every line of `src`: may it be a marker? True only for lines at the
 * document top level (not front matter, code, HTML blocks, lists, quotes).
 */
export function topLevelLines(src) {
  const lines = String(src ?? '').split('\n')
  const top = new Array(lines.length).fill(false)
  let i = frontMatterLines(String(src ?? ''))
  /** Open fence: its char, length and whether it sits inside the current list item. */
  let fence = null
  /** Content indent of the outermost open list item, or -1. */
  let listW = -1
  let prevBlank = true
  /** The previous line was paragraph text (a type-7 HTML block cannot interrupt a paragraph). */
  let paraOpen = false
  /**
   * Open HTML block: 'raw' (types 1/3/4/5, until `end`), 'comment' (until
   * `-->`), 'block' (types 6/7, until a blank line).
   */
  let html = null
  /** An HTML block that starts on `line` (and does not also end there), or null. */
  const htmlStart = (line, inList) => {
    if (HTML_RAW_RE.test(line)) return HTML_RAW_END_RE.test(line) ? null : { kind: 'raw', end: HTML_RAW_END_RE, inList }
    if (HTML_COMMENT_RE.test(line)) return line.includes('-->') ? null : { kind: 'comment', inList }
    const end = rawBlockEnd(line)
    if (end) return line.indexOf(end, line.indexOf('<') + 2) >= 0 ? null : { kind: 'raw', end, inList }
    if (HTML_BLOCK_RE.test(line) || (!paraOpen && isCompleteTagLine(line))) return { kind: 'block', inList }
    return null
  }
  for (; i < lines.length; i++) {
    const line = lines[i]
    const blank = isBlank(line)
    const indent = indentOf(line)
    // A list item ends at a less indented line after a blank, or at a less
    // indented block start (anything else is a lazy paragraph continuation).
    if (listW >= 0 && !blank && indent < listW && !LIST_ITEM_RE.test(line)) {
      const blockStart = prevBlank || ATX_RE.test(line) || FENCE_OPEN_RE.test(line) || HR_RE.test(line)
        || QUOTE_RE.test(line) || HTML_COMMENT_RE.test(line) || HTML_BLOCK_RE.test(line) || HTML_RAW_RE.test(line) || !!rawBlockEnd(line)
      if (blockStart || (fence && fence.inList)) {
        listW = -1
        if (fence && fence.inList) fence = null
        if (html && html.inList) html = null
      }
    }
    if (fence) {
      const close = line.match(/^ {0,3}(`{3,}|~{3,})[ \t\r]*$/)
      if (close && close[1][0] === fence.ch && close[1].length >= fence.len) fence = null
      prevBlank = blank
      paraOpen = false
      continue
    }
    if (html) {
      if (html.kind === 'raw' && (typeof html.end === 'string' ? line.includes(html.end) : html.end.test(line))) html = null
      else if (html.kind === 'comment' && line.includes('-->')) html = null
      else if (html.kind === 'block' && blank) html = null
      prevBlank = blank
      paraOpen = false
      continue
    }
    if (blank) { prevBlank = true; paraOpen = false; continue }
    const inList = listW >= 0 && indent >= listW
    const item = line.match(LIST_ITEM_RE)
    const f = line.match(FENCE_OPEN_RE)
    let text = false
    if (f && !(f[2][0] === '`' && f[3].includes('`'))) {
      fence = { ch: f[2][0], len: f[2].length, inList }
    } else if (HR_RE.test(line)) {
      // a thematic break, never a list item
    } else if (item && !inList) {
      // A new (or sibling) top-level list item; its content starts after the marker.
      const w = item[1].length + item[2].length
      listW = item[3].length && line.length > item[0].length && !/^ {5}/.test(line.slice(w)) ? w + item[3].length : w + 1
    } else if (!inList && !QUOTE_RE.test(line)) {
      // A marker line itself is an (inline, one-line) HTML comment block.
      if (isMarkerLine(line)) {
        top[i] = true
      } else if (!ATX_RE.test(line)) {
        html = htmlStart(line, false)
        // Plain text continues a paragraph; a table row (`| …`) does not (a pipe-less line ends a table).
        text = !html && !/^ {0,3}\|/.test(line)
      }
    } else if (inList) {
      html = htmlStart(line, true)
      text = !html
    }
    paraOpen = text
    prevBlank = false
  }
  return top
}

function truncateLabel(raw) {
  const chars = Array.from(String(raw ?? '').trim())
  return chars.length > AGENT_LABEL_MAX ? `${chars.slice(0, AGENT_LABEL_MAX).join('')}…` : chars.join('')
}

function findSections(src, kind) {
  const text = String(src ?? '')
  // Most docs have no marker at all: skip the line scan.
  if (!kind.maybe.test(text)) return []
  const lines = text.split('\n')
  const top = topLevelLines(text)
  const out = []
  let open = null
  for (let i = 0; i < lines.length; i++) {
    if (!top[i]) continue
    if (!open) {
      const m = kind.open(lines[i])
      if (m) open = { start: i, label: truncateLabel(m.label) }
    } else if (kind.close(lines[i])) {
      out.push({ start: open.start, end: i, closed: true, label: open.label })
      open = null
    }
  }
  if (open) {
    // Unclosed: to the last line (a final newline adds no line of its own).
    const last = text.endsWith('\n') ? Math.max(open.start, lines.length - 2) : lines.length - 1
    out.push({ start: open.start, end: last, closed: false, label: open.label })
  }
  return out
}

/**
 * The agent-only sections of `src`, in source order: 0-based line of the
 * opener (`start`) and of the closer or last line (`end`, inclusive), whether a
 * closer was found, and the label (plain text, ≤ 80 chars + `…`; '' if none).
 */
export function findAgentSections(src) {
  return findSections(src, AGENT)
}

/** The `<!-- notes -->` blocks (#29), same grammar and rules as agent sections. */
export function findNotesSections(src) {
  return findSections(src, NOTES)
}

/** Number of agent-only sections in `src`. */
export function countAgentSections(src) {
  return findAgentSections(src).length
}

/**
 * Remove `sections` (line ranges, inclusive) from `src`; a run of ≥ 2 blank
 * lines formed where lines were removed collapses to one. Line endings kept.
 */
export function removeLineRanges(src, sections) {
  const text = String(src ?? '')
  if (!sections.length) return text
  const endsNl = text.endsWith('\n')
  const lines = text.split('\n')
  if (endsNl) lines.pop()
  const out = []
  let i = 0
  for (const s of sections) {
    for (; i < s.start && i < lines.length; i++) out.push(lines[i])
    i = Math.max(i, s.end + 1)
    let before = 0
    while (before < out.length && isBlank(out[out.length - 1 - before])) before++
    let after = 0
    while (i + after < lines.length && isBlank(lines[i + after])) after++
    if (before >= 1 && after >= 1) {
      out.length -= before - 1
      i += after
    }
  }
  for (; i < lines.length; i++) out.push(lines[i])
  return out.length ? out.join('\n') + (endsNl ? '\n' : '') : ''
}

/**
 * Rule 15: the human view of `src` — every line from an opener through its
 * closer removed (to the end when unclosed). Notes markers and front matter
 * are kept. `count` is the number of agent sections.
 */
export function stripAgentSections(src) {
  const text = String(src ?? '')
  const sections = findAgentSections(text)
  return { markdown: sections.length ? removeLineRanges(text, sections) : text, count: sections.length }
}
