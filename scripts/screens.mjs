#!/usr/bin/env node
// Screenshot matrix: every URL × theme × viewport.
//
//   node scripts/screens.mjs                               # default URL set
//   node scripts/screens.mjs --url home=/ --url doc='/?filePath=/abs/file.md'
//   node scripts/screens.mjs --urls targets.json --themes light,dark --viewports phone
//   node scripts/screens.mjs --full-page --out .verify/screens-before
//
// Output: <out>/<name>/<theme>-<viewport>.png and <out>/index.json
// (default out: .verify/screens).
//
// URLs are paths relative to the app (or absolute URLs). Placeholders:
//   {BASE}       the app origin
//   {FIXTURE}    absolute path of tests/e2e/fixture.md (URL-encoded)
//   {SHARED_ID}  id of a shared session seeded from fixture.md on the backend
// --urls takes a JSON array of {"name": "...", "url": "..."}.
// Default set: local (fixture via ?filePath=), shared (#shared={SHARED_ID}),
// dashboard (#dashboard).
//
// Themes are the app's ThemeMode values (light, dark, github-light, github-dark,
// locus-light, locus-dark), applied through localStorage['md-review-theme'] before load.
// Viewports: desktop 1400x900, tablet 820x1180, phone 390x844.
//
// Stack: if E2E_BASE_URL is unset, the script re-runs itself under
// scripts/lib/stack.sh (throwaway backend + vite dev on free ports, torn down
// afterwards) — the same startup scripts/verify.sh uses. With E2E_BASE_URL /
// E2E_API_URL set it uses that stack. Either way it takes the shared browser
// lock (/tmp/md-review-viewshare-browser.lock) unless MDR_BROWSER_LOCK_HELD=1.
//
// Library use (e.g. from a test that already has a browser):
//   import { captureMatrix } from '../../scripts/screens.mjs'
//   const index = await captureMatrix({ browser, base, api, targets, themes, viewports, outDir })

import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
export const FIXTURE = join(ROOT, 'tests/e2e/fixture.md')
export const THEME_KEY = 'md-review-theme'
export const THEMES = ['light', 'dark', 'github-light', 'github-dark', 'locus-light', 'locus-dark']
export const VIEWPORTS = {
  desktop: { width: 1400, height: 900 },
  tablet: { width: 820, height: 1180 },
  phone: { width: 390, height: 844 },
}
export const DEFAULT_TARGETS = [
  { name: 'local', url: '/?filePath={FIXTURE}' },
  { name: 'shared', url: '/#shared={SHARED_ID}' },
  { name: 'dashboard', url: '/#dashboard' },
]
const LOCK = process.env.VERIFY_BROWSER_LOCK || '/tmp/md-review-viewshare-browser.lock'

async function seedShared(api) {
  const res = await fetch(`${api}/paste`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ markdown: readFileSync(FIXTURE, 'utf-8'), filename: 'fixture.md' }),
  })
  if (!res.ok) throw new Error(`seeding shared session failed: HTTP ${res.status}`)
  return (await res.json()).id
}

function expand(url, vars) {
  let u = url
  for (const [k, v] of Object.entries(vars)) u = u.split(`{${k}}`).join(v)
  return /^https?:\/\//.test(u) ? u : vars.BASE + (u.startsWith('/') ? u : `/${u}`)
}

/**
 * Capture the matrix with an already-launched Playwright browser.
 * Returns the index object (also written to <outDir>/index.json).
 */
