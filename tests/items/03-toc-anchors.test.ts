// #3 Sticky TOC + heading ids — frozen unit acceptance tests
// (docs/build/specs/03-toc-anchors.md rules 1–9, AC-03.1, AC-03.2; 00-cross-cutting.md §2.5, §4.4).
//
// Module contract these tests pin (the spec names the file and "slugify/assignIds or
// equivalent"; keep these names):
//
//   src/markdown/headingIds.ts
//     slugify(text: string): string
//       Rule 3 + 4 on already-plain text: GitHub-compatible (= github-slugger v2 `slug()`):
//       lower-case; drop every char that is not a letter, mark, number, `_`, `-` or space;
//       replace EACH space with `-` (no collapsing, no hyphen trimming). '' -> 'section'.
//     assignIds(texts: string[]): string[]
//       Rule 5: slugify each text, then de-duplicate in order — the first occurrence keeps
//       its slug, later ones get the first `-1`, `-2`, … suffix not already used by an
//       earlier id. All results unique, none empty.
//     extractHeadings(source: string): Array<{ level: number; id: string; text: string }>
//       Every markdown heading (levels 1–6, incl. those in blockquotes/lists; never raw-HTML
//       headings, never inside code) in document order, with the SAME id the rendered
//       `useMarkdown().renderHtml(source)` puts on it, and `text` = the rule-2 plain text.
//     buildToc(headings: Array<{ level: number; id: string; text: string }>):
//         Array<{ id: string; text: string; level: number; depth: number }>
//       Rule 8 + 9: levels 1–3 only, in order; when there is exactly one H1 and it is the
//       first heading, that H1 is dropped; depth = level − (shallowest listed level), so
//       0..2. Returns [] when fewer than 2 entries remain (no TOC is rendered then).
//
//   src/composables/useMarkdown.ts  (existing) useMarkdown().renderHtml(source)
//
// Modules are imported inside each test so a missing export fails that test with a
// clear message instead of failing the whole file at import time. Expected slugs were
// checked against github-slugger@2.0.0 `slug()`.
import { describe, it, expect } from 'vitest'

type Heading = { level: number; id: string; text: string }
type TocEntry = { id: string; text: string; level: number; depth: number }
interface HeadingIdsModule {
  slugify: (text: string) => string
  assignIds: (texts: string[]) => string[]
  extractHeadings: (source: string) => Heading[]
  buildToc: (headings: Heading[]) => TocEntry[]
}

// A variable specifier keeps vite from failing the whole file at transform time while
// the module does not exist yet.
const HEADING_IDS_MODULE = '@/markdown/headingIds'

async function ids<K extends keyof HeadingIdsModule>(...names: K[]): Promise<Pick<HeadingIdsModule, K>> {
  let mod: Partial<HeadingIdsModule> = {}
  try {
    mod = (await import(/* @vite-ignore */ HEADING_IDS_MODULE)) as Partial<HeadingIdsModule>
  } catch (e) {
    throw new Error(`src/markdown/headingIds.ts could not be imported: ${(e as Error).message}`)
  }
  for (const name of names) {
    expect(typeof mod[name], `src/markdown/headingIds.ts must export ${name}()`).toBe('function')
  }
  return mod as Pick<HeadingIdsModule, K>
}

async function render(source: string): Promise<Document> {
  const { useMarkdown } = await import('@/composables/useMarkdown')
  const html = useMarkdown().renderHtml(source)
  return new DOMParser().parseFromString(`<!doctype html><body>${html}</body>`, 'text/html')
}

const headingIdsIn = (doc: Document) =>
  [...doc.body.querySelectorAll('h1, h2, h3, h4, h5, h6')].map((h) => h.getAttribute('id'))

// Rule 7 table. Source is what follows the `#`s; the level cycles 1..6 so every hN is covered.
const TABLE: Array<[string, string]> = [
  ['Hello World', 'hello-world'],
  ['Über café', 'über-café'],
  ['日本語の見出し', '日本語の見出し'],
  ["What's new?", 'whats-new'],
  ['C++ & Rust', 'c--rust'],
  ['**Bold** and *em*', 'bold-and-em'],
  ['`npm run` it', 'npm-run-it'],
  ['[Docs](https://x.io/a) here', 'docs-here'],
  ['🚀 Launch', '-launch'],
  ['!!!', 'section'],
  ['Dup', 'dup'],
  ['Dup', 'dup-1'],
  ['Dup', 'dup-2'],
]
const tableDoc = () =>
  TABLE.map(([src], i) => `${'#'.repeat((i % 6) + 1)} ${src}\n\nBody ${i + 1}.\n`).join('\n')

