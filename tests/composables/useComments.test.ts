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
      category: 'suggestion',
    })
    expect(comments.value).toHaveLength(1)
    expect(comments.value[0].startLine).toBe(5)
    expect(comments.value[0].selectedText).toBe('Zero downtime deploys')
    expect(comments.value[0].body).toBe('Needs more detail')
    expect(comments.value[0].category).toBe('suggestion')
    expect(comments.value[0].id).toBeTruthy()
    expect(comments.value[0].createdAt).toBeGreaterThan(0)
  })

  it('deletes a comment by id', () => {
    const { comments, addComment, deleteComment } = useComments()
    addComment({ startLine: 1, endLine: 1, selectedText: 'a', body: 'b', category: 'nit' })
    addComment({ startLine: 3, endLine: 4, selectedText: 'c', body: 'd', category: 'must-fix' })
    const idToDelete = comments.value[0].id
    deleteComment(idToDelete)
    expect(comments.value).toHaveLength(1)
    expect(comments.value[0].selectedText).toBe('c')
  })

  it('edits a comment body', () => {
    const { comments, addComment, editComment } = useComments()
    addComment({ startLine: 1, endLine: 1, selectedText: 'a', body: 'original', category: 'suggestion' })
    const id = comments.value[0].id
    editComment(id, { body: 'updated' })
    expect(comments.value[0].body).toBe('updated')
  })

  it('edits a comment category', () => {
    const { comments, addComment, editComment } = useComments()
    addComment({ startLine: 1, endLine: 1, selectedText: 'a', body: 'b', category: 'suggestion' })
    const id = comments.value[0].id
    editComment(id, { category: 'must-fix' })
    expect(comments.value[0].category).toBe('must-fix')
  })

  it('clears all comments', () => {
    const { comments, addComment, clearComments } = useComments()
    addComment({ startLine: 1, endLine: 1, selectedText: 'a', body: 'b', category: 'nit' })
    addComment({ startLine: 2, endLine: 2, selectedText: 'c', body: 'd', category: 'question' })
    clearComments()
    expect(comments.value).toEqual([])
  })

  it('returns comments sorted by startLine', () => {
    const { comments, addComment } = useComments()
    addComment({ startLine: 10, endLine: 10, selectedText: 'b', body: 'second', category: 'nit' })
    addComment({ startLine: 2, endLine: 3, selectedText: 'a', body: 'first', category: 'suggestion' })
    expect(comments.value[0].startLine).toBe(2)
    expect(comments.value[1].startLine).toBe(10)
  })

  it('loads comments from external source', () => {
    const { comments, loadComments } = useComments()
    loadComments([
      { id: 'x', startLine: 0, endLine: 1, selectedText: 'hi', body: 'test', category: 'question', createdAt: 1 },
    ])
    expect(comments.value).toHaveLength(1)
    expect(comments.value[0].id).toBe('x')
  })
})
