// #29 Slides view — unit acceptance tests for the splitter
// (docs/build/specs/29-slides.md rules 2–5, 12; AC-29.2, AC-29.3, AC-29.18 split half; 00 §5).
import { describe, it, expect } from 'vitest'
import { splitSlides, slideForHeading, clampSlide } from '@/composables/useSlides'

const text = (html: string) => {
  const d = document.createElement('div')
  d.innerHTML = html
  return d.textContent!.replace(/\s+/g, ' ').trim()
}

describe('#29 splitSlides', () => {
  it('AC-29.1 split: # T + intro, ## A, ## B, ## C → 4 slides, the first a title slide', () => {
    const s = splitSlides('# T\n\nIntro.\n\n## A\n\na\n\n## B\n\nb\n\n## C\n\nc\n')
    expect(s.map((x) => x.kind)).toEqual(['title', 'content', 'content', 'content'])
    expect(s.map((x) => x.headingText)).toEqual(['T', 'A', 'B', 'C'])
    expect(s.map((x) => x.headingId)).toEqual(['t', 'a', 'b', 'c'])
    expect(text(s[0]!.html)).toBe('T Intro.')
  })

  it('AC-29.2 --- splits, a --- directly before ## B adds no empty slide, setext B\\n--- is a heading', () => {
    const src = '## A\n\none\n\n---\n\ntwo\n\n---\n\n## B\n\nthree\n\nSetext\n---\n\nfour\n'
    const s = splitSlides(src)
    expect(s.map((x) => text(x.html))).toEqual(['A one', 'two', 'B three', 'Setext four'])
    expect(s.every((x) => text(x.html) !== '')).toBe(true)
    expect(s[3]!.headingText).toBe('Setext')
    expect(s.some((x) => /<hr/.test(x.html))).toBe(false)
  })

  it('AC-29.2 *** and ___ also split; consecutive breaks never make empty slides', () => {
    const s = splitSlides('a\n\n***\n\nb\n\n___\n\n---\n\n---\n\nc\n')
    expect(s.map((x) => text(x.html))).toEqual(['a', 'b', 'c'])
  })

  it('AC-29.3 a --- inside a blockquote and ## X inside a list item never split', () => {
    const s = splitSlides('## A\n\n> quote\n>\n> ---\n>\n> more\n\n- item\n\n  ## X\n\n  body\n')
    expect(s).toHaveLength(1)
    expect(text(s[0]!.html)).toContain('X')
  })

  it('H3–H6 never split; --- inside a fence is code', () => {
    const s = splitSlides('## A\n\n### Sub\n\n```\n---\n## not a heading\n```\n')
    expect(s).toHaveLength(1)
  })

  it('content before the first boundary is its own slide; two H1s are two title slides; a doc starting at ## has no title slide', () => {
    expect(splitSlides('Lead para.\n\n# One\n\n# Two\n').map((x) => x.kind)).toEqual(['content', 'title', 'title'])
    expect(splitSlides('## A\n\nx\n').map((x) => x.kind)).toEqual(['content'])
  })

  it('AC-29.18 a doc with no headings is exactly one slide; an empty doc / front matter only is one empty slide', () => {
    expect(splitSlides('Just text.\n\nMore text.\n')).toHaveLength(1)
    expect(splitSlides('')).toHaveLength(1)
    const fm = splitSlides('---\ntitle: X\n---\n')
    expect(fm).toHaveLength(1)
    expect(text(fm[0]!.html)).not.toContain('title')
  })

  it('rule 5: agent-only sections never appear; notes are removed from the canvas and attached to their slide', () => {
    const src = '## A\n\nSlide A.\n\n<!-- notes -->\nSay hi\n<!-- /notes -->\n\n<!-- agent -->\nAgent secret.\n<!-- /agent -->\n\n## B\n\nSlide B.\n'
    const s = splitSlides(src)
    expect(s).toHaveLength(2)
    expect(text(s[0]!.html)).toBe('A Slide A.')
    expect(text(s[0]!.notesHtml)).toBe('Say hi')
    expect(s[1]!.notesHtml).toBe('')
    expect(s.map((x) => x.html + x.notesHtml).join('')).not.toContain('Agent secret')
  })

  it('rule 3: a slide whose only content is a notes block or an agent section is dropped', () => {
    const s = splitSlides('## A\n\na\n\n---\n\n<!-- notes -->\nonly notes\n<!-- /notes -->\n\n---\n\n<!-- agent -->\nhidden\n<!-- /agent -->\n\n## B\n\nb\n')
    expect(s.map((x) => text(x.html))).toEqual(['A a', 'B b'])
  })

  it('heading ids match the read view (full-source dedupe) and front matter is not shown', () => {
    const src = '---\ntitle: X\n---\n<!-- agent -->\n## Details\n<!-- /agent -->\n\n## Details\n\nshown\n'
    const s = splitSlides(src)
    expect(s.map((x) => x.headingId)).toEqual(['details-1'])
    expect(text(s[0]!.html)).toBe('Details shown')
    expect(s[0]!.startLine).toBe(7)
  })

  it('rendering parity: code is highlighted with the #14 toolbar, callouts and tables render (details are opened by SlidesView — e2e)', () => {
    const src = '## A\n\n```js\nconst x = 1\n```\n\n> [!WARNING]\n> Careful\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n<details><summary>More</summary>\n\nHidden body\n\n</details>\n'
    const d = document.createElement('div')
    d.innerHTML = splitSlides(src)[0]!.html
    expect(d.querySelector('[data-testid="code-block"] .hljs-keyword, [data-testid="code-block"] [class^="hljs-"]')).not.toBeNull()
    expect(d.querySelector('[data-testid="callout"][data-callout="warning"]')).not.toBeNull()
    expect(d.querySelector('table')).not.toBeNull()
  })

  it('rule 12 helpers: slideForHeading finds the slide holding an id; clampSlide handles missing/invalid/out-of-range', () => {
    const s = splitSlides('# T\n\n## A\n\n### Deep\n\n## B\n')
    expect(slideForHeading(s, 'deep')).toBe(1)
    expect(slideForHeading(s, 'b')).toBe(2)
    expect(slideForHeading(s, 'nope')).toBe(-1)
    expect(clampSlide(null, 3)).toBe(1)
    expect(clampSlide('abc', 3)).toBe(1)
    expect(clampSlide('2.5', 3)).toBe(1)
    expect(clampSlide('0', 3)).toBe(1)
    expect(clampSlide('-2', 3)).toBe(1)
    expect(clampSlide('99', 3)).toBe(3)
    expect(clampSlide('2', 3)).toBe(2)
  })
})
