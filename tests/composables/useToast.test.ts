import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useToast, _resetToasts, TOAST_MAX } from '@/composables/useToast'

describe('useToast (00 §3.1)', () => {
  beforeEach(() => { vi.useFakeTimers(); _resetToasts() })
  afterEach(() => { _resetToasts(); vi.useRealTimers() })

  it('info dismisses after 4 s, error after 8 s', () => {
    const t = useToast()
    t.info('hello')
    t.error('boom', { key: 'k' })
    expect(t.toasts.value.map((x) => x.kind)).toEqual(['info', 'error'])
    expect(t.toasts.value[1].key).toBe('k')
    vi.advanceTimersByTime(4001)
    expect(t.toasts.value.map((x) => x.kind)).toEqual(['error'])
    vi.advanceTimersByTime(4000)
    expect(t.toasts.value).toEqual([])
  })

  it(`keeps at most ${TOAST_MAX}, dropping the oldest`, () => {
    const t = useToast()
    for (const s of ['a', 'b', 'c', 'd']) t.info(s)
    expect(t.toasts.value.map((x) => x.text)).toEqual(['b', 'c', 'd'])
  })

  it('dismiss removes one toast', () => {
    const t = useToast()
    const id = t.success('ok')
    t.dismiss(id)
    expect(t.toasts.value).toEqual([])
  })
})

describe('useToast pause/resume (hover/focus)', () => {
  beforeEach(() => { vi.useFakeTimers(); _resetToasts() })
  afterEach(() => { _resetToasts(); vi.useRealTimers() })

  it('a paused toast stays; resume gives it the time it had left', () => {
    const t = useToast()
    const id = t.info('hold me')
    vi.advanceTimersByTime(3000)
    t.pause(id)
    vi.advanceTimersByTime(60_000)
    expect(t.toasts.value.length).toBe(1)
    t.resume(id)
    vi.advanceTimersByTime(999)
    expect(t.toasts.value.length).toBe(1)
    vi.advanceTimersByTime(2)
    expect(t.toasts.value).toEqual([])
  })

  it('the live-region texts follow the newest polite and assertive toasts', () => {
    const t = useToast()
    t.info('first')
    const e = t.error('broke')
    t.success('second')
    expect(t.latestPolite.value).toBe('second')
    expect(t.latestAssertive.value).toBe('broke')
    t.dismiss(e)
    expect(t.latestAssertive.value).toBe('')
  })
})
