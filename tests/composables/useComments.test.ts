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

  it('adds a comment with empty replies array', () => {
    const { comments, addComment } = useComments()
    addComment({ startLine: 1, endLine: 1, selectedText: 'a', body: 'b', category: 'nit' })
    expect(comments.value[0].replies).toEqual([])
  })

  it('adds a reply to a comment', () => {
    const { comments, addComment, addReply } = useComments()
    addComment({ startLine: 1, endLine: 1, selectedText: 'a', body: 'b', category: 'nit' })
    const commentId = comments.value[0].id
    const reply = addReply(commentId, { body: 'looks good' })
    expect(comments.value[0].replies).toHaveLength(1)
    expect(comments.value[0].replies[0].body).toBe('looks good')
    expect(comments.value[0].replies[0].id).toBeTruthy()
    expect(comments.value[0].replies[0].createdAt).toBeGreaterThan(0)
    expect(reply.id).toBe(comments.value[0].replies[0].id)
  })

  it('adds a reply with author', () => {
    const { comments, addComment, addReply } = useComments()
    addComment({ startLine: 1, endLine: 1, selectedText: 'a', body: 'b', category: 'nit' })
    const commentId = comments.value[0].id
    addReply(commentId, { body: 'fixed', author: 'claude-code' })
    expect(comments.value[0].replies[0].author).toBe('claude-code')
  })

  it('edits a reply body', () => {
    const { comments, addComment, addReply, editReply } = useComments()
    addComment({ startLine: 1, endLine: 1, selectedText: 'a', body: 'b', category: 'nit' })
    const commentId = comments.value[0].id
    addReply(commentId, { body: 'original' })
    const replyId = comments.value[0].replies[0].id
    editReply(commentId, replyId, 'updated')
    expect(comments.value[0].replies[0].body).toBe('updated')
  })

  it('deletes a reply', () => {
    const { comments, addComment, addReply, deleteReply } = useComments()
    addComment({ startLine: 1, endLine: 1, selectedText: 'a', body: 'b', category: 'nit' })
    const commentId = comments.value[0].id
    addReply(commentId, { body: 'first' })
    addReply(commentId, { body: 'second' })
    expect(comments.value[0].replies).toHaveLength(2)
    const replyId = comments.value[0].replies[0].id
    deleteReply(commentId, replyId)
    expect(comments.value[0].replies).toHaveLength(1)
    expect(comments.value[0].replies[0].body).toBe('second')
  })

  it('loadComments initializes missing replies to empty array', () => {
    const { comments, loadComments } = useComments()
    loadComments([
      { id: 'x', startLine: 0, endLine: 1, selectedText: 'hi', body: 'test', category: 'question', createdAt: 1 } as any,
    ])
    expect(comments.value[0].replies).toEqual([])
  })
})
