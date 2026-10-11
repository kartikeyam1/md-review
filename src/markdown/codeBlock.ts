import type MarkdownIt from 'markdown-it'
import type { RenderRule } from 'markdown-it/lib/renderer.mjs'

// Spec #14 rules 1–3: every non-mermaid code block (fenced and indented) is
// wrapped in a `code-block` box with a toolbar — the fence's language label and
// a Copy button — above the original <pre>. The <pre> keeps its data-line-*
// range (comments address it); the wrapper carries none (00 §4.4). The click
// behaviour lives in src/preview/codeCopy.ts.

// The copy / check icon is one masked span (preview.css), keeping SVG markup out of the entry JS (#6 budget).
const ICON = '<span class="code-copy-icon" aria-hidden="true"></span>'

/** Rule 3: the first word of the info string, lower-cased, without a `{…}` attribute suffix ('' = no label). */
export function codeLanguageLabel(info: string): string {
  const word = info.trim().split(/\s+/)[0] ?? ''
  return word.replace(/\{.*$/, '').toLowerCase()
}

export function codeBlockHtml(pre: string, label: string, escapeHtml: (s: string) => string): string {
  const lang = label ? `<span class="code-lang-label" data-testid="code-lang-label">${escapeHtml(label)}</span>` : ''
  const aria = label ? `Copy ${escapeHtml(label)} code` : 'Copy code'
  return '<div class="code-block" data-testid="code-block">'
    + '<div class="code-toolbar" data-testid="code-toolbar" data-export-strip>'
    + lang
    + `<button type="button" class="code-copy-btn" data-testid="code-copy-btn" data-state="idle" aria-label="${aria}">`
    + `${ICON}<span class="code-copy-text">Copy</span></button>`
    + '</div>'
    + pre.replace(/\n$/, '')
    + '</div>\n'
}

export function codeBlock(md: MarkdownIt) {
  const wrap = (inner: RenderRule, labelled: boolean): RenderRule => (tokens, idx, options, env, slf) => {
    const html = inner(tokens, idx, options, env, slf)
    // Mermaid fences render as <div class="mermaid"> and stay unwrapped (spec Decisions).
    // Relies on lineDataPlugin's output shape: register this plugin after it and
    // before any later fence wrapper (#29 slides).
    if (!html.startsWith('<pre')) return html
    const label = labelled ? codeLanguageLabel(md.utils.unescapeAll(tokens[idx]!.info)) : ''
    return codeBlockHtml(html, label, md.utils.escapeHtml)
  }
  md.renderer.rules.fence = wrap(md.renderer.rules.fence!, true)
  md.renderer.rules.code_block = wrap(md.renderer.rules.code_block!, false)
}
