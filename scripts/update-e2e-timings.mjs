#!/usr/bin/env node
// Refresh tests/e2e/timings.json (seconds per e2e file) from verify.sh output,
// so CI shards are balanced by real runtime instead of file size.
//
//   node scripts/update-e2e-timings.mjs <summary-or-log> [more files...]
//
// Accepts .verify/runs/<id>/summary.txt or a CI log; reads lines like
// "e2e/app  PASS 50/50 pass ... 36.4" or "[verify] e2e/app PASS ... (36.4s)".
// Later files win; files not mentioned keep their previous timing.
import { readFileSync, writeFileSync, existsSync } from 'node:fs'

const OUT = new URL('../tests/e2e/timings.json', import.meta.url)
const timings = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : {}
const sources = process.argv.slice(2)
if (!sources.length) { console.error('usage: update-e2e-timings.mjs <summary-or-log>...'); process.exit(2) }
let n = 0
for (const src of sources) {
  for (const raw of readFileSync(src, 'utf8').split('\n')) {
    const line = raw.replace(/^.*?Z /, '') // strip CI timestamps
    const m = line.match(/e2e\/([\w.-]+)\s+PASS\b.*?\(?(\d+(?:\.\d+)?)s?\)?\s*$/)
    if (m) { timings[m[1]] = Number(m[2]); n++ }
  }
}
const sorted = Object.fromEntries(Object.entries(timings).sort(([a], [b]) => a.localeCompare(b)))
writeFileSync(OUT, JSON.stringify(sorted, null, 2) + '\n')
console.log(`updated ${n} timings → tests/e2e/timings.json (${Object.keys(sorted).length} files)`)
