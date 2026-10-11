// #26 multi-file sessions — unit tests for the pure logic (docs/build/specs/26-library.md
// rules 19–27). Browser behaviour: tests/e2e/items/26-files.test.mjs.
import { describe, it, expect } from 'vitest'
import {
  isDocumentFile, splitSessionFiles, fileKind, codeLanguage, codeFence, fileRoutePath,
  breadcrumbSegments, phoneBreadcrumb, attachmentOpensInApp, formatFileSize, uploadsAsText,
  primaryTabLabel,
} from '@/composables/sessionFiles'
import { docKeyOfScreen } from '@/composables/useSessionFiles'
import { parseRoute } from '@/composables/useRouter'
import { resolveDocAxes } from '@/composables/useDocState'

const f = (name: string, size = 10, type = '') => ({ name, size, type })

describe('rule 19 — document files vs attachments', () => {
  it('md/markdown/html/htm/txt are document files, case-insensitively', () => {
    for (const n of ['a.md', 'B.MD', 'x.markdown', 'r.html', 'R.HTM', 'notes.txt', 'data/report.html', 'edit.md', '@x.md']) {
      expect(isDocumentFile(n), n).toBe(true)
    }
    for (const n of ['chart.png', 'data.csv', 'a.json', 'md', 'readme', 'x.md.bak', 'assets/img.webp', 'page.xhtml']) {
      expect(isDocumentFile(n), n).toBe(false)
    }
  })

  it('splits and sorts by name (case-insensitive, then code point)', () => {
    const { documents, attachments } = splitSessionFiles([
      f('zeta.md'), f('chart.png'), f('Appendix.md'), f('data/report.html'), f('appendix.md'), f('b.csv'), f('a b.txt'),
    ])
    expect(documents.map((d) => d.name)).toEqual(['a b.txt', 'Appendix.md', 'appendix.md', 'data/report.html', 'zeta.md'])
    expect(attachments.map((d) => d.name)).toEqual(['b.csv', 'chart.png'])
  })

  it('tolerates a missing / malformed list', () => {
    expect(splitSessionFiles(undefined)).toEqual({ documents: [], attachments: [] })
    expect(splitSessionFiles([{ name: '' } as never, null as never, f('a.md')]).documents.map((d) => d.name)).toEqual(['a.md'])
  })
})

describe('rule 20 — primary tab label', () => {
  it('is the filename, else "Document"', () => {
    expect(primaryTabLabel('report.md')).toBe('report.md')
    expect(primaryTabLabel('')).toBe('Document')
    expect(primaryTabLabel(null)).toBe('Document')
    expect(primaryTabLabel('  ')).toBe('Document')
  })
})

describe('rule 22 — rendering by type', () => {
  it('classifies by extension, falling back to the content type', () => {
    expect(fileKind('a.md')).toBe('markdown')
    expect(fileKind('a.MARKDOWN')).toBe('markdown')
    expect(fileKind('r.html')).toBe('html')
    expect(fileKind('r.htm')).toBe('html')
    expect(fileKind('notes.txt')).toBe('code')
    expect(fileKind('src/main.ts')).toBe('code')
    expect(fileKind('cfg.yaml')).toBe('code')
    expect(fileKind('a.json')).toBe('code')
    expect(fileKind('chart.png')).toBe('image')
    expect(fileKind('pic.JPEG')).toBe('image')
    expect(fileKind('x.svg')).toBe('image')
    expect(fileKind('blob.bin')).toBe('download')
    expect(fileKind('data.csv')).toBe('download')
    expect(fileKind('noext', 'image/png')).toBe('image')
    expect(fileKind('noext', 'application/octet-stream')).toBe('download')
  })

  it('names a highlight language for code files', () => {
    expect(codeLanguage('a.ts')).toBe('typescript')
    expect(codeLanguage('a.py')).toBe('python')
    expect(codeLanguage('a.json')).toBe('json')
    expect(codeLanguage('notes.txt')).toBe('text')
    expect(codeLanguage('Dockerfile')).toBe('text')
  })

  it('fences text with a fence longer than any backtick run inside it', () => {
    expect(codeFence('a', 'ts')).toBe('```ts\na\n```')
    const tricky = 'x\n```\ny ````` z'
    const out = codeFence(tricky, 'text')
    expect(out.startsWith('``````text\n')).toBe(true)
    expect(out.endsWith('\n``````')).toBe(true)
    expect(codeFence('ends with newline\n', 'text')).toBe('```text\nends with newline\n```')
  })

  it('attachments: images and text open in the app, others download', () => {
    expect(attachmentOpensInApp('chart.png')).toBe(true)
    expect(attachmentOpensInApp('a.json')).toBe(true)
    expect(attachmentOpensInApp('data.csv')).toBe(false)
    expect(attachmentOpensInApp('blob.bin')).toBe(false)
  })

  it('formats sizes', () => {
    expect(formatFileSize(0)).toBe('0 B')
    expect(formatFileSize(999)).toBe('999 B')
    expect(formatFileSize(1536)).toBe('1.5 KB')
    expect(formatFileSize(5 * 1024 * 1024)).toBe('5.0 MB')
    expect(formatFileSize(NaN)).toBe('')
  })
})

