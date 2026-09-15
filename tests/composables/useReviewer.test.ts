import { describe, it, expect, beforeEach } from 'vitest'
import { useReviewer } from '@/composables/useReviewer'

describe('useReviewer', () => {
  beforeEach(() => { localStorage.clear(); useReviewer().setReviewerName('') })

  it('is empty by default and yields no author field', () => {
    const { reviewerName, authorField } = useReviewer()
    expect(reviewerName.value).toBe('')
    expect(authorField()).toEqual({})
  })

  it('remembers the name across instances and in localStorage, trimmed', () => {
    useReviewer().setReviewerName('  Kartikeya  ')
    const { reviewerName, authorField } = useReviewer()
    expect(reviewerName.value).toBe('Kartikeya')
    expect(authorField()).toEqual({ author: 'Kartikeya' })
    expect(localStorage.getItem('md-review-reviewer')).toBe('Kartikeya')
  })

  it('clearing the name removes it from storage', () => {
    useReviewer().setReviewerName('x')
    useReviewer().setReviewerName('')
    expect(localStorage.getItem('md-review-reviewer')).toBeNull()
  })
})
