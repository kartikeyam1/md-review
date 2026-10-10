import type MarkdownIt from 'markdown-it'

// Spec #5 rule 5: every table scrolls sideways inside its own focusable box, so
// a wide table never widens the page. The wrapper carries no data-line-* (the
// table keeps its own range).
export const TABLE_SCROLL_OPEN = '<div class="table-scroll" data-testid="table-scroll" tabindex="0" role="region" aria-label="Table">'
export const TABLE_SCROLL_CLOSE = '</div>'

export function tableScroll(md: MarkdownIt) {
  md.renderer.rules.table_open = (tokens, idx, options, _env, self) => TABLE_SCROLL_OPEN + self.renderToken(tokens, idx, options)
  md.renderer.rules.table_close = (tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options) + TABLE_SCROLL_CLOSE
}