describe('rule 21 — file paths in URLs', () => {
  const names = ['src/a b.md', 'q?x.md', 'h#1.md', '100%.md', 'naïve/日本.md', '@x.md', 'edit.md', 'deep/er/still.md']
  it('encodes each segment and round-trips through the router', () => {
    for (const n of names) {
      const path = fileRoutePath('/', 'doc-1', n)
      expect(path.startsWith('/d/doc-1/'), n).toBe(true)
      expect(path).not.toMatch(/[?#\s]/)
      const rest = path.slice(1)
      expect(parseRoute(rest).route, n).toEqual({ kind: 'file', id: 'doc-1', file: n })
    }
    expect(fileRoutePath('/md-review/', 'x', 'src/a b.md')).toBe('/md-review/d/x/src/a%20b.md')
  })
})

describe('rule 24 — breadcrumb', () => {
  it('Library › Collection › Doc › file on a file route', () => {
    const s = breadcrumbSegments({ base: '/', docKey: 'x', docTitle: 'Report', collection: { id: 'c1', name: 'Ops' }, file: 'data/report.html' })
    expect(s.map((x) => [x.kind, x.label])).toEqual([
      ['library', 'Library'], ['collection', 'Ops'], ['doc', 'Report'], ['file', 'data/report.html'],
    ])
    expect(s[0].href).toBe('/library')
    expect(s[1].href).toBe('/library?collection=c1')
    expect(s[2].href).toBe('/d/x')
    expect(s[3].href).toBeNull()
    expect(s.filter((x) => x.current).map((x) => x.kind)).toEqual(['file'])
  })

  it('omits the collection when unfiled and the file on the primary doc', () => {
    const s = breadcrumbSegments({ base: '/md-review/', docKey: 'x', docTitle: 'Report', collection: null, file: null })
    expect(s.map((x) => x.kind)).toEqual(['library', 'doc'])
    expect(s[0].href).toBe('/md-review/library')
    expect(s[1].current).toBe(true)
    expect(s[1].href).toBeNull()
  })

  it('collection ids are query-encoded', () => {
    const s = breadcrumbSegments({ base: '/', docKey: 'x', docTitle: 'T', collection: { id: 'a b&c', name: 'N' }, file: null })
    expect(s[1].href).toBe('/library?collection=a+b%26c')
  })

  it('on a phone the middle segments collapse to one …', () => {
    const s = breadcrumbSegments({ base: '/', docKey: 'x', docTitle: 'Report', collection: { id: 'c', name: 'Ops' }, file: 'f.md' })
    const p = phoneBreadcrumb(s)
    expect(p.map((x) => x.kind)).toEqual(['library', 'collection', 'doc', 'file'])
    expect(p[1].label).toBe('…')
    expect(p[1].title).toBe('Ops')
    expect(p[1].href).toBe('/library?collection=c')
    expect(p[2].label).toBe('Report')
    const short = breadcrumbSegments({ base: '/', docKey: 'x', docTitle: 'Report', collection: null, file: 'f.md' })
    expect(phoneBreadcrumb(short).map((x) => x.label)).toEqual(['Library', 'Report', 'f.md'])
  })
})

describe('rule 25 — uploads', () => {
  it('text files go as utf-8, others as base64', () => {
    expect(uploadsAsText({ name: 'notes.md', type: '' })).toBe(true)
    expect(uploadsAsText({ name: 'a.json', type: 'application/json' })).toBe(true)
    expect(uploadsAsText({ name: 'x', type: 'text/plain' })).toBe(true)
    expect(uploadsAsText({ name: 'chart.png', type: 'image/png' })).toBe(false)
    expect(uploadsAsText({ name: 'x.svg', type: 'image/svg+xml' })).toBe(false)
    expect(uploadsAsText({ name: 'a.zip', type: 'application/zip' })).toBe(false)
  })
})

describe('00 §1.2 — capability on file routes is the doc\'s; review UI is off there', () => {
  const base = { routeKind: 'file' as const, embed: false, paneMode: 'preview' as const, pasteId: 'x', mode: 'review' as const }
  it('editor of the doc stays editor on its file routes, viewer stays viewer', () => {
    expect(resolveDocAxes({ ...base, canEdit: true })).toMatchObject({ routeKind: 'file', capability: 'editor', reviewUI: false, view: 'read' })
    expect(resolveDocAxes({ ...base, canEdit: false })).toMatchObject({ capability: 'viewer' })
    expect(resolveDocAxes({ ...base, paneMode: 'edit', canEdit: true }).view).toBe('read')
    expect(resolveDocAxes({ ...base, routeKind: 'pinned', canEdit: true }).capability).toBe('viewer')
  })

  it('a file screen key belongs to its doc', () => {
    expect(docKeyOfScreen('file:x/a/b.md', 'x')).toBe('doc:x')
    expect(docKeyOfScreen('doc:x', 'x')).toBe('doc:x')
    expect(docKeyOfScreen('file:y/a.md', 'x')).toBe('file:y/a.md')
    expect(docKeyOfScreen('file:xy/a.md', 'x')).toBe('file:xy/a.md')
    expect(docKeyOfScreen(null, 'x')).toBeNull()
  })
})
