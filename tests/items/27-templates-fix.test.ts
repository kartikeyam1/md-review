// #27 fix round — unit tests pinning each behaviour change from docs/build/reports/27-review.md and 27-qa.md:
// the standalone (inert) preview, Esc on the dialog (no window capture listener), aria-disabled while busy,
// no navigation after the picker closed mid-create, the save dialog closing on navigation, the clash message
// naming the existing template, the toast link that navigates in-app, the chunk-load error toast, rename /
// delete focus in the Templates tab, the landing chunk's error component and applyTitleVar's edge cases.
// Browser half: tests/e2e/items/27-templates.test.mjs.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import PreviewPane from '@/components/PreviewPane.vue'
import TemplatePicker from '@/components/TemplatePicker.vue'
import SaveTemplateDialog from '@/components/SaveTemplateDialog.vue'
import LibraryTemplates from '@/components/LibraryTemplates.vue'
import AppToast from '@/components/AppToast.vue'
import { LandingLoadError } from '@/components/lazyLanding'
import { useRouter } from '@/composables/useRouter'
import { toast, useToast, _resetToasts } from '@/composables/useToast'
import { applyTitleVar } from '@/composables/templateLogic'
import { withTemplateHost, LOAD_FAILED_MESSAGE } from '@/composables/templateEntry'

const router = useRouter()
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const SEED = {
  id: 'seed-design-doc', name: 'Design doc', description: 'Problem, options, decision', contentType: 'markdown', mode: 'publish',
  collectionId: null, collection: null, builtin: true, variables: ['author', 'date', 'title'],
}
const RENDERED = '# Cache rewrite\n\n[to goals](#goals)\n\n## Goals\n\n[outside](https://example.com/x) [in app](/library)\n'

type Route = (url: string, init?: RequestInit) => Response | Promise<Response> | undefined
let routes: Route[] = []
function onFetch(fn: Route) { routes.unshift(fn) }

let wrappers: VueWrapper[] = []
function track<T extends VueWrapper>(w: T): T { wrappers.push(w); return w }

beforeEach(() => {
  routes = []
  onFetch((url) => (url.endsWith('/templates') ? json([SEED]) : undefined))
  onFetch((url) => (url.endsWith('/library/collections') ? json([]) : undefined))
  onFetch((url) => (url.endsWith('/render') ? json({ content: RENDERED }) : undefined))
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    for (const r of routes) {
      const res = await r(String(url), init)
      if (res) return res
    }
    return json({ error: 'not mocked' }, 500)
  }))
  Element.prototype.scrollIntoView = vi.fn()
  router.replace('/')
  _resetToasts()
})
afterEach(() => {
  for (const w of wrappers) { try { w.unmount() } catch { /* already */ } }
  wrappers = []
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

// ── SHOULD-FIX 1 + QA D3: the picker preview is inert ───────────────────────

describe('PreviewPane standalone (template preview)', () => {
  it('no heading-anchor / section enhancers; links never navigate the app; #anchor scrolls inside', async () => {
    const w = track(mount(PreviewPane, { props: { content: RENDERED, comments: [], commenting: false, standalone: true }, attachTo: document.body }))
    await nextTick(); await nextTick()
    expect(w.findAll('[data-testid="heading-anchor"]').length).toBe(0)
    const before = router.current.value.href
    for (const sel of ['a[href="#goals"]', 'a[href^="https://"]', 'a[href="/library"]']) {
      const ev = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })
      w.find(sel).element.dispatchEvent(ev)
      expect(ev.defaultPrevented, sel).toBe(true)
    }
    expect(router.current.value.href).toBe(before)
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled()
  })

  it('control: without standalone the same content gets heading anchors and in-app links route', async () => {
    const w = track(mount(PreviewPane, { props: { content: RENDERED, comments: [], commenting: false }, attachTo: document.body }))
    await nextTick(); await nextTick()
    expect(w.findAll('[data-testid="heading-anchor"]').length).toBeGreaterThan(0)
    w.find('a[href="/library"]').element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }))
    expect(router.current.value.route.kind).toBe('library')
  })

  it('html preview: anchor-changed from the frame is ignored when standalone (applied otherwise)', async () => {
    vi.stubGlobal('URL', Object.assign(class extends URL {}, { createObjectURL: () => 'about:blank', revokeObjectURL: () => {} }))
    const html = '<!doctype html><html><body><h1 id="a">A</h1></body></html>'
    for (const standalone of [true, false]) {
      router.replace('/')
      const w = track(mount(PreviewPane, { props: { content: html, comments: [], contentType: 'html', standalone }, attachTo: document.body }))
      await nextTick()
      const win = (w.find('iframe').element as HTMLIFrameElement).contentWindow!
      window.dispatchEvent(new MessageEvent('message', { data: { __mdreview: true, type: 'anchor-changed', id: 'a' }, source: win }))
      await wait(20)
      expect(router.current.value.fragment, `standalone=${standalone}`).toBe(standalone ? '' : 'a')
      w.unmount()
    }
  })
})

