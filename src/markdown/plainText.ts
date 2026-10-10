import type Token from 'markdown-it/lib/token.mjs'

// The plain text of an inline token run (spec #3 rule 2, used by #5 docTitle
// and #3 heading ids/TOC): text and inline code content, link *text* (never the
// URL), image alt text, inline HTML tags dropped, entities decoded, line breaks
// as spaces. Always from tokens, never from DOM textContent (00 §2.5), so
// controls added to rendered headings can never leak into it.
export function plainText(children: Token[] | null | undefined): string {
  return rawText(children).trim()
}

function rawText(children: Token[] | null | undefined): string {
  let out = ''
  for (const t of children ?? []) {
    switch (t.type) {
      case 'text':
      case 'text_special':
      case 'code_inline':
        out += t.content
        break
      case 'image':
        out += rawText(t.children)
        break
      case 'softbreak':
      case 'hardbreak':
        out += ' '
        break
      default:
        // link_open/close, em/strong markers, html_inline: no text of their own.
        if (t.children) out += rawText(t.children)
    }
  }
  return out
}
