// axe-core accessibility scan, filtered by impact.
//
//   import { runAxe, formatViolations } from './lib/axe.mjs'
//   const v = await runAxe(page)                            // serious + critical
//   const all = await runAxe(page, { minImpact: 'minor' })
//   const v2 = await runAxe(page, { include: '.preview', disableRules: ['color-contrast'] })
//   assert.equal(v.length, 0, formatViolations(v))
//
// Options:
//   minImpact     'minor' | 'moderate' | 'serious' | 'critical'   (default 'serious')
//   impacts       explicit list instead of minImpact, e.g. ['critical']
//   include       selector (or array) to scope the scan
//   exclude       selector (or array) to leave out
//   tags          axe rule tags, e.g. ['wcag2a', 'wcag2aa']   (default: axe defaults)
//   disableRules  rule ids to skip
//   rules         run only these rule ids, e.g. ['color-contrast']
// Returns the filtered `violations` array from axe (each has id, impact, help,
// helpUrl, nodes[].target).

import { AxeBuilder } from '@axe-core/playwright'

const ORDER = ['minor', 'moderate', 'serious', 'critical']

export async function runAxe(page, opts = {}) {
  const { minImpact = 'serious', impacts, include, exclude, tags, disableRules, rules } = opts
  let builder = new AxeBuilder({ page })
  for (const s of [].concat(include ?? [])) builder = builder.include(s)
  for (const s of [].concat(exclude ?? [])) builder = builder.exclude(s)
  if (tags?.length) builder = builder.withTags(tags)
  if (disableRules?.length) builder = builder.disableRules(disableRules)
  if (rules?.length) builder = builder.withRules(rules)
  const { violations } = await builder.analyze()
  const wanted = new Set(impacts ?? ORDER.slice(ORDER.indexOf(minImpact)))
  return violations.filter((v) => wanted.has(v.impact ?? 'minor'))
}

export function formatViolations(violations) {
  if (!violations.length) return 'no axe violations'
  return violations.map((v) =>
    `[${v.impact}] ${v.id}: ${v.help} (${v.nodes.length} node${v.nodes.length === 1 ? '' : 's'})\n` +
    v.nodes.slice(0, 5).map((n) => `    ${[].concat(n.target).join(' ')}`).join('\n') +
    `\n    ${v.helpUrl}`,
  ).join('\n')
}
