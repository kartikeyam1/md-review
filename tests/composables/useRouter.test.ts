import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  normalizeBase, stripBase, parseRoute, routeRest, routeKey, decodeFragment, encodeFragment,
  legacyRedirect, resolveView, classifyLink, docShareUrl, createRouter, setEditTokenHandler, encodeFilePath,
  findAnchorIn,
} from '@/composables/useRouter'

describe('normalizeBase / stripBase', () => {
  it('normalises slashes', () => {
    expect(normalizeBase('/md-review')).toBe('/md-review/')
    expect(normalizeBase('md-review/')).toBe('/md-review/')
    expect(normalizeBase('/')).toBe('/')
    expect(normalizeBase('')).toBe('/')
  })
  it('strips the base, treating the base without its slash as the base', () => {
    expect(stripBase('/md-review/', '/md-review/')).toBe('')
    expect(stripBase('/md-review', '/md-review/')).toBe('')
    expect(stripBase('/md-review/d/x', '/md-review/')).toBe('d/x')
    expect(stripBase('/other/d/x', '/md-review/')).toBeNull()
    expect(stripBase('/d/x', '/')).toBe('d/x')
  })
})

describe('parseRoute', () => {
  const hash = 'a'.repeat(32)
  it('maps the route table', () => {
    expect(parseRoute('').route).toEqual({ kind: 'landing' })
    expect(parseRoute('library').route).toEqual({ kind: 'library' })
    expect(parseRoute('d/weekly').route).toEqual({ kind: 'doc', id: 'weekly' })
    expect(parseRoute('d/12345').route).toEqual({ kind: 'doc', id: '12345' })
    expect(parseRoute(`d/abc@${hash}`).route).toEqual({ kind: 'pinned', id: 'abc', rev: hash })
    expect(parseRoute('d/abc/notes/a%20b.md').route).toEqual({ kind: 'file', id: 'abc', file: 'notes/a b.md' })
  })
  it('treats index.html as the landing route and asks for the canonical path', () => {
    expect(parseRoute('index.html')).toEqual({ route: { kind: 'landing' }, canonical: '' })
  })
  it('rewrites trailing slashes on a doc and the library', () => {
    expect(parseRoute('d/abc/')).toEqual({ route: { kind: 'doc', id: 'abc' }, canonical: 'd/abc' })
    expect(parseRoute('d/abc//')).toEqual({ route: { kind: 'doc', id: 'abc' }, canonical: 'd/abc' })
    expect(parseRoute('library/')).toEqual({ route: { kind: 'library' }, canonical: 'library' })
    expect(parseRoute('/d/abc').route.kind).toBe('not-found')
  })
  it('sends everything else to not-found', () => {
    for (const p of ['nope/x', 'd', 'd/', 'd/-bad', 'd/a.b', `d/abc@${'a'.repeat(31)}`, 'd/abc@', `d/abc@${'A'.repeat(32)}`, 'library/x', 'd/abc/%E0%A4%A', '/d/x']) {
      expect(parseRoute(p).route.kind, p).toBe('not-found')
    }
    expect(parseRoute(null).route.kind).toBe('not-found')
  })
  it('round-trips paths and keys', () => {
    expect(routeRest({ kind: 'file', id: 'x', file: 'a b/c#d.md' })).toBe('d/x/a%20b/c%23d.md')
    expect(encodeFilePath('a/b c')).toBe('a/b%20c')
    expect(routeRest({ kind: 'pinned', id: 'x', rev: hash })).toBe(`d/x@${hash}`)
    expect(routeKey({ kind: 'doc', id: 'x' })).toBe('doc:x')
    expect(routeKey({ kind: 'library' })).toBe('library')
  })
})

describe('fragments', () => {
  it('decodes percent-encoding and never throws on bad input', () => {
    expect(decodeFragment('#%C3%BCber-caf%C3%A9')).toBe('über-café')
    expect(decodeFragment('#über-café')).toBe('über-café')
    expect(decodeFragment('#50%-off')).toBe('50%-off')
    expect(decodeFragment('')).toBe('')
  })
  it('encodes ids', () => {
    expect(encodeFragment('über café')).toBe('#%C3%BCber%20caf%C3%A9')
    expect(encodeFragment('')).toBe('')
  })
})

