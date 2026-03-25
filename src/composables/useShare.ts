import { ref } from 'vue'
import type { Comment } from '@/types'

const PASTE_API = import.meta.env.VITE_PASTE_API_URL || ''

export interface SharedPayload {
  markdown: string
  filename: string
  comments: Comment[]
  sharedAt: string
}

export function useShare() {
  const sharing = ref(false)
  const shareError = ref<string | null>(null)

  async function createShare(markdown: string, filename: string, comments: Comment[]): Promise<string | null> {
    sharing.value = true
    shareError.value = null

    const payload: SharedPayload = {
      markdown,
      filename,
      comments,
      sharedAt: new Date().toISOString(),
    }

    try {
      const res = await fetch(`${PASTE_API}/paste`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })

      if (!res.ok) {
        shareError.value = `Server error (${res.status})`
        return null
      }

      const { id } = await res.json()
      return id as string
    } catch (e) {
      shareError.value = 'Could not reach paste service. Are you on VPN?'
      return null
    } finally {
      sharing.value = false
    }
  }

  async function loadShare(id: string): Promise<SharedPayload | null> {
    try {
      const res = await fetch(`${PASTE_API}/paste/${encodeURIComponent(id)}`)
      if (!res.ok) return null
      return await res.json() as SharedPayload
    } catch {
      return null
    }
  }

  function getShareIdFromHash(): string | null {
    const hash = window.location.hash
    const match = hash.match(/^#shared=([a-f0-9]+)$/)
    return match ? match[1] : null
  }

  function setShareHash(id: string) {
    window.history.replaceState({}, '', `${window.location.pathname}${window.location.search}#shared=${id}`)
  }

  function getShareUrls(id: string) {
    const ui = `${window.location.origin}${window.location.pathname}#shared=${id}`
    const api = `${PASTE_API}/paste/${id}`
    return { ui, api, comments: `${api}/comments`, markdown: `${api}/markdown` }
  }

  return { sharing, shareError, createShare, loadShare, getShareIdFromHash, setShareHash, getShareUrls }
}
