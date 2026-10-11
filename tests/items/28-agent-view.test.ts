// #28 Human view vs agent view — unit acceptance tests
// (docs/build/specs/28-agent-view.md rules 1–9, 15; AC-28.5, 28.6, 28.7; 00 §4.4, §4.8, §5).
// The strip/range finder is shared/agentSections.mjs (the server uses the same module and
// the same fixture table); rendering goes through the preview's own markdown-it.
import { describe, it, expect } from 'vitest'
import { useMarkdown } from '@/composables/useMarkdown'
import { extractHeadings } from '@/markdown/headingIds'
import { docTitle } from '@/composables/useDocTitle'
import { resolveDocAxes } from '@/composables/useDocState'
import { findAgentSections, stripAgentSections } from '@shared/agentSections.mjs'
// @ts-expect-error — plain .mjs fixture table shared with the server test
import { AGENT_FIXTURES } from './28-agent-fixtures.mjs'

type Fixture = { name: string; src: string; sections: [number, number, string][]; human: string }

function render(src: string, agentView: 'human' | 'agent' = 'human'): HTMLElement {
  const div = document.createElement('div')
  div.innerHTML = useMarkdown().renderHtml(src, { agentView })
  return div
}

describe('#28 shared strip / range finder (fixture table)', () => {
  for (const f of AGENT_FIXTURES as Fixture[]) {
    it(`fixture: ${f.name}`, () => {
      expect(findAgentSections(f.src).map((s) => [s.start, s.end, s.label])).toEqual(f.sections)
      const r = stripAgentSections(f.src)
      expect(r.markdown).toBe(f.human)
      expect(r.count).toBe(f.sections.length)
    })
  }
})

describe('#28 FE token membership = server line ranges', () => {
  const norm = (el: HTMLElement) => el.textContent!.replace(/\s+/g, ' ').trim()
  for (const f of AGENT_FIXTURES as Fixture[]) {
    it(`human render shows exactly the stripped text: ${f.name}`, () => {
      expect(norm(render(f.src))).toBe(norm(render(stripAgentSections(f.src).markdown)))
    })
  }
})

