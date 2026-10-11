// #27 templates — unit tests for the pure FE logic: the "Use {{title}}" replacement (rule 15),
// picker ordering and filtering (rule 10), the 1 MB limit, error text and the theme read for the
// preview.
// Browser behaviour: tests/e2e/items/27-templates.test.mjs. Server: server/test-items/27-*.
import { describe, it, expect } from 'vitest'
import {
  applyTitleVar, orderTemplates, filterTemplates, showTemplateFilter, FILTER_THRESHOLD,
  contentBytes, tooLarge, MAX_TEMPLATE_BYTES, TOO_LARGE_MESSAGE, apiErrorText, themeFromRoot,
  collectionChoice, type TemplateSummary,
} from '@/composables/templateLogic'

const tpl = (over: Partial<TemplateSummary>): TemplateSummary => ({
  id: 'tpl-x', name: 'X', description: '', contentType: 'markdown', mode: 'publish',
  collectionId: null, collection: null, builtin: false, variables: [], ...over,
})

describe('applyTitleVar — markdown (rule 15)', () => {
  it('replaces the text of the first "# " heading only', () => {
    const r = applyTitleVar('Intro\n\n# Incident review\n\nBody\n\n# Second\n', 'markdown')
    expect(r).toEqual({ content: 'Intro\n\n# {{title}}\n\nBody\n\n# Second\n', replaced: true })
  })

  it('ignores ## headings and headings inside fenced code', () => {
    const md = '## Not this\n\n```md\n# Not in code\n```\n\n~~~\n# nor here\n~~~\n# Yes this\n'
    expect(applyTitleVar(md, 'markdown').content).toBe('## Not this\n\n```md\n# Not in code\n```\n\n~~~\n# nor here\n~~~\n# {{title}}\n')
  })

  it('keeps CRLF line endings and up to 3 leading spaces', () => {
    expect(applyTitleVar('  # Title\r\nbody\r\n', 'markdown').content).toBe('  # {{title}}\r\nbody\r\n')
  })

  it('a doc with no heading is unchanged (replaced: false)', () => {
    const md = 'Just text\n#hashtag is not a heading\n    # indented code\n'
    expect(applyTitleVar(md, 'markdown')).toEqual({ content: md, replaced: false })
  })

  it('inserts {{title}} literally (no $-pattern expansion from the heading text)', () => {
    expect(applyTitleVar('# Costs $& $1 \\o/\n', 'markdown').content).toBe('# {{title}}\n')
  })
})

describe('applyTitleVar — html (rule 15)', () => {
  it('replaces the <title> text and the first <h1> text', () => {
    const html = '<!doctype html><html><head><title>Incident review</title></head><body><h1 class="t">Incident <b>review</b></h1><h1>Two</h1></body></html>'
    expect(applyTitleVar(html, 'html')).toEqual({
      content: '<!doctype html><html><head><title>{{title}}</title></head><body><h1 class="t">{{title}}</h1><h1>Two</h1></body></html>',
      replaced: true,
    })
  })

  it('works with only one of the two, and is unchanged without either', () => {
    expect(applyTitleVar('<p>x</p><H1>Hi</H1>', 'html').content).toBe('<p>x</p><H1>{{title}}</H1>')
    expect(applyTitleVar('<title>T</title><h2>x</h2>', 'html').content).toBe('<title>{{title}}</title><h2>x</h2>')
    expect(applyTitleVar('<p>no heading</p>', 'html')).toEqual({ content: '<p>no heading</p>', replaced: false })
  })

  it('does not treat <h10> / <h1x> as an h1', () => {
    expect(applyTitleVar('<h1x>a</h1x>', 'html').replaced).toBe(false)
  })
})

describe('picker ordering and filtering (rule 10)', () => {
  const list = [
    tpl({ id: 'tpl-b', name: 'beta' }),
    tpl({ id: 'seed-weekly-update', name: 'Weekly leadership update', builtin: true }),
    tpl({ id: 'tpl-a', name: 'Alpha', description: 'incident follow-up' }),
    tpl({ id: 'seed-design-doc', name: 'Design doc', builtin: true, description: 'Problem, options, decision' }),
  ]

  it('builtins first (in the order given), then user templates by name, case-insensitive', () => {
    expect(orderTemplates(list).map((t) => t.id)).toEqual(['seed-weekly-update', 'seed-design-doc', 'tpl-a', 'tpl-b'])
  })

  it('does not mutate its input', () => {
    const copy = list.map((t) => t.id)
    orderTemplates(list)
    expect(list.map((t) => t.id)).toEqual(copy)
  })

  it('filters by name or description, case-insensitive; blank shows all', () => {
    expect(filterTemplates(list, '  ').length).toBe(4)
    expect(filterTemplates(list, 'DESIGN').map((t) => t.id)).toEqual(['seed-design-doc'])
    expect(filterTemplates(list, 'incident').map((t) => t.id)).toEqual(['tpl-a'])
    expect(filterTemplates(list, 'zzz')).toEqual([])
  })

  it('the filter box appears only with more than 8 templates', () => {
    expect(FILTER_THRESHOLD).toBe(8)
    expect(showTemplateFilter(8)).toBe(false)
    expect(showTemplateFilter(9)).toBe(true)
  })
})

describe('collection default in the picker (rule 10, edge: deleted default collection)', () => {
  const cols = [{ id: 'c1', name: 'Ops' }]
  it('the template collection when it still exists, else Unfiled ("")', () => {
    expect(collectionChoice(tpl({ collectionId: 'c1' }), cols)).toBe('c1')
    expect(collectionChoice(tpl({ collectionId: 'gone' }), cols)).toBe('')
    expect(collectionChoice(tpl({ collectionId: null }), cols)).toBe('')
  })
})

describe('size limit and errors', () => {
  it('counts UTF-8 bytes, limit 1 MB', () => {
    expect(contentBytes('é')).toBe(2)
    expect(MAX_TEMPLATE_BYTES).toBe(1024 * 1024)
    expect(tooLarge('a'.repeat(MAX_TEMPLATE_BYTES))).toBe(false)
    expect(tooLarge('a'.repeat(MAX_TEMPLATE_BYTES + 1))).toBe(true)
    expect(tooLarge('é'.repeat(MAX_TEMPLATE_BYTES / 2 + 1))).toBe(true)
    expect(TOO_LARGE_MESSAGE).toMatch(/1 MB/)
  })

  it('apiErrorText prefers the server message, else a status fallback', () => {
    expect(apiErrorText(400, { error: 'title is required' })).toBe('title is required')
    expect(apiErrorText(500, null)).toMatch(/500/)
    expect(apiErrorText(0, null)).toMatch(/reach the server/i)
  })
})

describe('theme for the preview', () => {
  const root = (...cls: string[]) => ({ classList: { contains: (c: string) => cls.includes(c) } })
  it('reads the six themes from the <html> classes applyTheme sets', () => {
    expect(themeFromRoot(root())).toBe('light')
    expect(themeFromRoot(root('dark'))).toBe('dark')
    expect(themeFromRoot(root('github-theme'))).toBe('github-light')
    expect(themeFromRoot(root('github-theme', 'dark'))).toBe('github-dark')
    expect(themeFromRoot(root('locus-theme'))).toBe('locus-light')
    expect(themeFromRoot(root('locus-theme', 'dark'))).toBe('locus-dark')
  })
})