// ── AC-03.1 ─────────────────────────────────────────────────────────────────
describe('#3 heading ids — rule 7 table (AC-03.1)', () => {
  it('AC-03.1 the rendered h1..h6 ids equal the rule-7 table, in order, and no element has id=""', async () => {
    const doc = await render(tableDoc())
    expect(headingIdsIn(doc)).toEqual(TABLE.map(([, id]) => id))
    expect(doc.body.querySelectorAll('[id=""]').length, 'no element carries an empty id').toBe(0)
  })

  it('AC-03.1 slugify() reproduces the rule-7 slugs from plain text', async () => {
    const { slugify } = await ids('slugify')
    const plain: Array<[string, string]> = [
      ['Hello World', 'hello-world'],
      ['Über café', 'über-café'],
      ['日本語の見出し', '日本語の見出し'],
      ["What's new?", 'whats-new'],
      ['What’s new?', 'whats-new'], // typographer quote
      ['C++ & Rust', 'c--rust'],
      ['Bold and em', 'bold-and-em'],
      ['npm run it', 'npm-run-it'],
      ['Docs here', 'docs-here'],
      ['🚀 Launch', '-launch'],
    ]
    for (const [text, id] of plain) expect(slugify(text), JSON.stringify(text)).toBe(id)
  })

  it('AC-03.1 rule 4: an empty slug becomes "section" (punctuation-only, emoji-only, empty)', async () => {
    const { slugify } = await ids('slugify')
    expect(slugify('!!!')).toBe('section')
    expect(slugify('🚀')).toBe('section')
    expect(slugify('')).toBe('section')
    expect(slugify('?!.,;:')).toBe('section')
  })

  it('AC-03.1 rule 3: GitHub-compatible (github-slugger v2) on unicode, digits, `_`, `-` and spaces', async () => {
    const { slugify } = await ids('slugify')
    const cases: Array<[string, string]> = [
      ['Hello  World', 'hello--world'], // each space -> '-', no collapsing
      ['Under_score', 'under_score'], // connector punctuation kept
      ['Pre-flight', 'pre-flight'], // hyphen kept
      ['x-1', 'x-1'],
      ['Version 2.0', 'version-20'],
      ['1. First', '1-first'],
      ['100% done', '100-done'],
      ['Hello—World', 'helloworld'], // em dash is not '-'
      ['foo.bar', 'foobar'],
      ['a/b\\c', 'abc'],
      ['<tag>', 'tag'],
      ['¿Qué?', 'qué'],
      ['«quoted»', 'quoted'],
      ['ÀÉÎ', 'àéî'], // lower-cased, letters kept
      ['éclair', 'éclair'], // combining mark kept
      ['Ελληνικά Κείμενο', 'ελληνικά-κείμενο'],
      ['Привет мир', 'привет-мир'],
      ['한국어 제목', '한국어-제목'],
      ['العربية', 'العربية'],
      ['αβγ_δ', 'αβγ_δ'],
      ['emoji 👍🏽 skin', 'emoji--skin'],
      ['Café ☕ time', 'café--time'],
    ]
    for (const [text, id] of cases) expect(slugify(text), JSON.stringify(text)).toBe(id)
  })

  it('AC-03.1 rule 2: ids come from token plain text — link text not URL, image alt, no inline HTML tags, entities decoded', async () => {
    const doc = await render([
      '## See [the docs](https://example.com/very/long/path?q=1) now',
      '',
      '## Logo ![brand mark](logo.png) inline',
      '',
      '## A <span class="x">wrapped</span> word',
      '',
      '## Q&amp;A',
      '',
      '## Tom &amp; Jerry &lt;3',
      '',
    ].join('\n'))
    expect(headingIdsIn(doc)).toEqual([
      'see-the-docs-now',
      'logo-brand-mark-inline',
      'a-wrapped-word',
      'qa',
      'tom--jerry-3',
    ])
  })

  it('AC-03.1 rule 1: headings inside blockquotes and list items get ids; setext headings too; code is not a heading', async () => {
    const doc = await render([
      'Setext title',
      '============',
      '',
      '> ## Quoted heading',
      '',
      '- ### Listed heading',
      '',
      '```md',
      '## Not a heading',
      '```',
      '',
      'Setext second',
      '-------------',
      '',
    ].join('\n'))
    expect(headingIdsIn(doc)).toEqual(['setext-title', 'quoted-heading', 'listed-heading', 'setext-second'])
  })

  it('AC-03.1 rule 1: a raw-HTML heading keeps its own attributes and is not an id managed here', async () => {
    const { extractHeadings } = await ids('extractHeadings')
    const src = '<h2 id="custom-raw">Raw heading</h2>\n\n<h3>No id raw</h3>\n\n## Real heading\n'
    const doc = await render(src)
    expect(doc.getElementById('custom-raw')?.textContent).toBe('Raw heading')
    const h3 = doc.body.querySelector('h3')
    expect(h3?.getAttribute('id') ?? null, 'raw <h3> gets no generated id').toBeNull()
    expect(doc.getElementById('real-heading')?.tagName).toBe('H2')
    expect(extractHeadings(src).map((h) => h.id), 'raw-HTML headings are not headings for the TOC').toEqual(['real-heading'])
  })

  it('AC-03.1 rule 6: ids are deterministic across re-renders and fresh renderers', async () => {
    const a = headingIdsIn(await render(tableDoc()))
    const b = headingIdsIn(await render(tableDoc()))
    expect(b).toEqual(a)
  })

  it('AC-03.1 a front-matter doc: ids are assigned to the body headings only', async () => {
    const doc = await render('---\ntitle: Front matter\nowner: someone\n---\n# Body title\n\n## Part one\n\n## Part two\n')
    expect(headingIdsIn(doc)).toEqual(['body-title', 'part-one', 'part-two'])
  })
})

