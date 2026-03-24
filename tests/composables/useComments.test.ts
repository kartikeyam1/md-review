import { describe, it, expect } from 'vitest'
import { useComments } from '@/composables/useComments'

describe('useComments', () => {
  it('starts with empty comments list', () => {
    const { comments } = useComments()
    expect(comments.value).toEqual([])
  })

  it('adds a comment', () => {
    const { comments, addComment } = useComments()
    addComment({
      startLine: 5,
      endLine: 5,
      selectedText: 'Zero downtime deploys',
      body: 'Needs more detail',
    })
    expect(comments.value).toHaveLength(1)
    expect(comments.value[0].startLine).toBe(5)
    expect(comments.value[0].selectedText).toBe('Zero downtime deploys')
    expect(comments.value[0].body).toBe('Needs more detail')
    expect(comments.value[0].id).toBeTruthy()
    expect(comments.value[0].createdAt).toBeGreaterThan(0)
  })

  it('deletes a comment by id', () => {
    const { comments, addComment, deleteComment } = useComments()
    addComment({ startLine: 1, endLine: 1, selectedText: 'a', body: 'b' })
    addComment({ startLine: 3, endLine: 4, selectedText: 'c', body: 'd' })
    const idToDelete = comments.value[0].id
    deleteComment(idToDelete)
    expect(comments.value).toHaveLength(1)
    expect(comments.value[0].selectedText).toBe('c')
  })

  it('clears all comments', () => {
    const { comments, addComment, clearComments } = useComments()
    addComment({ startLine: 1, endLine: 1, selectedText: 'a', body: 'b' })
    addComment({ startLine: 2, endLine: 2, selectedText: 'c', body: 'd' })
    clearComments()
    expect(comments.value).toEqual([])
  })

  it('returns comments sorted by startLine', () => {
    const { comments, addComment } = useComments()
    addComment({ startLine: 10, endLine: 10, selectedText: 'b', body: 'second' })
    addComment({ startLine: 2, endLine: 3, selectedText: 'a', body: 'first' })
    expect(comments.value[0].startLine).toBe(2)
    expect(comments.value[1].startLine).toBe(10)
  })
})
