// @vitest-environment node
// #6 Lazy-load the editor — frozen build/source acceptance tests
// (docs/build/specs/06-lazy-editor.md AC-06.7, AC-06.8, AC-06.12; rules 1, 5, 7, 9).
//
// Runs one production `vite build` (the same as `npm run build` minus the
// vue-tsc step, which emits nothing) into a temp dir, so the repo's dist/ is
// left alone, then inspects it with scripts/check-lazy-editor.mjs (the
// `check:lazy-editor` script) and independently here.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import ts from 'typescript'

const ROOT = resolve(__dirname, '../..')
const SCRIPT = join(ROOT, 'scripts/check-lazy-editor.mjs')

/**
 * Frozen baseline (spec "Current state"): the entry chunk `assets/index-*.js`
 * of a production build of feat/view-share @ fc7ebd6 (before #6), measured
 * 2026-10-10 with `vite build`: 957,741 bytes (Vite prints "957.74 kB").
 */
const BASELINE_ENTRY_BYTES = 957_741
/** AC-06.8: at least 40% smaller → at most 60% of the baseline. */
const MAX_ENTRY_BYTES = Math.floor(BASELINE_ENTRY_BYTES * 0.6) // 574,644

const MARKERS = ['cm-gutters', 'cm-content']

let out = ''
let buildError: Error | null = null