// ── AC-03.2 ─────────────────────────────────────────────────────────────────
describe('#3 heading ids — duplicates (AC-03.2)', () => {
  it('AC-03.2 rendered `Dup`, `Dup-1`, `Dup` -> dup, dup-1, dup-2; every id in the doc is unique', async () => {
    const doc = await render('## Dup\n\none\n\n## Dup-1\n\ntwo\n\n## Dup\n\nthree\n')
    const got = headingIdsIn(doc)
    expect(got).toEqual(['dup', 'dup-1', 'dup-2'])
    const all = [...doc.body.querySelectorAll('[id]')].map((e) => e.id)
    expect(new Set(all).size, `ids: ${all.join(', ')}`).toBe(all.length)
  })

  it('AC-03.2 assignIds() picks the first suffix not used by any earlier id', async () => {
    const { assignIds } = await ids('assignIds')
    expect(assignIds(['Dup', 'Dup-1', 'Dup'])).toEqual(['dup', 'dup-1', 'dup-2'])
    expect(assignIds(['Dup', 'Dup', 'Dup'])).toEqual(['dup', 'dup-1', 'dup-2'])
    expect(assignIds(['Dup', 'Dup', 'Dup-1'])).toEqual(['dup', 'dup-1', 'dup-1-1'])
    expect(assignIds(['a', 'a-1', 'a', 'a'])).toEqual(['a', 'a-1', 'a-2', 'a-3'])
    expect(assignIds(['!!!', '???', 'Section'])).toEqual(['section', 'section-1', 'section-2'])
    expect(assignIds(['Section', '!!!'])).toEqual(['section', 'section-1'])
  })

  it('AC-03.2 a many-duplicate doc yields unique, non-empty ids', async () => {
    const { assignIds } = await ids('assignIds')
    const texts = [...Array(30)].flatMap((_, i) => ['Notes', `Notes-${i % 7}`, '🚀', ''])
    const out = assignIds(texts)
    expect(out).toHaveLength(texts.length)
    expect(new Set(out).size).toBe(out.length)
    expect(out.every((id) => id.length > 0)).toBe(true)
  })
})

// ── extractHeadings: rule 2 text + same ids as the render ───────────────────
describe('#3 heading list (rules 1, 2, 6)', () => {
  it('rule 2 extractHeadings() gives level, rendered id and plain text for every markdown heading', async () => {
    const { extractHeadings } = await ids('extractHeadings')
    const src = [
      '# **Launch** [plan](http://x) 🚀',
      '',
      '## `npm run` it',
      '',
      '### Q&amp;A with <em>inline</em> HTML',
      '',
      '#### Logo ![alt text](a.png)',
      '',
      '> ##### Quoted',
      '',
      '###### Dup',
      '',
      '## Dup',
      '',
    ].join('\n')
    const got = extractHeadings(src)
    expect(got).toEqual([
      { level: 1, id: 'launch-plan-', text: 'Launch plan 🚀' },
      { level: 2, id: 'npm-run-it', text: 'npm run it' },
      { level: 3, id: 'qa-with-inline-html', text: 'Q&A with inline HTML' },
      { level: 4, id: 'logo-alt-text', text: 'Logo alt text' },
      { level: 5, id: 'quoted', text: 'Quoted' },
      { level: 6, id: 'dup', text: 'Dup' },
      { level: 2, id: 'dup-1', text: 'Dup' },
    ])
    // ids must be exactly what renderHtml puts on the headings
    expect(headingIdsIn(await render(src))).toEqual(got.map((h) => h.id))
  })
})

