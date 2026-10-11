// @vitest-environment node
// #4 Path-based routes — AC-04.17: the GitHub Pages build emits a 404.html SPA
// fallback identical to index.html, with every asset URL absolute under the base.
//
// Runs the same vite build as `GITHUB_PAGES=true npm run build` (minus the
// vue-tsc step, which emits nothing) into a temp dir, so the repo's dist/ is
// left alone.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(__dirname, '../..')
let out = ''

beforeAll(async () => {
  out = mkdtempSync(join(tmpdir(), 'md-review-ac0417-'))
  await new Promise<void>((ok, fail) => {
    execFile(
      process.execPath,
      [join(ROOT, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', out, '--emptyOutDir', '--logLevel', 'warn'],
      { cwd: ROOT, env: { ...process.env, GITHUB_PAGES: 'true', NO_COLOR: '1' }, timeout: 240_000, maxBuffer: 16 * 1024 * 1024 },
      (err, _stdout, stderr) => (err ? fail(new Error(`vite build failed: ${err.message}\n${stderr}`)) : ok()),
    )
  })
}, 300_000)

afterAll(() => { if (out) rmSync(out, { recursive: true, force: true }) })

/** src/href of every <script> and <link> in an HTML string. */
function assetRefs(html: string): string[] {
  const refs: string[] = []
  for (const m of html.matchAll(/<(script|link)\b[^>]*>/gi)) {
    const attr = m[1].toLowerCase() === 'script' ? 'src' : 'href'
    const v = m[0].match(new RegExp(`\\s${attr}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'))
    if (v) refs.push(v[1] ?? v[2] ?? v[3])
  }
  return refs
}

/** Third-party (absolute http(s), protocol-relative) and data: URLs are not app assets. */
const isAppAsset = (u: string) => !/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(u)

describe('AC-04.17 GitHub Pages build', () => {
  it('AC-04.17 emits dist/404.html', () => {
    expect(existsSync(join(out, '404.html'))).toBe(true)
  })

  it('AC-04.17 404.html is byte-identical to index.html', () => {
    const index = readFileSync(join(out, 'index.html'))
    const notFound = readFileSync(join(out, '404.html'))
    expect(notFound.equals(index)).toBe(true)
  })

  it('AC-04.17 every app script/link URL in 404.html starts with /md-review/', () => {
    const html = readFileSync(join(out, '404.html'), 'utf-8')
    const refs = assetRefs(html).filter(isAppAsset)
    expect(refs.some((r) => /^\/md-review\/assets\/.+\.js$/.test(r))).toBe(true)
    expect(refs.filter((r) => !r.startsWith('/md-review/'))).toEqual([])
  })
})