// ── TemplatePicker: Esc, busy, closed mid-create, preview a11y ──────────────

async function openPicker(props: Record<string, unknown> = {}) {
  const w = track(mount(TemplatePicker, { props: { initialTemplateId: 'seed-design-doc', ...props }, attachTo: document.body }))
  await flushPromises()
  await w.find('[data-testid="template-title-input"]').setValue('Cache rewrite')
  return w
}

describe('TemplatePicker', () => {
  it('Esc is handled on the dialog (stops there); an Esc that never reaches the dialog is left alone', async () => {
    const w = await openPicker()
    const outside = vi.fn()
    document.addEventListener('keydown', outside)
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    expect(w.emitted('close')).toBeUndefined()
    expect(outside).toHaveBeenCalledTimes(1)
    const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    w.find('[data-testid="template-title-input"]').element.dispatchEvent(ev)
    expect(w.emitted('close')).toHaveLength(1)
    expect(ev.defaultPrevented).toBe(true)
    expect(outside).toHaveBeenCalledTimes(1) // propagation stopped at the dialog
    document.removeEventListener('keydown', outside)
  })

  it('an Esc a layer above already handled (defaultPrevented) does not close the picker', async () => {
    const w = await openPicker()
    const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    ev.preventDefault()
    w.find('[data-testid="template-title-input"]').element.dispatchEvent(ev)
    expect(w.emitted('close')).toBeUndefined()
  })

  it('the dialog is focusable; while creating, Create is aria-disabled (not disabled) and keeps focus', async () => {
    let release!: (r: Response) => void
    onFetch((url) => (url.endsWith('/instantiate') ? new Promise<Response>((r) => { release = r }) : undefined))
    const w = await openPicker()
    expect(w.find('[role="dialog"]').attributes('tabindex')).toBe('-1')
    const btn = w.find('[data-testid="template-create-btn"]')
    ;(btn.element as HTMLButtonElement).focus()
    await btn.trigger('click')
    expect(btn.attributes('aria-disabled')).toBe('true')
    expect(btn.attributes('disabled')).toBeUndefined()
    expect(w.find('[role="dialog"]').attributes('aria-busy')).toBe('true')
    expect(document.activeElement).toBe(btn.element)
    await btn.trigger('click') // inert while busy: no second request
    expect((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(([u]) => String(u).endsWith('/instantiate'))).toHaveLength(1)
    release(json({ id: 'abc123', slug: 'cache-rewrite' }, 201))
    await flushPromises()
    expect(router.current.value.href).toMatch(/\/d\/cache-rewrite\?view=edit$/)
  })

  it('closed while creating: no navigation; a success toast offers Open', async () => {
    let release!: (r: Response) => void
    onFetch((url) => (url.endsWith('/instantiate') ? new Promise<Response>((r) => { release = r }) : undefined))
    const w = await openPicker()
    await w.find('[data-testid="template-create-btn"]').trigger('click')
    w.unmount() // Esc / Cancel / Back while the request is in flight
    release(json({ id: 'abc123', slug: 'cache-rewrite', editToken: 'mre_x' }, 201))
    await flushPromises()
    expect(router.current.value.route.kind).toBe('landing')
    const t = useToast().toasts.value.at(-1)!
    expect(t.kind).toBe('success')
    expect(t.text).toContain('Cache rewrite')
    expect(t.action?.label).toBe('Open')
    t.action!.onClick!()
    expect(router.current.value.href).toMatch(/\/d\/cache-rewrite\?view=edit$/)
  })

  it('the preview renders inert (no heading anchors); chips carry a hidden "Variables:" label', async () => {
    const list = track(mount(TemplatePicker, { props: {}, attachTo: document.body }))
    await flushPromises()
    expect(list.find('.tp-item-meta .tp-sr').text()).toBe('Variables:')
    list.unmount()
    const w = await openPicker()
    await wait(400)
    await flushPromises()
    const preview = w.find('[data-testid="template-preview"]')
    expect(preview.find('h1').exists()).toBe(true)
    expect(preview.findAll('[data-testid="heading-anchor"]').length).toBe(0)
  })

  it('a preview error is a polite live region, not an alert re-announced on every keystroke', async () => {
    onFetch((url) => (url.endsWith('/render') ? json({ error: 'boom' }, 500) : undefined))
    const w = await openPicker()
    await wait(400)
    await flushPromises()
    const msg = w.find('[data-testid="template-preview"] .tp-preview-msg')
    expect(msg.text()).toBe('boom')
    expect(msg.attributes('role')).toBeUndefined()
    expect(msg.attributes('aria-live')).toBe('polite')
  })
})

// ── SaveTemplateDialog: Esc, navigation, clash name, toast link ─────────────

const saveProps = { title: 'Incident review', content: '# Incident review\n\nBody\n', contentType: 'markdown', mode: 'publish', docId: null }

describe('SaveTemplateDialog', () => {
  it('Esc on the dialog closes it; an Esc outside it does not', async () => {
    const w = track(mount(SaveTemplateDialog, { props: saveProps, attachTo: document.body }))
    await flushPromises()
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    expect(w.emitted('close')).toBeUndefined()
    w.find('[data-testid="template-save-name"]').element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    expect(w.emitted('close')).toHaveLength(1)
    expect(w.find('[data-testid="template-save-dialog"]').attributes('tabindex')).toBe('-1')
  })

  it('closes when the reader navigates to another page or presses Back; a query rewrite on the same doc keeps it', async () => {
    router.replace('/d/abc')
    const w = track(mount(SaveTemplateDialog, { props: saveProps, attachTo: document.body }))
    await flushPromises()
    router.setQueryParam('view', 'edit')
    await nextTick()
    expect(w.emitted('close')).toBeUndefined()
    router.push('/library')
    await nextTick()
    expect(w.emitted('close')).toHaveLength(1)
  })

  it('a clash quotes the existing template name; Replace stays on screen (focusable) while busy', async () => {
    let release!: (r: Response) => void
    let calls = 0
    onFetch((url, init) => {
      if (!url.endsWith('/templates') || init?.method !== 'POST') return undefined
      calls++
      if (calls === 1) return json({ error: 'A template named "Incident review" already exists', code: 'name_taken', builtin: false, id: 'tpl-1', name: 'Incident review' }, 409)
      return new Promise<Response>((r) => { release = r })
    })
    const w = track(mount(SaveTemplateDialog, { props: saveProps, attachTo: document.body }))
    await flushPromises()
    await w.find('[data-testid="template-save-name"]').setValue('  incident REVIEW ')
    await w.find('form').trigger('submit')
    await flushPromises()
    expect(w.find('[data-testid="template-save-error"]').text()).toContain('“Incident review” already exists')
    const replace = w.find('[data-testid="template-save-replace"]')
    ;(replace.element as HTMLButtonElement).focus()
    await replace.trigger('click')
    expect(w.find('[data-testid="template-save-replace"]').exists()).toBe(true)
    expect(replace.attributes('aria-disabled')).toBe('true')
    expect(replace.attributes('disabled')).toBeUndefined()
    expect(document.activeElement).toBe(replace.element)
    release(json({ ...SEED, id: 'tpl-1', name: 'Incident review', builtin: false }, 200))
    await flushPromises()
    expect(w.emitted('close')).toHaveLength(1)
  })

  it('success toast: a link to the Templates tab that navigates in-app', async () => {
    onFetch((url, init) => (url.endsWith('/templates') && init?.method === 'POST' ? json({ ...SEED, id: 'tpl-2', name: 'Incident review', builtin: false }, 201) : undefined))
    const w = track(mount(SaveTemplateDialog, { props: saveProps, attachTo: document.body }))
    await flushPromises()
    await w.find('form').trigger('submit')
    await flushPromises()
    const t = useToast().toasts.value.at(-1)!
    expect(t.action?.href).toBe('/library?tab=templates')
    t.action!.onClick!()
    expect(router.current.value.href).toMatch(/\/library\?tab=templates$/)
  })
})

// ── AppToast: href + onClick ────────────────────────────────────────────────

describe('AppToast link action with onClick', () => {
  it('a plain click runs onClick (no reload); a modified click follows the href', async () => {
    const onClick = vi.fn()
    toast.success('Saved', { action: { label: 'View', href: '/library?tab=templates', onClick } })
    const w = track(mount(AppToast, { attachTo: document.body }))
    await nextTick()
    const a = w.find('a.app-toast-action')
    expect(a.attributes('href')).toBe('/library?tab=templates')
    const mod = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ctrlKey: true })
    a.element.addEventListener('click', (e) => e.preventDefault(), { once: true }) // keep jsdom from navigating
    a.element.dispatchEvent(mod)
    expect(onClick).not.toHaveBeenCalled()
    toast.success('Saved', { action: { label: 'View', href: '/library?tab=templates', onClick } })
    await nextTick()
    const plain = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })
    w.find('a.app-toast-action').element.dispatchEvent(plain)
    expect(plain.defaultPrevented).toBe(true)
    expect(onClick).toHaveBeenCalledTimes(1)
  })
})