describe('legacyRedirect', () => {
  const at = (u: string) => new URL(u, 'http://x.test')
  it('#shared=<id> → d/<id>, keeping the query', () => {
    expect(legacyRedirect(at('/#shared=abc'), '/')).toBe('/d/abc')
    expect(legacyRedirect(at('/md-review/?view=edit#shared=abc'), '/md-review/')).toBe('/md-review/d/abc?view=edit')
    expect(legacyRedirect(at('/md-review/index.html#shared=abc'), '/md-review/')).toBe('/md-review/d/abc')
  })
  it('drops filePath', () => {
    expect(legacyRedirect(at('/?filePath=%2Ftmp%2Fa.md&view=read#shared=abc'), '/')).toBe('/d/abc?view=read')
  })
  it('#dashboard → library?mode=review', () => {
    expect(legacyRedirect(at('/#dashboard'), '/')).toBe('/library?mode=review')
    expect(legacyRedirect(at('/md-review/#dashboard'), '/md-review/')).toBe('/md-review/library?mode=review')
  })
  it('only on the landing route; other fragments are left alone', () => {
    expect(legacyRedirect(at('/d/x#shared=abc'), '/')).toBeNull()
    expect(legacyRedirect(at('/d/x#dashboard'), '/')).toBeNull()
    expect(legacyRedirect(at('/#github=https%3A%2F%2Fgithub.com'), '/')).toBeNull()
    expect(legacyRedirect(at('/#intro'), '/')).toBeNull()
    expect(legacyRedirect(at('/#shared=bad%20id'), '/')).toBeNull()
  })
})

describe('resolveView (00 §1.3)', () => {
  const editor = { capability: 'editor' as const, routeKind: 'doc' as const, contentType: 'markdown' as const }
  it('read is the default and never rewrites', () => {
    expect(resolveView(null, editor)).toEqual({ view: 'read', rewrite: false })
    expect(resolveView('read', editor)).toEqual({ view: 'read', rewrite: false })
  })
  it('edit for editors on a doc', () => {
    expect(resolveView('edit', editor)).toEqual({ view: 'edit', rewrite: false })
  })
  it('edit/split for viewers, pinned or file routes → read + rewrite', () => {
    expect(resolveView('edit', { ...editor, capability: 'viewer' })).toEqual({ view: 'read', rewrite: true })
    expect(resolveView('split', { ...editor, routeKind: 'pinned' })).toEqual({ view: 'read', rewrite: true })
    expect(resolveView('edit', { ...editor, routeKind: 'file' })).toEqual({ view: 'read', rewrite: true })
  })
  it('unknown values (case-sensitive) and an empty view= → read + rewrite', () => {
    expect(resolveView('bogus', editor)).toEqual({ view: 'read', rewrite: true })
    expect(resolveView('', editor)).toEqual({ view: 'read', rewrite: true })
    expect(resolveView('AGENT', editor)).toEqual({ view: 'read', rewrite: true })
  })
  it('split for editors on a doc (#7)', () => {
    expect(resolveView('split', editor)).toEqual({ view: 'split', rewrite: false })
  })
  it('allowed but not shipped → read without rewriting', () => {
    expect(resolveView('agent', editor)).toEqual({ view: 'read', rewrite: false })
    expect(resolveView('slides', editor)).toEqual({ view: 'read', rewrite: false })
  })
  it('agent/slides need a markdown doc, not a file route', () => {
    expect(resolveView('agent', { ...editor, contentType: 'html' })).toEqual({ view: 'read', rewrite: true })
    expect(resolveView('slides', { ...editor, routeKind: 'file' })).toEqual({ view: 'read', rewrite: true })
  })
  it('embed forces read and ignores view', () => {
    expect(resolveView('bogus', { ...editor, routeKind: 'embed' })).toEqual({ view: 'read', rewrite: false })
  })
})

