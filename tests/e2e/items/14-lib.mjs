// Helpers shared by the reader-rendering lane's acceptance tests (#14, #16, #17,
// #15). Not a test file: scripts/verify.sh only runs *.test.mjs.
//
//   openCtx(browser, { viewport, theme, touch, clipboard, init, storage }) -> { context, page }
//     A fresh context (reduced motion). `theme` seeds localStorage['md-review-theme']
//     once per context; `clipboard: 'record'` replaces navigator.clipboard.writeText
//     with a recorder (window.__clip), `'deny'` makes it reject and
//     document.execCommand('copy') return false (both copy paths fail).
//   openDoc(page, doc, marker, rest)  /d/<slug||id><rest>, waits for marker text
//   clipLog(page)                     every text written through the recorder
//   colorsOf(page, selector)          { fg, bg } as [r,g,b] — bg composited over the
//                                     ancestors' backgrounds (any CSS colour syntax)
//   contrast(a, b)                    WCAG ratio
//   THEMES, VIEWPORTS, tid(), sleep(), eventually()
import { BASE } from '../helpers.mjs'
import { waitForDoc } from '../lib/docs.mjs'
import { contrast } from './05-lib.mjs'

export { contrast }
export const THEMES = ['light', 'dark', 'github-light', 'github-dark', 'locus-light', 'locus-dark']
export const VIEWPORTS = {
  phone: { width: 390, height: 844 },
  tablet: { width: 820, height: 1180 },
  desktop: { width: 1400, height: 900 },
}
export const tid = (id) => `[data-testid="${id}"]`
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export async function eventually(fn, { timeout = 5000, interval = 100 } = {}) {
  const end = Date.now() + timeout
  for (;;) {
    try { return await fn() } catch (e) { if (Date.now() > end) throw e }
    await sleep(interval)
  }
}

export const docUrl = (doc, rest = '') => `${BASE}/d/${doc.slug || doc.id}${rest}`

export async function openCtx(browser, { viewport = VIEWPORTS.desktop, theme, touch = false, clipboard, init, storage, ...rest } = {}) {
  const context = await browser.newContext({
    viewport, reducedMotion: 'reduce',
    ...(touch ? { hasTouch: true, isMobile: true } : {}),
    ...rest,
  })
  if (theme) {
    await context.addInitScript(([v]) => {
      if (window.top !== window) return
      try {
        if (!sessionStorage.getItem('__lane3a_theme')) { localStorage.setItem('md-review-theme', v); sessionStorage.setItem('__lane3a_theme', '1') }
      } catch { /* storage unavailable */ }
    }, [theme])
  }
  if (storage === 'throw') {
    await context.addInitScript(() => {
      const thrower = { get() { throw new DOMException('denied', 'SecurityError') } }
      try { Object.defineProperty(window, 'localStorage', thrower) } catch { /* ignore */ }
    })
  }
  if (clipboard === 'record') {
    await context.addInitScript(() => {
      window.__clip = []
      const rec = (t) => { window.__clip.push(String(t)); return Promise.resolve() }
      try {
        if (navigator.clipboard) navigator.clipboard.writeText = rec
        else Object.defineProperty(navigator, 'clipboard', { value: { writeText: rec } })
      } catch { Object.defineProperty(navigator, 'clipboard', { value: { writeText: rec } }) }
    })
  } else if (clipboard === 'deny') {
    await context.addInitScript(() => {
      window.__clip = []
      const deny = () => Promise.reject(new DOMException('denied', 'NotAllowedError'))
      try { navigator.clipboard.writeText = deny } catch { Object.defineProperty(navigator, 'clipboard', { value: { writeText: deny } }) }
      document.execCommand = () => false
    })
  }
  if (init) await context.addInitScript(init)
  const page = await context.newPage()
  page.setDefaultTimeout(8000)
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.__errors = errors
  return { context, page }
}

export async function openDoc(page, doc, marker, rest = '') {
  await page.goto(docUrl(doc, rest))
  await waitForDoc(page, marker)
}

export const clipLog = (page) => page.evaluate(() => window.__clip ?? [])

/** Foreground and composited background colour of the first element matching `selector`. */
export async function colorsOf(page, selector) {
  return page.evaluate((sel) => {
    const el = typeof sel === 'string' ? document.querySelector(sel) : null
    if (!el) return null
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 1
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    const rgba = (css) => {
      ctx.clearRect(0, 0, 1, 1)
      ctx.fillStyle = '#000'
      ctx.fillStyle = css
      ctx.fillRect(0, 0, 1, 1)
      const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data
      return [r, g, b, a / 255]
    }
    // Background layers from the element up to the root, then composite bottom-up.
    const layers = []
    for (let n = el; n; n = n.parentElement) {
      const c = rgba(getComputedStyle(n).backgroundColor)
      if (c[3] > 0) layers.push(c)
      if (c[3] >= 1) break
    }
    let bg = [255, 255, 255]
    for (const [r, g, b, a] of layers.reverse()) bg = [r * a + bg[0] * (1 - a), g * a + bg[1] * (1 - a), b * a + bg[2] * (1 - a)]
    const f = rgba(getComputedStyle(el).color)
    const fg = [f[0] * f[3] + bg[0] * (1 - f[3]), f[1] * f[3] + bg[1] * (1 - f[3]), f[2] * f[3] + bg[2] * (1 - f[3])]
    return { fg, bg }
  }, selector)
}