beforeAll(async () => {
  out = mkdtempSync(join(tmpdir(), 'md-review-ac06-'))
  buildError = await new Promise<Error | null>((ok) => {
    execFile(
      process.execPath,
      [join(ROOT, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', out, '--emptyOutDir', '--logLevel', 'warn'],
      { cwd: ROOT, env: { ...process.env, NO_COLOR: '1' }, timeout: 240_000, maxBuffer: 16 * 1024 * 1024 },
      (err, _stdout, stderr) => ok(err ? new Error(`vite build failed: ${err.message}\n${stderr}`) : null),
    )
  })
}, 300_000)

afterAll(() => { if (out) rmSync(out, { recursive: true, force: true }) })

function requireBuild() {
  if (buildError) throw buildError
  expect(existsSync(join(out, 'index.html'))).toBe(true)
}

/** The <script type="module" src> files referenced by dist/index.html, as absolute paths. */
function entryChunks(): string[] {
  const html = readFileSync(join(out, 'index.html'), 'utf-8')
  const files: string[] = []
  for (const m of html.matchAll(/<script\b[^>]*\btype\s*=\s*["']?module[^>]*>/gi)) {
    const src = m[0].match(/\ssrc\s*=\s*["']?([^"'\s>]+)/i)?.[1]
    if (!src) continue
    // vite build without --base: `/assets/index-xxxx.js`
    const p = join(out, src.replace(/^\/+/, '').split(/[?#]/)[0])
    files.push(p)
  }
  return files
}

function runScript(args: string[]) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf-8', timeout: 300_000 })
}

// ── AC-06.7 ────────────────────────────────────────────────────────────────
describe('AC-06.7 production build keeps CodeMirror out of the entry graph', () => {
  it('AC-06.7 the entry JS chunk referenced by dist/index.html does not contain cm-gutters (or cm-content)', () => {
    requireBuild()
    const entries = entryChunks()
    expect(entries.length, 'index.html references an entry module').toBeGreaterThan(0)
    for (const f of entries) {
      expect(existsSync(f), `entry ${f} exists`).toBe(true)
      const code = readFileSync(f, 'utf-8')
      for (const m of MARKERS) expect(code.includes(m), `${f.slice(out.length)} contains ${m}`).toBe(false)
    }
  })

  it('AC-06.7 the check:lazy-editor script passes on the production build', () => {
    requireBuild()
    const r = runScript(['--dist', out])
    expect(r.status, `check-lazy-editor output:\n${r.stdout}\n${r.stderr}`).toBe(0)
    expect(r.stdout).toMatch(/check:lazy-editor PASS/)
  })

  it('AC-06.7 the CodeMirror code still ships, in a lazily loaded chunk (the check is not vacuous)', () => {
    requireBuild()
    const r = runScript(['--dist', out, '--json'])
    const report = JSON.parse(r.stdout)
    expect(report.lazyMarkerFiles.length, `JS files outside the eager set with CodeMirror markers: ${JSON.stringify(report.lazyMarkerFiles)}`).toBeGreaterThan(0)
  })

  it('AC-06.7 package.json defines the check:lazy-editor script, pointing at the check', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'))
    const cmd: unknown = pkg.scripts?.['check:lazy-editor']
    expect(typeof cmd, 'package.json scripts["check:lazy-editor"]').toBe('string')
    expect(cmd as string).toMatch(/check-lazy-editor\.mjs/)
  })
})

// The check script itself, on tiny synthetic builds (fast; proves it catches
// what rule 9 says it must catch and does not flag dynamic imports).
describe('AC-06.7 check:lazy-editor script — self-test on synthetic builds', () => {
  let fake = ''
  beforeAll(() => { fake = mkdtempSync(join(tmpdir(), 'md-review-ac06-fake-')) })
  afterAll(() => { if (fake) rmSync(fake, { recursive: true, force: true }) })

  function makeDist(name: string, files: Record<string, string>, head: string) {
    const d = join(fake, name)
    mkdirSync(join(d, 'assets'), { recursive: true })
    writeFileSync(join(d, 'index.html'), `<!DOCTYPE html><html><head>${head}</head><body><div id="app"></div></body></html>`)
    for (const [p, body] of Object.entries(files)) writeFileSync(join(d, p), body)
    return d
  }
  const CM = 'const t={".cm-gutters":{},".cm-content":{}};export{t as cm};'
  const ENTRY = '<script type="module" crossorigin src="/assets/index-AAAAAAAA.js"></script>'

  it('AC-06.7 fails when the entry chunk contains the markers', () => {
    const d = makeDist('entry-has-cm', { 'assets/index-AAAAAAAA.js': CM }, ENTRY)
    expect(runScript(['--dist', d]).status).toBe(1)
  })

  it('AC-06.7 fails when a chunk the entry statically imports contains the markers', () => {
    const d = makeDist('static-import', {
      'assets/index-AAAAAAAA.js': 'import{cm as e}from"./vendor-BBBBBBBB.js";console.log(e);',
      'assets/vendor-BBBBBBBB.js': CM,
    }, ENTRY)
    expect(runScript(['--dist', d]).status).toBe(1)
  })

  it('AC-06.7 fails when a chunk modulepreloaded by index.html contains the markers', () => {
    const d = makeDist('modulepreload', {
      'assets/index-AAAAAAAA.js': 'console.log(1);',
      'assets/vendor-BBBBBBBB.js': CM,
    }, `${ENTRY}<link rel="modulepreload" crossorigin href="/assets/vendor-BBBBBBBB.js">`)
    expect(runScript(['--dist', d]).status).toBe(1)
  })

  it('AC-06.7 passes when the markers are only in a dynamically imported chunk (any base path)', () => {
    const d = makeDist('dynamic-only', {
      'assets/index-AAAAAAAA.js': 'import"./small-CCCCCCCC.js";const l=()=>import("./EditorPane-DDDDDDDD.js");export{l};',
      'assets/small-CCCCCCCC.js': 'console.log(2);',
      'assets/EditorPane-DDDDDDDD.js': CM,
    }, '<script type="module" crossorigin src="/md-review/assets/index-AAAAAAAA.js"></script>')
    const r = runScript(['--dist', d])
    expect(r.status, r.stdout + r.stderr).toBe(0)
  })

  it('AC-06.7 refuses to pass when no chunk anywhere contains the markers (vacuous check)', () => {
    const d = makeDist('no-cm', { 'assets/index-AAAAAAAA.js': 'console.log(3);' }, ENTRY)
    expect(runScript(['--dist', d]).status).toBe(1)
  })
})

// ── AC-06.8 ────────────────────────────────────────────────────────────────
describe('AC-06.8 entry chunk size', () => {
  it(`AC-06.8 the entry JS chunk is at least 40% smaller than the ${BASELINE_ENTRY_BYTES}-byte baseline (≤ ${MAX_ENTRY_BYTES} bytes)`, () => {
    requireBuild()
    const entries = entryChunks()
    expect(entries.length).toBeGreaterThan(0)
    const bytes = entries.reduce((s, f) => s + statSync(f).size, 0)
    expect(bytes, `entry bytes ${bytes} vs max ${MAX_ENTRY_BYTES} (baseline ${BASELINE_ENTRY_BYTES})`).toBeLessThanOrEqual(MAX_ENTRY_BYTES)
  })
})

// ── AC-06.12 ───────────────────────────────────────────────────────────────
describe('AC-06.12 unused vue-codemirror removed', () => {
  it('AC-06.12 vue-codemirror is not a dependency in package.json', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'))
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      expect(Object.keys(pkg[field] ?? {}), `package.json ${field}`).not.toContain('vue-codemirror')
    }
  })

  it('AC-06.12 package-lock.json (if present) no longer lists vue-codemirror as a root dependency', () => {
    const lockPath = join(ROOT, 'package-lock.json')
    if (!existsSync(lockPath)) return
    const lock = JSON.parse(readFileSync(lockPath, 'utf-8'))
    const root = lock.packages?.[''] ?? {}
    expect(Object.keys(root.dependencies ?? {})).not.toContain('vue-codemirror')
    expect(Object.keys(root.devDependencies ?? {})).not.toContain('vue-codemirror')
  })

  it('AC-06.12 the production build succeeds', () => {
    requireBuild()
    expect(entryChunks().length).toBeGreaterThan(0)
  })
})

// ── Rules 1 and 5: the static import graph from src/main.ts ──────────────────
// Source-level counterpart of AC-06.7: no module statically reachable from
// src/main.ts may import @codemirror/*, codemirror, vue-codemirror,
// EditorPane.vue, EditorToolbar.vue or anything in src/editor/ (type-only
// imports are fine). Catches a static import the network tests would miss.

const SRC = join(ROOT, 'src')
const FORBIDDEN_BARE = /^(?:@codemirror\/|codemirror(?:\/|$)|vue-codemirror(?:\/|$)|@lezer\/)/
const isLazyOnlyFile = (p: string) =>
  /[\\/]components[\\/]EditorPane\.vue$/.test(p) ||
  /[\\/]components[\\/]EditorToolbar\.vue$/.test(p) ||
  p.startsWith(join(SRC, 'editor') + '/')

function scriptBlocks(file: string, text: string): string[] {
  if (!file.endsWith('.vue')) return [text]
  return [...text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1])
}

/** Non-type-only static import/export-from specifiers of a TS/Vue source. */
function staticValueImports(file: string): string[] {
  const text = readFileSync(file, 'utf-8')
  const specs: string[] = []
  for (const block of scriptBlocks(file, text)) {
    const sf = ts.createSourceFile(file + '.ts', block, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    for (const st of sf.statements) {
      if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
        const c = st.importClause
        if (c?.isTypeOnly) continue
        if (c && !c.name && c.namedBindings && ts.isNamedImports(c.namedBindings) &&
            c.namedBindings.elements.length > 0 && c.namedBindings.elements.every((e) => e.isTypeOnly)) continue
        specs.push(st.moduleSpecifier.text)
      } else if (ts.isExportDeclaration(st) && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier)) {
        if (st.isTypeOnly) continue
        specs.push(st.moduleSpecifier.text)
      }
    }
  }
  return specs
}

function resolveLocal(from: string, spec: string): string | null {
  const clean = spec.split('?')[0]
  let base: string
  if (clean.startsWith('@/')) base = join(SRC, clean.slice(2))
  else if (clean.startsWith('.')) base = resolve(dirname(from), clean)
  else return null
  for (const cand of [base, `${base}.ts`, `${base}.vue`, `${base}.js`, `${base}.mjs`, join(base, 'index.ts')]) {
    try { if (statSync(cand).isFile()) return cand } catch { /* next */ }
  }
  return null
}

describe('rule 1 / rule 5: nothing statically reachable from src/main.ts loads the editor', () => {
  it('AC-06.7 (source) no static import path from src/main.ts reaches CodeMirror, EditorPane, EditorToolbar or src/editor/*', () => {
    const start = join(SRC, 'main.ts')
    const seen = new Map<string, string[]>() // file -> import chain
    const queue: Array<[string, string[]]> = [[start, ['src/main.ts']]]
    const violations: string[] = []
    while (queue.length) {
      const [file, chain] = queue.shift()!
      if (seen.has(file)) continue
      seen.set(file, chain)
      if (isLazyOnlyFile(file)) { violations.push(`${chain.join(' → ')} (lazy-only module)`); continue }
      if (!/\.(ts|vue|js|mjs)$/.test(file)) continue
      for (const spec of staticValueImports(file)) {
        if (FORBIDDEN_BARE.test(spec)) { violations.push(`${chain.join(' → ')} → ${spec}`); continue }
        const dep = resolveLocal(file, spec)
        if (dep && !seen.has(dep)) queue.push([dep, [...chain, dep.slice(ROOT.length + 1)]])
      }
    }
    expect(seen.size, 'walked the app graph').toBeGreaterThan(3)
    expect(violations, `static paths into the editor:\n${violations.join('\n')}`).toEqual([])
  })
})