export async function captureMatrix({
  browser, base, api, targets = DEFAULT_TARGETS, themes = THEMES,
  viewports = Object.keys(VIEWPORTS), outDir = join(ROOT, '.verify/screens'), fullPage = false,
}) {
  const vars = { BASE: base.replace(/\/+$/, ''), FIXTURE: encodeURIComponent(FIXTURE) }
  if (targets.some((t) => t.url.includes('{SHARED_ID}'))) {
    if (!api) throw new Error('{SHARED_ID} needs an API URL (E2E_API_URL)')
    vars.SHARED_ID = await seedShared(api.replace(/\/+$/, ''))
  }
  const shots = []
  for (const theme of themes) {
    for (const vp of viewports) {
      const size = VIEWPORTS[vp]
      if (!size) throw new Error(`unknown viewport ${vp} (have ${Object.keys(VIEWPORTS).join(', ')})`)
      const context = await browser.newContext({
        viewport: size,
        colorScheme: theme.includes('dark') ? 'dark' : 'light',
      })
      await context.addInitScript(([k, v]) => { try { localStorage.setItem(k, v) } catch {} }, [THEME_KEY, theme])
      const page = await context.newPage()
      for (const t of targets) {
        const url = expand(t.url, vars)
        const file = join(outDir, t.name, `${theme}-${vp}.png`)
        mkdirSync(dirname(file), { recursive: true })
        let error
        try {
          await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 })
          await page.evaluate(() => document.fonts?.ready)
          await page.waitForTimeout(300)
          await page.screenshot({ path: file, fullPage })
        } catch (e) {
          error = String(e?.message ?? e).split('\n')[0]
        }
        shots.push({ name: t.name, url, theme, viewport: vp, ...size, file: error ? null : file.slice(outDir.length + 1), ...(error && { error }) })
      }
      await context.close()
    }
  }
  const index = { generatedAt: new Date().toISOString(), base: vars.BASE, themes, viewports, fullPage, shots }
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, 'index.json'), JSON.stringify(index, null, 2) + '\n')
  return index
}

function parseArgs(argv) {
  const o = { targets: [], themes: THEMES, viewports: Object.keys(VIEWPORTS), outDir: join(ROOT, '.verify/screens'), fullPage: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const val = () => { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); return argv[++i] }
    if (a === '--url') { const v = val(); const eq = v.indexOf('='); if (eq < 1) throw new Error('--url wants name=url'); o.targets.push({ name: v.slice(0, eq), url: v.slice(eq + 1) }) }
    else if (a === '--urls') o.targets.push(...JSON.parse(readFileSync(val(), 'utf-8')))
    else if (a === '--themes') o.themes = val().split(',')
    else if (a === '--viewports') o.viewports = val().split(',')
    else if (a === '--out') o.outDir = resolve(val())
    else if (a === '--full-page') o.fullPage = true
    else if (a === '-h' || a === '--help') o.help = true
    else throw new Error(`unknown argument ${a}`)
  }
  if (!o.targets.length) o.targets = DEFAULT_TARGETS
  for (const t of o.themes) if (!THEMES.includes(t)) throw new Error(`unknown theme ${t} (have ${THEMES.join(', ')})`)
  return o
}

async function main() {
  const args = process.argv.slice(2)
  const self = fileURLToPath(import.meta.url)
  const reexec = (cmd, cmdArgs, env) => {
    const r = spawnSync(cmd, cmdArgs, { stdio: 'inherit', env: { ...process.env, ...env } })
    process.exit(r.status ?? 1)
  }
  let opts
  try { opts = parseArgs(args) } catch (e) { console.error(String(e.message)); process.exit(2) }
  if (opts.help) {
    console.log(readFileSync(self, 'utf-8').split('\n').slice(1, 35).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'))
    return
  }
  if (process.env.MDR_BROWSER_LOCK_HELD !== '1') {
    return reexec('flock', [LOCK, process.execPath, self, ...args], { MDR_BROWSER_LOCK_HELD: '1' })
  }
  if (!process.env.E2E_BASE_URL) {
    return reexec('bash', [join(ROOT, 'scripts/lib/stack.sh'), 'run', '--', process.execPath, self, ...args],
      { STACK_LOG_DIR: process.env.STACK_LOG_DIR || join(ROOT, '.verify/logs/screens') })
  }
  const { chromium } = await import('playwright')
  const browser = await chromium.launch({ headless: true })
  try {
    const index = await captureMatrix({ browser, base: process.env.E2E_BASE_URL, api: process.env.E2E_API_URL, ...opts })
    const failed = index.shots.filter((s) => s.error)
    console.log(`screens: ${index.shots.length - failed.length}/${index.shots.length} captured -> ${join(opts.outDir, 'index.json')}`)
    for (const f of failed) console.error(`  FAILED ${f.name} ${f.theme}-${f.viewport}: ${f.error}`)
    process.exitCode = failed.length ? 1 : 0
  } finally {
    await browser.close()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((e) => { console.error(e); process.exit(1) })
}
