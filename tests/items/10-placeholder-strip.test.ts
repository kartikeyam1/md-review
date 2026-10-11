// #10 rule 13 (orchestrator follow-up): placeholders of images still uploading never persist.
// Contract: src/composables/attachments.ts exports registerPendingPaste(id, {text, placeholders, replaced}),
// unregisterPendingPaste(id), stripPendingPlaceholders(text), STALE_PLACEHOLDER_RE.
import { describe, it, expect, afterEach } from 'vitest'
import {
  registerPendingPaste, unregisterPendingPaste, stripPendingPlaceholders, STALE_PLACEHOLDER_RE, placeholderText,
} from '@/composables/attachments'

const A = placeholderText('a')
const B = placeholderText('b')
afterEach(() => { for (let i = 1; i <= 5; i++) unregisterPendingPaste(i) })

describe('#10 stripPendingPlaceholders', () => {
  it('returns the text unchanged when nothing uploads', () => {
    expect(stripPendingPlaceholders(`x ${A} y`)).toBe(`x ${A} y`)
  })
  it('a whole pending paste goes back to what it replaced', () => {
    registerPendingPaste(1, { text: `${A}\n\n${B}`, placeholders: [A, B], replaced: '' })
    expect(stripPendingPlaceholders(`# T\n\n${A}\n\n${B}`)).toBe('# T\n\n')
    registerPendingPaste(2, { text: A, placeholders: [A], replaced: 'SEL' })
    unregisterPendingPaste(1)
    expect(stripPendingPlaceholders(`hello ${A} world`)).toBe('hello SEL world')
  })
  it('a paste edited in between: each placeholder goes with its joining blank line', () => {
    registerPendingPaste(1, { text: `${A}\n\n${B}`, placeholders: [A, B], replaced: '' })
    expect(stripPendingPlaceholders(`${A}\n\ntyped\n\n${B}`)).toBe('typed\n\n')
  })
  it('after unregistering, nothing is stripped', () => {
    registerPendingPaste(1, { text: A, placeholders: [A], replaced: '' })
    unregisterPendingPaste(1)
    expect(stripPendingPlaceholders(A)).toBe(A)
  })
})

describe('#10 STALE_PLACEHOLDER_RE', () => {
  it('matches leftover placeholders (and the blank line between two), not real images', () => {
    const doc = `# T\n\n${A}\n\n${B}\n\n![real](https://x/y.png) ![Uploading](u)`
    expect(doc.replace(STALE_PLACEHOLDER_RE, '')).toBe('# T\n\n\n\n![real](https://x/y.png) ![Uploading](u)')
  })
})