// ── templateEntry: a failed chunk load says so ──────────────────────────────

describe('withTemplateHost', () => {
  it('a rejected chunk load shows an error toast instead of doing nothing', async () => {
    const use = vi.fn()
    await withTemplateHost(use, () => Promise.reject(new Error('Failed to fetch dynamically imported module')))
    expect(use).not.toHaveBeenCalled()
    const t = useToast().toasts.value.at(-1)!
    expect(t.kind).toBe('error')
    expect(t.text).toBe(LOAD_FAILED_MESSAGE)
  })

  it('a loaded chunk is used', async () => {
    const use = vi.fn()
    const host = {} as typeof import('@/components/templateHost')
    await withTemplateHost(use, () => Promise.resolve(host))
    expect(use).toHaveBeenCalledWith(host)
  })
})

// ── Templates tab: rename in flight, focus after rename / Esc / delete ──────

describe('LibraryTemplates', () => {
  const USER = { ...SEED, id: 'tpl-u1', name: 'Drafty', builtin: false, variables: [] }
  const USER2 = { ...SEED, id: 'tpl-u2', name: 'Zed', builtin: false, variables: [] }

  async function openTab() {
    onFetch((url, init) => (url.endsWith('/templates') && (!init?.method || init.method === 'GET') ? json([SEED, USER, USER2]) : undefined))
    const w = track(mount(LibraryTemplates, { attachTo: document.body }))
    await flushPromises()
    return w
  }
  const row = (w: VueWrapper, id: string) => w.find(`[data-template-id="${id}"]`)
  async function startRename(w: VueWrapper, id: string) {
    await row(w, id).find('[data-testid="template-menu"]').trigger('click')
    await nextTick()
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) => el.textContent?.includes('Rename'))!
    item.click()
    await flushPromises()
    return row(w, id).find('.tpl-rename-input')
  }

  it('blur while a rename request is in flight keeps the rename open and shows its error', async () => {
    let release!: (r: Response) => void
    onFetch((url, init) => (init?.method === 'PATCH' ? new Promise<Response>((r) => { release = r }) : undefined))
    const w = await openTab()
    const input = await startRename(w, 'tpl-u1')
    await input.setValue('QA findings')
    await input.trigger('keydown', { key: 'Enter' })
    await input.trigger('blur')
    release(json({ error: '"QA findings" is a built-in template name', code: 'name_taken', builtin: true, id: 'seed-qa-findings' }, 409))
    await flushPromises()
    expect(row(w, 'tpl-u1').find('.tpl-rename-input').exists()).toBe(true)
    expect(row(w, 'tpl-u1').find('.tpl-error').text()).toContain('built-in')
  })

  it('Esc in the rename input returns focus to the row\'s Use button', async () => {
    const w = await openTab()
    const input = await startRename(w, 'tpl-u1')
    await input.trigger('keydown', { key: 'Escape' })
    await flushPromises()
    expect(document.activeElement).toBe(row(w, 'tpl-u1').find('[data-testid="template-use"]').element)
  })

  it('a successful rename returns focus to that row\'s Use button', async () => {
    onFetch((url, init) => (init?.method === 'PATCH' ? json({ ...USER, name: 'Drafty 2' }) : undefined))
    const w = await openTab()
    const input = await startRename(w, 'tpl-u1')
    await input.setValue('Drafty 2')
    await input.trigger('keydown', { key: 'Enter' })
    await flushPromises(); await flushPromises()
    expect(document.activeElement).toBe(row(w, 'tpl-u1').find('[data-testid="template-use"]').element)
  })

  it('after a delete, focus goes to the next row\'s Use button', async () => {
    const w = await openTab()
    let deleted = false
    onFetch((url, init) => {
      if (init?.method === 'DELETE') { deleted = true; return new Response(null, { status: 204 }) }
      if (url.endsWith('/templates') && deleted) return json([SEED, USER2])
      return undefined
    })
    await row(w, 'tpl-u1').find('[data-testid="template-menu"]').trigger('click')
    await nextTick()
    ;[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) => el.textContent?.includes('Delete'))!.click()
    await flushPromises()
    ;(document.querySelector('[data-testid="template-delete-confirm"] [data-testid="library-confirm-ok"]') as HTMLElement).click()
    await flushPromises(); await flushPromises()
    expect(row(w, 'tpl-u1').exists()).toBe(false)
    expect(document.activeElement).toBe(row(w, 'tpl-u2').find('[data-testid="template-use"]').element)
  })
})