describe('#28 rendering', () => {
  it('AC-28.5 a fenced code block containing marker lines shows them in <pre> and hides nothing after it', () => {
    const src = '```html\n<!-- agent -->\ninside code\n<!-- /agent -->\n```\n\nAfter the fence.\n'
    const root = render(src)
    const pre = root.querySelector('pre')!
    expect(pre.textContent).toContain('<!-- agent -->')
    expect(pre.textContent).toContain('<!-- /agent -->')
    expect(root.textContent).toContain('After the fence.')
    expect(root.querySelector('[data-testid="agent-section"]')).toBeNull()
  })

  it('AC-28.6 an unclosed opener at line 10 hides lines 10..EOF in human view; a stray closer changes nothing', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `Line ${i} text.\n`)
    const src = `${lines.join('\n')}\n<!-- agent -->\nTail one.\n\nTail two.\n`
    const opener = src.split('\n').indexOf('<!-- agent -->')
    expect(findAgentSections(src)).toEqual([{ start: opener, end: src.split('\n').length - 2, closed: false, label: '' }])
    const root = render(src)
    expect(root.textContent).toContain('Line 9 text.')
    expect(root.textContent).not.toContain('Tail one.')
    expect(root.textContent).not.toContain('Tail two.')
    const stray = 'a\n<!-- /agent -->\nb\n'
    expect(stripAgentSections(stray)).toEqual({ markdown: stray, count: 0 })
    expect(render(stray).textContent).toContain('b')
  })

  it('AC-28.7 heading ids and data-line-start come from the full source in both views', () => {
    const src = '# T\n\n<!-- agent -->\n## Details\n\nHidden para.\n<!-- /agent -->\n\n## Details\n\nShown para.\n'
    const srcLines = src.split('\n')
    for (const view of ['human', 'agent'] as const) {
      const root = render(src, view)
      const visibleLater = [...root.querySelectorAll('h2')].find((h) => h.nextElementSibling?.textContent === 'Shown para.')!
      expect(visibleLater.id, view).toBe('details-1')
      for (const el of root.querySelectorAll<HTMLElement>('[data-line-start]')) {
        const line = Number(el.dataset.lineStart)
        const first = srcLines[line]!.replace(/^#+\s*/, '').trim()
        if (el.tagName === 'P' || /^H\d$/.test(el.tagName)) expect(el.textContent!.trim(), `${view} ${el.tagName}`).toBe(first)
      }
    }
    const agent = render(src, 'agent')
    expect(agent.querySelector('section [id="details"]')).not.toBeNull()
    expect(render(src, 'human').querySelector('#details')).toBeNull()
  })

  it('rule 7: human view leaves no DOM for sections or markers (no comment nodes)', () => {
    const root = render('a\n\n<!-- agent -->\nsecret\n<!-- /agent -->\n\nb\n')
    expect(root.innerHTML).not.toMatch(/agent|secret/)
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_COMMENT)
    expect(walker.nextNode()).toBeNull()
  })

  it('rule 9: agent view wraps each section (index, label chip, escaped label), empty sections included', () => {
    const src = 'a\n\n<!-- agent -->\n<!-- /agent -->\n\n<!-- agent: <b>x</b> & y -->\n| A |\n|---|\n| 1 |\n<!-- /agent -->\n'
    const root = render(src, 'agent')
    const secs = [...root.querySelectorAll<HTMLElement>('section.agent-only[data-testid="agent-section"]')]
    expect(secs.map((s) => s.dataset.agentIndex)).toEqual(['0', '1'])
    expect(secs[0]!.querySelector('[data-testid="agent-section-label"]')!.textContent!.trim()).toBe('Agent-only')
    expect(secs[1]!.querySelector('[data-testid="agent-section-label"]')!.textContent!.trim()).toBe('Agent-only · <b>x</b> & y')
    expect(secs[1]!.querySelector('b')).toBeNull()
    expect(secs[1]!.querySelector('table')).not.toBeNull()
    expect(secs[0]!.hasAttribute('data-line-start')).toBe(false)
    expect(root.innerHTML).not.toMatch(/<!--\s*\/?agent/i)
  })

  it('rule 5: notes markers are not agent sections and their content renders in read/agent views', () => {
    const root = render('## A\n\n<!-- notes -->\nSay hi\n<!-- /notes -->\n')
    expect(root.textContent).toContain('Say hi')
    expect(root.querySelector('[data-testid="agent-section"]')).toBeNull()
  })

  it('rule 7 / §5: TOC headings and docTitle use the human view', () => {
    const src = '<!-- agent -->\n# Hidden Title\n## Hidden H2\n<!-- /agent -->\n\n# Visible\n\n## Shown\n'
    expect(extractHeadings(src).map((h) => h.text)).toEqual(['Visible', 'Shown'])
    expect(extractHeadings(src, 'agent').map((h) => h.text)).toEqual(['Hidden Title', 'Hidden H2', 'Visible', 'Shown'])
    expect(docTitle({ content: src })).toBe('Visible')
  })

  it('renderWithHeadings reports the section count and the hidden heading ids and line ranges', () => {
    const src = '# T\n\n<!-- agent -->\n## Deep\n<!-- /agent -->\n\n<!-- agent -->\nx\n<!-- /agent -->\n'
    const r = useMarkdown().renderWithHeadings(src)
    expect(r.agentSections).toBe(2)
    expect(r.hiddenIds).toEqual(['deep'])
    expect(r.hiddenRanges).toEqual([{ start: 2, end: 4 }, { start: 6, end: 8 }])
    const a = useMarkdown().renderWithHeadings(src, { agentView: 'agent' })
    expect(a.hiddenIds).toEqual([])
    expect(a.headings.map((h) => h.id)).toEqual(['t', 'deep'])
  })

  it('front matter: line numbers stay absolute and a section after it is hidden', () => {
    const src = '---\ntitle: X\n---\n\n<!-- agent -->\nsecret\n<!-- /agent -->\n\nShown.\n'
    const root = render(src)
    expect(root.textContent).not.toContain('secret')
    const p = [...root.querySelectorAll<HTMLElement>('p')].find((e) => e.textContent === 'Shown.')!
    expect(p.dataset.lineStart).toBe('8')
  })
})

describe('#28 view axis (00 §1.3, §4.1)', () => {
  const base = { routeKind: 'doc' as const, embed: false, paneMode: 'preview' as const, pasteId: 'abc', mode: 'publish' as const }
  it('the reader view resolves to agent; edit/split win for editors; embeds stay read', () => {
    expect(resolveDocAxes({ ...base, readerView: 'agent' }).view).toBe('agent')
    expect(resolveDocAxes({ ...base, readerView: 'read' }).view).toBe('read')
    expect(resolveDocAxes({ ...base, readerView: 'agent', paneMode: 'split' }).view).toBe('split')
    expect(resolveDocAxes({ ...base, readerView: 'agent', embed: true }).view).toBe('read')
    expect(resolveDocAxes({ ...base, readerView: 'agent', routeKind: 'pinned' }).view).toBe('agent')
  })
})