describe('classifyLink', () => {
  const o = 'http://app.test'
  it('fragments are in-doc anchors', () => {
    expect(classifyLink('#intro', `${o}/d/x#intro`, o, '/')).toEqual({ kind: 'anchor', id: 'intro' })
    expect(classifyLink('#', `${o}/d/x#`, o, '/')).toEqual({ kind: 'anchor', id: '' })
  })
  it('same-origin doc and library links navigate in-app', () => {
    expect(classifyLink(`${o}/md-review/d/other`, `${o}/md-review/d/other`, o, '/md-review/')).toEqual({ kind: 'app', path: '/md-review/d/other' })
    expect(classifyLink('/library', `${o}/library`, o, '/')).toEqual({ kind: 'app', path: '/library' })
    expect(classifyLink('/d/x#h', `${o}/d/x#h`, o, '/')).toEqual({ kind: 'app', path: '/d/x#h' })
  })
  it('external, mailto, landing and outside-base links keep browser behaviour', () => {
    expect(classifyLink('https://example.com/d/x', 'https://example.com/d/x', o, '/').kind).toBe('default')
    expect(classifyLink('mailto:a@b.c', 'mailto:a@b.c', o, '/').kind).toBe('default')
    expect(classifyLink('/', `${o}/`, o, '/').kind).toBe('default')
    expect(classifyLink('/other/d/x', `${o}/other/d/x`, o, '/md-review/').kind).toBe('default')
  })
})

describe('docShareUrl', () => {
  it('builds <origin><base>d/<key>', () => {
    expect(docShareUrl('weekly', '/md-review/', 'https://h.test')).toBe('https://h.test/md-review/d/weekly')
    expect(docShareUrl('abc', '/', 'http://localhost:5173')).toBe('http://localhost:5173/d/abc')
  })
})

describe('createRouter (jsdom history)', () => {
  beforeEach(() => { window.history.replaceState(null, '', '/') })

  it('bootstrap strips ?edit= and hands the token to the hook', () => {
    const seen: string[][] = []
    setEditTokenHandler((id, t) => seen.push([id, t]))
    window.history.replaceState(null, '', '/d/abc?view=read&edit=tok123#intro')
    const r = createRouter(window, '/')
    r.bootstrap()
    expect(location.pathname + location.search + location.hash).toBe('/d/abc?view=read#intro')
    expect(seen).toEqual([['abc', 'tok123']])
    expect(JSON.stringify(history.state)).not.toContain('tok123')
    r.destroy()
    setEditTokenHandler(() => {})
  })

  it('bootstrap applies legacy redirects and canonical rewrites', () => {
    window.history.replaceState(null, '', '/?view=read#shared=abc')
    let r = createRouter(window, '/')
    expect(r.bootstrap().redirected).toBe(true)
    expect(location.pathname + location.search + location.hash).toBe('/d/abc?view=read')
    expect(r.current.value.route).toEqual({ kind: 'doc', id: 'abc' })
    r.destroy()

    window.history.replaceState(null, '', '/d/abc/#x')
    r = createRouter(window, '/')
    expect(r.bootstrap().redirected).toBe(false)
    expect(location.pathname + location.hash).toBe('/d/abc#x')
    r.destroy()
  })

  it('push / setFragment / setQueryParam update current and history', () => {
    const r = createRouter(window, '/')
    const len = history.length
    r.push('/d/abc')
    expect(r.current.value.key).toBe('doc:abc')
    expect(history.length).toBe(len + 1)
    r.setFragment('über', 'push')
    expect(location.hash).toBe('#%C3%BCber')
    expect(r.current.value.fragment).toBe('über')
    r.setFragment('part-1', 'replace', 'frame')
    expect(r.current.value.source).toBe('frame')
    expect(history.length).toBe(len + 2)
    r.setQueryParam('view', 'read')
    expect(location.search).toBe('?view=read')
    r.push('/d/abc?view=read#part-1') // same URL: no new entry
    expect(history.length).toBe(len + 2)
    r.destroy()
  })

  it('handleLinkClick: known anchors push, unknown ids do nothing, modified clicks are ignored', () => {
    const r = createRouter(window, '/')
    r.replace('/d/abc')
    const container = document.createElement('div')
    container.innerHTML = '<h2 id="intro">Intro</h2><a id="go" href="#intro">go</a><a id="bad" href="#missing">x</a>'
    document.body.appendChild(container)
    const scroll = vi.fn()
    const click = (sel: string, init: MouseEventInit = {}) => {
      const e = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init })
      Object.defineProperty(e, 'target', { value: container.querySelector(sel) })
      return { handled: r.handleLinkClick(e, container, scroll), e }
    }
    expect(click('#go', { ctrlKey: true }).handled).toBe(false)
    const ok = click('#go')
    expect(ok.handled).toBe(true)
    expect(ok.e.defaultPrevented).toBe(true)
    expect(location.hash).toBe('#intro')
    // The fragment changed: the `current` watcher scrolls (once), not the click handler.
    expect(scroll).not.toHaveBeenCalled()
    click('#go') // same fragment again: no new entry, re-scroll directly
    expect(scroll).toHaveBeenCalledWith(container.querySelector('#intro'))
    const before = location.href
    expect(click('#bad').handled).toBe(true)
    expect(location.href).toBe(before)
    container.remove()
    r.destroy()
  })
})

