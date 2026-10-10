// Computed-style assertions for brand / theme checks.
//
//   import { expectComputedStyle } from './lib/brand.mjs'
//   await expectComputedStyle(page, 'body', { backgroundColor: '#F7F3EB', color: '#1a1612' })
//   await expectComputedStyle(page, '.title', { 'font-weight': '600', fontFamily: /Crimson Pro/ })
//
// - Property names may be camelCase or kebab-case.
// - Colour checks (any *color* / fill / stroke / background property, or an
//   expected value written as #hex, rgb(), hsl(), oklch(), color() ...) are
//   normalised in the browser — whatever form the engine computes — to
//   upper-case hex (#RRGGBB, or #RRGGBBAA when translucent), so '#280a38',
//   '#280A38' and 'rgb(40, 10, 56)' all compare equal.
// - A RegExp matches the raw computed value; a function gets (actual) and must
//   return true. Anything else is compared as a trimmed string.
// - Uses the first element matching `selector` (a Playwright selector or a
//   Locator); waits for it to be attached.
// - Throws an AssertionError listing every mismatching property.

import assert from 'node:assert/strict'

const kebab = (p) => p.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase())

// A colour comparison happens when the property is a colour property, or the
// expected value is written in an explicit colour syntax.
function isColourCheck(prop, want) {
  if (typeof want !== 'string') return false
  return /color|^fill$|^stroke$|^background$/.test(kebab(prop)) ||
    /^\s*(#[0-9a-f]{3,8}\b|(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\()/i.test(want)
}

/**
 * Normalise CSS colours to #RRGGBB / #RRGGBBAA inside the page (so the browser
 * parses every syntax it supports). Returns null for unparseable values.
 */
export async function toHex(page, values) {
  return page.evaluate((vals) => {
    const c = document.createElement('canvas').getContext('2d')
    const hex = (n) => Math.round(n).toString(16).padStart(2, '0').toUpperCase()
    return vals.map((v) => {
      // Two sentinels detect "invalid colour" (fillStyle keeps the old value).
      c.fillStyle = '#010203'; c.fillStyle = v; const a = c.fillStyle
      c.fillStyle = '#040506'; c.fillStyle = v; const b = c.fillStyle
      if (a !== b) return null
      if (a.startsWith('#')) return a.toUpperCase()
      const m = a.match(/rgba?\(([^)]+)\)/)
      if (!m) return null
      const [r, g, bl, al = '1'] = m[1].split(',').map((s) => s.trim())
      const alpha = parseFloat(al)
      return '#' + hex(+r) + hex(+g) + hex(+bl) + (alpha < 1 ? hex(alpha * 255) : '')
    })
  }, values)
}

/** Read computed styles (kebab-case keys) for the first match of `selector`. */
export async function getComputedStyles(page, selector, props) {
  const loc = typeof selector === 'string' ? page.locator(selector).first() : selector.first()
  await loc.waitFor({ state: 'attached' })
  return loc.evaluate((el, ps) => {
    const cs = getComputedStyle(el)
    return Object.fromEntries(ps.map((p) => [p, cs.getPropertyValue(p).trim()]))
  }, props.map(kebab))
}

export async function expectComputedStyle(page, selector, expected) {
  const props = Object.keys(expected)
  const actual = await getComputedStyles(page, selector, props)
  const colourProps = props.filter((p) => isColourCheck(p, expected[p]))
  const toNorm = colourProps.flatMap((p) => [expected[p], actual[kebab(p)]])
  const norm = toNorm.length ? await toHex(page, toNorm) : []
  const mismatches = []
  props.forEach((p) => {
    const want = expected[p]
    const got = actual[kebab(p)]
    let ok
    let shown = got
    const ci = colourProps.indexOf(p)
    if (ci >= 0) {
      const [w, g] = [norm[ci * 2], norm[ci * 2 + 1]]
      // An expected value the browser can't parse as a colour (e.g. a
      // `background` shorthand) falls back to a plain string comparison.
      ok = w === null ? String(want).trim() === got : w === g
      shown = `${g ?? got} (computed "${got}")`
    } else if (want instanceof RegExp) ok = want.test(got)
    else if (typeof want === 'function') ok = !!want(got)
    else ok = String(want).trim() === got
    if (!ok) mismatches.push(`  ${kebab(p)}: expected ${want instanceof RegExp ? want : JSON.stringify(want)}, got ${shown}`)
  })
  if (mismatches.length) {
    throw new assert.AssertionError({
      message: `computed style mismatch on ${typeof selector === 'string' ? selector : 'locator'}:\n${mismatches.join('\n')}`,
      actual, expected, operator: 'expectComputedStyle',
    })
  }
  return actual
}