// ── buildToc: rules 8, 9 ────────────────────────────────────────────────────
const H = (level: number, text: string, id = text.toLowerCase().replace(/ /g, '-')): Heading => ({ level, id, text })
const shape = (toc: TocEntry[]) => toc.map((e) => [e.text, e.level, e.depth])

describe('#3 TOC builder (rules 8, 9)', () => {
  it('rule 8 the AC-03.3 shape: lone leading H1 dropped, levels 1–3 kept in order, ### deeper than ##', async () => {
    const { buildToc } = await ids('buildToc')
    const toc = buildToc([
      H(1, 'Title'),
      H(2, 'Alpha'), H(3, 'Alpha detail'), H(2, 'Beta'), H(2, 'Gamma'), H(3, 'Gamma detail'), H(2, 'Delta'),
    ])
    expect(shape(toc)).toEqual([
      ['Alpha', 2, 0], ['Alpha detail', 3, 1], ['Beta', 2, 0], ['Gamma', 2, 0], ['Gamma detail', 3, 1], ['Delta', 2, 0],
    ])
    expect(toc.map((e) => e.id)).toEqual(['alpha', 'alpha-detail', 'beta', 'gamma', 'gamma-detail', 'delta'])
  })

  it('rule 8 h4–h6 are never entries', async () => {
    const { buildToc } = await ids('buildToc')
    const toc = buildToc([H(2, 'A'), H(4, 'A4'), H(5, 'A5'), H(6, 'A6'), H(2, 'B'), H(3, 'B3')])
    expect(shape(toc)).toEqual([['A', 2, 0], ['B', 2, 0], ['B3', 3, 1]])
  })

  it('rule 8 an H1 that is not the first heading, or one of several H1s, is kept', async () => {
    const { buildToc } = await ids('buildToc')
    expect(shape(buildToc([H(2, 'Intro'), H(1, 'Title'), H(2, 'Body')]))).toEqual([
      ['Intro', 2, 1], ['Title', 1, 0], ['Body', 2, 1],
    ])
    expect(shape(buildToc([H(1, 'Part one'), H(2, 'A'), H(1, 'Part two'), H(2, 'B')]))).toEqual([
      ['Part one', 1, 0], ['A', 2, 1], ['Part two', 1, 0], ['B', 2, 1],
    ])
  })

  it('rule 8 depth is relative to the shallowest listed level (skipped levels keep their distance)', async () => {
    const { buildToc } = await ids('buildToc')
    // only ### entries -> all depth 0
    expect(shape(buildToc([H(1, 'Title'), H(3, 'x'), H(3, 'y')]))).toEqual([['x', 3, 0], ['y', 3, 0]])
    // H1 … H3 with no H2 in between (two H1s, so none is dropped)
    expect(shape(buildToc([H(1, 'A'), H(3, 'B'), H(1, 'C')]))).toEqual([['A', 1, 0], ['B', 3, 2], ['C', 1, 0]])
    // a document that starts deeper and then goes shallower
    expect(shape(buildToc([H(3, 'deep'), H(2, 'mid'), H(3, 'deep2')]))).toEqual([['deep', 3, 1], ['mid', 2, 0], ['deep2', 3, 1]])
  })

  it('rule 9 fewer than 2 entries -> no TOC ([]): one ##, only an H1, H1 + one ##, h4-only, nothing', async () => {
    const { buildToc } = await ids('buildToc')
    expect(buildToc([H(2, 'Only')])).toEqual([])
    expect(buildToc([H(1, 'Only title')])).toEqual([])
    expect(buildToc([H(1, 'Title'), H(2, 'One')])).toEqual([])
    expect(buildToc([H(1, 'Title'), H(4, 'a'), H(4, 'b'), H(2, 'One')])).toEqual([])
    expect(buildToc([])).toEqual([])
    // two entries is enough
    expect(shape(buildToc([H(2, 'One'), H(2, 'Two')]))).toEqual([['One', 2, 0], ['Two', 2, 0]])
  })

  it('rules 8 + 2 end to end: buildToc(extractHeadings(src)) for a realistic doc', async () => {
    const { buildToc, extractHeadings } = await ids('buildToc', 'extractHeadings')
    const src = [
      '---', 'title: Front matter title', '---',
      '# Weekly **update**', '',
      'Intro.', '',
      '## Über café', '',
      '### [Docs](https://x.io/a) here', '',
      '#### Too deep', '',
      '## 🚀 Launch', '',
      '```', '## not a heading', '```', '',
    ].join('\n')
    const toc = buildToc(extractHeadings(src))
    expect(toc.map((e) => [e.id, e.text, e.depth])).toEqual([
      ['über-café', 'Über café', 0],
      ['docs-here', 'Docs here', 1],
      ['-launch', '🚀 Launch', 0],
    ])
  })
})
