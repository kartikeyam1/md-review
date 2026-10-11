#!/usr/bin/env node
// #6 Lazy-load the editor — build-level check (docs/build/specs/06-lazy-editor.md rule 9, AC-06.7).
//
//   node scripts/check-lazy-editor.mjs                 # vite build into a temp dir, check it, delete it
//   node scripts/check-lazy-editor.mjs --dist <dir>    # check an existing production build (e.g. .verify/dist)
//   node scripts/check-lazy-editor.mjs --json          # machine-readable report on stdout
//
// package.json: "check:lazy-editor": "node scripts/check-lazy-editor.mjs"
//
// What it checks. The "eager set" is every JS file a reader downloads before
// anyone touches the editor:
//   - the entry module(s): <script type="module" src> in dist/index.html,
//   - every <link rel="modulepreload" href> in dist/index.html,
//   - and, transitively, every chunk those files import STATICALLY
//     (`import … from "./x.js"`, `import "./x.js"`, `export … from "./x.js"`).
// Dynamic `import("./x.js")` targets (and Vite's __vitePreload dependency lists,
// which are fetched only when that dynamic import runs) are the lazy boundary
// and are not followed.
//
// It fails (exit 1) when
//   - any file in the eager set contains a CodeMirror marker (`cm-gutters`,
//     `cm-content` — class names CodeMirror's runtime CSS and DOM use), or
//   - no JS file anywhere in the build contains a marker (the editor vanished
//     from the build, or CodeMirror renamed its classes: the check would be
//     vacuous, so it refuses to pass).
// Exit 2 on usage / build errors. It prints the entry size for the record
// (AC-06.8 is asserted by tests/items/06-lazy-editor.test.ts, not here).
//
// No dependencies beyond Node; the repo's dist/ is never touched unless you
// pass it with --dist.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const MARKERS = ['cm-gutters', 'cm-content']
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** src/href attribute values of the entry scripts and modulepreload links in an HTML string. */
export function htmlEntryRefs(html) {
  const entries = []
  const preloads = []
  const attr = (tag, name) => {
    const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'))
    return m ? (m[1] ?? m[2] ?? m[3]) : null
  }
  for (const m of html.matchAll(/<script\b[^>]*>/gi)) {
    const tag = m[0]
    if (!/\stype\s*=\s*["']?module/i.test(tag)) continue
    const src = attr(tag, 'src')
    if (src) entries.push(src)
  }
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0]
    if (!/\srel\s*=\s*["']?modulepreload/i.test(tag)) continue
    const href = attr(tag, 'href')
    if (href) preloads.push(href)
  }
  return { entries, preloads }
}

/** Static import / re-export specifiers of a (minified) ES module. Dynamic import() is excluded. */
export function staticSpecifiers(code) {
  const out = new Set()
  // `import"x"`, `import x from"x"`, `import{a as b}from"x"`, `import*as n from"x"` — not `import(` / `import.meta`
  const imp = /(?:^|[^.\w$])import\s*(?:[\w$*{}\s,]*?\s*from\s*)?(["'])([^"'\n]+?)\1/g
  // `export{a}from"x"`, `export*from"x"`
  const exp = /(?:^|[^.\w$])export\s*[\w$*{}\s,]*?\s*from\s*(["'])([^"'\n]+?)\1/g
  for (const re of [imp, exp]) for (const m of code.matchAll(re)) out.add(m[2])
  return [...out]
}

/** Map a URL/specifier from the build to a file in dist (handles any base path), or null. */
function resolveInDist(dist, fromFile, spec) {
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(spec)) return null // http:, data:, protocol-relative
  const clean = spec.split(/[?#]/)[0]
  if (clean.startsWith('.')) {
    const p = resolve(dirname(fromFile), clean)
    return isFile(p) && inside(dist, p) ? p : null
  }
  // Absolute or bare: try the longest suffix of the path that exists under dist
  // (`/md-review/assets/x.js` -> `assets/x.js`).
  const parts = clean.replace(/^\/+/, '').split('/')
  for (let i = 0; i < parts.length; i++) {
    const p = join(dist, ...parts.slice(i))
    if (isFile(p)) return p
  }
  return null
}

const isFile = (p) => { try { return statSync(p).isFile() } catch { return false } }
const inside = (root, p) => p === root || p.startsWith(root + sep)

function allJs(dir) {
  const out = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...allJs(p))
    else if (/\.m?js$/.test(e.name)) out.push(p)
  }
  return out
}

/**
 * Check a production build. Returns a report; `ok` is the verdict.
 *   { ok, dist, entries: [{file, bytes}], eager: [{file, bytes, markers}], offenders: [...],
 *     lazyMarkerFiles: [...], problems: [string] }
 */
export function checkDist(distDir) {
  const dist = resolve(distDir)
  const problems = []
  const indexHtml = join(dist, 'index.html')
  if (!isFile(indexHtml)) {
    return { ok: false, dist, entries: [], eager: [], offenders: [], lazyMarkerFiles: [], problems: [`no index.html in ${dist}`] }
  }
  const { entries, preloads } = htmlEntryRefs(readFileSync(indexHtml, 'utf-8'))
  const entryFiles = []
  for (const ref of entries) {
    const f = resolveInDist(dist, indexHtml, ref)
    if (f) entryFiles.push(f)
    else problems.push(`entry script ${ref} not found in dist`)
  }
  if (!entryFiles.length && !problems.length) problems.push('index.html has no <script type="module" src>')

  const seen = new Set()
  const queue = [...entryFiles]
  for (const ref of preloads) {
    const f = resolveInDist(dist, indexHtml, ref)
    if (f) queue.push(f)
  }
  while (queue.length) {
    const f = queue.shift()
    if (seen.has(f)) continue
    seen.add(f)
    if (!/\.m?js$/.test(f)) continue
    const code = readFileSync(f, 'utf-8')
    for (const spec of staticSpecifiers(code)) {
      const dep = resolveInDist(dist, f, spec)
      if (dep && !seen.has(dep)) queue.push(dep)
    }
  }

  const markersIn = (f) => { const s = readFileSync(f, 'utf-8'); return MARKERS.filter((m) => s.includes(m)) }
  const rel = (f) => relative(dist, f).split(sep).join('/')
  const eager = [...seen].filter((f) => /\.m?js$/.test(f)).map((f) => ({ file: rel(f), bytes: statSync(f).size, markers: markersIn(f) }))
  const offenders = eager.filter((e) => e.markers.length)
  const lazyMarkerFiles = allJs(dist).filter((f) => !seen.has(f) && markersIn(f).length).map(rel)
  if (!offenders.length && !lazyMarkerFiles.length) {
    problems.push(`no JS file in the build contains ${MARKERS.join(' / ')} — the editor is missing from the build or CodeMirror renamed its classes; the check would be vacuous`)
  }
  return {
    ok: offenders.length === 0 && problems.length === 0,
    dist,
    entries: entryFiles.map((f) => ({ file: rel(f), bytes: statSync(f).size })),
    eager,
    offenders,
    lazyMarkerFiles,
    problems,
  }
}

function build(outDir) {
  const r = spawnSync(process.execPath, [join(REPO_ROOT, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', outDir, '--emptyOutDir', '--logLevel', 'warn'], {
    cwd: REPO_ROOT, env: { ...process.env, NO_COLOR: '1' }, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024, timeout: 300_000,
  })
  if (r.status !== 0) throw new Error(`vite build failed (status ${r.status}):\n${(r.stdout || '') + (r.stderr || '')}`.slice(-4000))
}

function main(argv) {
  let dist = null
  let json = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dist') dist = argv[++i]
    else if (a.startsWith('--dist=')) dist = a.slice(7)
    else if (a === '--json') json = true
    else if (a === '-h' || a === '--help') { console.log(readFileSync(fileURLToPath(import.meta.url), 'utf-8').split('\n').slice(1, 30).map((l) => l.replace(/^\/\/ ?/, '')).join('\n')); return 0 }
    else { console.error(`unknown argument: ${a}`); return 2 }
  }
  let tmp = null
  try {
    if (!dist) {
      tmp = mkdtempSync(join(tmpdir(), 'md-review-lazy-editor-'))
      dist = tmp
      build(dist)
    } else if (!existsSync(dist)) {
      console.error(`--dist ${dist} does not exist`); return 2
    }
    const r = checkDist(dist)
    if (json) {
      console.log(JSON.stringify(r, null, 2))
    } else {
      for (const e of r.entries) console.log(`entry  ${e.file}  ${e.bytes} bytes (${(e.bytes / 1000).toFixed(1)} kB)`)
      console.log(`eager  ${r.eager.length} JS file(s), ${r.eager.reduce((s, e) => s + e.bytes, 0)} bytes`)
      console.log(`lazy   ${r.lazyMarkerFiles.length} JS file(s) with CodeMirror markers: ${r.lazyMarkerFiles.join(', ') || '—'}`)
      for (const o of r.offenders) console.log(`FAIL   ${o.file} is loaded eagerly and contains ${o.markers.join(', ')}`)
      for (const p of r.problems) console.log(`FAIL   ${p}`)
      console.log(r.ok ? 'check:lazy-editor PASS' : 'check:lazy-editor FAIL')
    }
    return r.ok ? 0 : 1
  } catch (e) {
    console.error(String(e?.message ?? e)); return 2
  } finally {
    if (tmp) rmSync(tmp, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2))
}