// ── NIT: the lazy landing page's error component ────────────────────────────

describe('lazy landing', () => {
  it('a failed landing chunk shows a reload prompt, not a blank page', () => {
    const w = track(mount(LandingLoadError))
    expect(w.attributes('role')).toBe('alert')
    expect(w.find('button').text()).toBe('Reload')
  })
})

// ── NIT: applyTitleVar edge cases ───────────────────────────────────────────

describe('applyTitleVar edge cases', () => {
  it('a fence line with an info string does not close a fence (CommonMark)', () => {
    const md = '```js\n# not a heading\n```js\n# still code\n```\n# Real\n'
    expect(applyTitleVar(md, 'markdown').content).toBe('```js\n# not a heading\n```js\n# still code\n```\n# {{title}}\n')
  })

  it('html: <title>/<h1> inside svg, script, style or comments are skipped', () => {
    const html = '<html><head><!-- <title>Old</title> --><style>h1::after{content:"<h1>x</h1>"}</style>'
      + '<script>var s = "<title>js</title><h1>js</h1>"</script><title>Doc</title></head>'
      + '<body><svg><title>icon</title></svg><h1>Head</h1><h1>Second</h1></body></html>'
    const r = applyTitleVar(html, 'html')
    expect(r.replaced).toBe(true)
    expect(r.content).toBe(html.replace('<title>Doc</title>', '<title>{{title}}</title>').replace('<h1>Head</h1>', '<h1>{{title}}</h1>'))
  })

  it('html with only an svg <title> and no h1 is unchanged', () => {
    const html = '<p>x</p><svg><title>icon</title></svg>'
    expect(applyTitleVar(html, 'html')).toEqual({ content: html, replaced: false })
  })
})
