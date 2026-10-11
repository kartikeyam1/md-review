// #8: history kept across an editor unmount (view switch) comes back only for
// the same text and when no barrier happened meanwhile.
import { describe, it, expect } from 'vitest'
import { EditorState } from '@codemirror/state'
import { undoDepth } from '@codemirror/commands'
import { historyExtension, keepState, takeKeptState } from '@/editor/history'
import { historyBarrier, markExternalChange, takeExternalOrigin } from '@/composables/useExternalChange'

function editedState() {
  let state = EditorState.create({ doc: 'hello', extensions: historyExtension() })
  state = state.update({ changes: { from: 5, insert: ' world' }, userEvent: 'input.type' }).state
  return state
}

function revive(doc: string) {
  const kept = takeKeptState(doc)
  if (!kept) return null
  return EditorState.create({ doc, selection: kept.selection, extensions: historyExtension(kept.extension) })
}

describe('#8 kept editor history', () => {
  it('same text, no barrier → selection and undo history come back (once)', () => {
    const s = editedState()
    keepState(s)
    const back = revive('hello world')
    expect(back).not.toBeNull()
    expect(undoDepth(back!)).toBe(1)
    expect(back!.selection.main.head).toBe(s.selection.main.head)
    expect(takeKeptState('hello world')).toBeNull() // consumed
  })

  it('different text → nothing comes back', () => {
    keepState(editedState())
    expect(revive('hello world!')).toBeNull()
  })

  it('a barrier (doc switch) or a remote write meanwhile → nothing comes back', () => {
    keepState(editedState())
    historyBarrier()
    expect(revive('hello world')).toBeNull()

    keepState(editedState())
    markExternalChange('hello world', 'remote')
    takeExternalOrigin('hello world')
    expect(revive('hello world')).toBeNull()
  })

  it('a local mark (revision restore) is not a barrier', () => {
    keepState(editedState())
    markExternalChange('other', 'local')
    takeExternalOrigin('other')
    expect(revive('hello world')).not.toBeNull()
  })
})
