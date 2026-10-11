import { describe, it, expect, vi, afterEach } from 'vitest'
import { urlFromImportError, cacheBust, looksLikeStaleDeploy, pickEditorComponent, entryScriptSrc } from '@/composables/useEditorLoader'

describe('urlFromImportError (#6 rule 4)', () => {
  it('reads the module URL from Chrome / Vite dynamic-import errors', () => {
    expect(urlFromImportError(new TypeError('Failed to fetch dynamically imported module: http://localhost:5173/src/components/EditorPane.vue')))
      .toBe('http://localhost:5173/src/components/EditorPane.vue')
    expect(urlFromImportError(new TypeError('Failed to fetch dynamically imported module: https://x.io/md-review/assets/EditorPane-AbC123.js?retry=1')))
      .toBe('https://x.io/md-review/assets/EditorPane-AbC123.js?retry=1')
  })

  it('reads a root-relative asset path (Vite CSS preload errors)', () => {
    expect(urlFromImportError(new Error('Unable to preload CSS for /md-review/assets/EditorPane-AbC123.css')))
      .toBe('/md-review/assets/EditorPane-AbC123.css')
  })

  it('null when the message names no module', () => {
    expect(urlFromImportError(new TypeError('error loading dynamically imported module'))).toBeNull()
    expect(urlFromImportError(undefined)).toBeNull()
  })
})

describe('cacheBust (#6 rule 4 retry)', () => {
  it('adds a retry param, replacing an earlier one and keeping the rest', () => {
    expect(cacheBust('/assets/EditorPane-x.js', 1)).toBe('/assets/EditorPane-x.js?retry=1')
    expect(cacheBust('/assets/EditorPane-x.js?retry=1', 2)).toBe('/assets/EditorPane-x.js?retry=2')
    expect(cacheBust('/src/components/EditorPane.vue?t=99&retry=3', 4)).toBe('/src/components/EditorPane.vue?t=99&retry=4')
  })
})

describe('looksLikeStaleDeploy (#6 rule 4)', () => {
  afterEach(() => { vi.unstubAllGlobals() })
  const err = new TypeError('Failed to fetch dynamically imported module: https://x.io/assets/EditorPane-A.js')

  it('a 404 on the chunk is a stale deployment', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 404 })
    vi.stubGlobal('fetch', fetchMock)
    expect(await looksLikeStaleDeploy(err)).toBe(true)
    expect(fetchMock).toHaveBeenCalledWith('https://x.io/assets/EditorPane-A.js', expect.objectContaining({ method: 'HEAD' }))
  })

  it('a reachable chunk or a network error (offline) is not', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 200 }))
    expect(await looksLikeStaleDeploy(err)).toBe(false)
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    expect(await looksLikeStaleDeploy(err)).toBe(false)
  })

  it('no URL in the error and no entry script on the page: not stale, no request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect(await looksLikeStaleDeploy(new Error('boom'))).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('pickEditorComponent (#6 retry on a production build)', () => {
  it('default export when there is one', () => {
    const comp = { __name: 'EditorPane' }
    expect(pickEditorComponent({ default: comp })).toBe(comp)
  })

  it('a chunk imported by URL: the export whose __name is EditorPane', () => {
    const comp = { __name: 'EditorPane', setup() {} }
    expect(pickEditorComponent({ a: 1, w: comp, x: { __name: 'Other' } })).toBe(comp)
  })

  it('a chunk that re-exports the module namespace under a minified name', () => {
    const comp = { __name: 'EditorPane' }
    expect(pickEditorComponent({ C: 1, w: Object.freeze({ default: comp }) })).toBe(comp)
  })

  it('null when no export is the editor', () => {
    expect(pickEditorComponent({ a: 1 })).toBeNull()
    expect(pickEditorComponent(undefined)).toBeNull()
  })
})

describe('entryScriptSrc (#6 stale check without a URL, e.g. Safari)', () => {
  it('reads the module entry src from index.html', () => {
    expect(entryScriptSrc('<head><script type="module" crossorigin src="/md-review/assets/index-AB12.js"></script></head>')).toBe('/md-review/assets/index-AB12.js')
    expect(entryScriptSrc('<script src="/x.js"></script>')).toBeNull()
  })
})

describe('looksLikeStaleDeploy without a URL in the error', () => {
  afterEach(() => { vi.unstubAllGlobals(); document.head.innerHTML = '' })

  it('stale when a fresh index.html names a different entry script', async () => {
    document.head.innerHTML = '<script type="module" src="/assets/index-OLD.js"></script>'
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: async () => '<script type="module" src="/assets/index-NEW.js"></script>' }))
    expect(await looksLikeStaleDeploy(new TypeError('Importing a module script failed.'))).toBe(true)
  })

  it('not stale when the entry script is unchanged, or offline', async () => {
    document.head.innerHTML = '<script type="module" src="/assets/index-SAME.js"></script>'
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: async () => '<script type="module" src="/assets/index-SAME.js"></script>' }))
    expect(await looksLikeStaleDeploy(new TypeError('Importing a module script failed.'))).toBe(false)
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Load failed')))
    expect(await looksLikeStaleDeploy(new TypeError('Importing a module script failed.'))).toBe(false)
  })
})