describe('findAnchorIn', () => {
  it('looks inside the doc container only (a heading `app` is not the app root)', () => {
    const root = document.createElement('div')
    root.id = 'app'
    const container = document.createElement('div')
    container.innerHTML = '<h2 id="app">App</h2><h2 id="a.b c">Odd id</h2>'
    root.appendChild(container)
    document.body.appendChild(root)
    expect(findAnchorIn(container, 'app')).toBe(container.querySelector('h2'))
    expect(findAnchorIn(container, 'a.b c')?.textContent).toBe('Odd id')
    expect(findAnchorIn(container, 'missing')).toBeNull()
    expect(findAnchorIn(container, '')).toBeNull()
    root.remove()
  })
})

describe('createRouter — refused history calls', () => {
  it('a throwing pushState/replaceState leaves current unchanged', () => {
    window.history.replaceState(null, '', '/d/abc')
    const r = createRouter(window, '/')
    const before = r.current.value
    const push = vi.spyOn(window.history, 'pushState').mockImplementation(() => { throw new DOMException('too many', 'SecurityError') })
    const rep = vi.spyOn(window.history, 'replaceState').mockImplementation(() => { throw new DOMException('too many', 'SecurityError') })
    expect(() => r.push('/d/other')).not.toThrow()
    expect(() => r.setFragment('x', 'replace', 'frame')).not.toThrow()
    expect(r.current.value).toBe(before)
    push.mockRestore()
    rep.mockRestore()
    r.destroy()
  })
})

describe('createRouter — legacy fragments pasted while running', () => {
  it('redirects #shared=/#dashboard on the landing route, leaves doc-route fragments alone', () => {
    window.history.replaceState(null, '', '/')
    const r = createRouter(window, '/')
    window.history.replaceState(null, '', '/#shared=abc')
    window.dispatchEvent(new PopStateEvent('popstate'))
    expect(location.pathname + location.hash).toBe('/d/abc')
    expect(r.current.value.route).toEqual({ kind: 'doc', id: 'abc' })

    window.history.replaceState(null, '', '/d/abc#dashboard')
    window.dispatchEvent(new HashChangeEvent('hashchange'))
    expect(location.pathname + location.hash).toBe('/d/abc#dashboard')
    expect(r.current.value.fragment).toBe('dashboard')

    window.history.replaceState(null, '', '/#dashboard')
    window.dispatchEvent(new PopStateEvent('popstate'))
    expect(location.pathname + location.search + location.hash).toBe('/library?mode=review')
    r.destroy()
  })
})
