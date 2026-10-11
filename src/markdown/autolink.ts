import type MarkdownIt from 'markdown-it'
import type Token from 'markdown-it/lib/token.mjs'

// Spec #5 rule 15: links whose visible text is their target — linkified bare
// URLs, `<…>` autolinks, and `[https://x](https://x)` — get class `autolink`,
// so print does not repeat the URL after them.
function isAutolink(tokens: Token[], i: number): boolean {
  const open = tokens[i]!
  if (open.markup === 'linkify' || open.markup === 'autolink') return true
  const href = open.attrGet('href') ?? ''
  let text = ''
  for (let j = i + 1; j < tokens.length && tokens[j]!.type !== 'link_close'; j++) {
    const t = tokens[j]!
    if (t.type === 'text' || t.type === 'code_inline' || t.type === 'text_special') text += t.content
    else return false
  }
  return text !== '' && text === href
}

export function autolink(md: MarkdownIt) {
  md.core.ruler.push('autolink_class', (state) => {
    for (const block of state.tokens) {
      if (block.type !== 'inline' || !block.children) continue
      const kids = block.children
      kids.forEach((t, i) => {
        if (t.type === 'link_open' && isAutolink(kids, i)) t.attrJoin('class', 'autolink')
      })
    }
  })
}
