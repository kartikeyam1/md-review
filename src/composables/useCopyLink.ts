import { toast } from '@/composables/useToast'

/** Write `text` to the clipboard: async API first, then the execCommand fallback. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch { /* fall back */ }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    ta.remove()
    return ok
  } catch {
    return false
  }
}

/** Copy a doc link with an app-toast either way (#2 rule 8). */
export async function copyDocLink(url: string): Promise<boolean> {
  const ok = await copyText(url)
  if (ok) toast.info('Link copied')
  else toast.error(`Couldn't copy the link. Copy it from here: ${url}`)
  return ok
}
