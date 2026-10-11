// ── Templates (#27): the `/templates*` API for the picker, the save dialog and the library tab ──
// Lazy only: imported by TemplatePicker / SaveTemplateDialog / LibraryTemplates,
// never by the entry chunk (#6 AC-06.8 budget). Every call resolves to
// `{ ok, status, data }` (status 0 = the server could not be reached), so callers
// show `apiErrorText(status, data)` without try/catch.
import { PASTE_API } from '@/composables/pasteApi'
import { saveToken } from '@/composables/useEditToken'
import type { TemplateSummary, TemplateCollectionRef } from '@/composables/templateLogic'

export interface ApiResult<T> { ok: boolean; status: number; data: T | null }

async function call<T>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<ApiResult<T>> {
  try {
    const res = await fetch(`${PASTE_API}${path}`, {
      method: init.method || 'GET',
      headers: init.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: init.signal,
    })
    const text = await res.text()
    let data: T | null = null
    try { data = text ? JSON.parse(text) as T : null } catch { data = null }
    return { ok: res.ok, status: res.status, data }
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') throw e
    return { ok: false, status: 0, data: null }
  }
}

/** The browser's IANA zone, so {{date}}/{{week}} follow the creator's calendar (rule 5). */
export function userTimezone(): string | undefined {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined } catch { return undefined }
}

export interface InstantiateResult { id: string; slug: string | null; editToken?: string; collection: TemplateCollectionRef | null }
export interface SaveTemplateBody {
  name: string; description: string; content: string; contentType: 'markdown' | 'html'
  mode: 'publish' | 'review'; collectionId: string | null; author?: string; replace?: boolean
}
/** 409 body of POST /templates and PATCH: `builtin` → no Replace offered. */
export interface NameClash { error: string; code: 'name_taken'; builtin: boolean; id: string; /** The existing template's name. */ name?: string }

export const listTemplates = () => call<TemplateSummary[]>('/templates')
export const listCollections = () => call<(TemplateCollectionRef & { doc_count?: number })[]>('/library/collections')

export function renderTemplate(id: string, body: { title: string; author?: string; collectionId: string | null }, signal?: AbortSignal) {
  return call<{ content: string }>(`/templates/${encodeURIComponent(id)}/render`, { method: 'POST', body: { ...body, timezone: userTimezone() }, signal })
}

/** Rule 12: create the doc; the returned edit token is stored for it (#23), so the creator can edit. */
export async function instantiateTemplate(id: string, body: { title: string; author?: string; collectionId: string | null }) {
  const r = await call<InstantiateResult>(`/templates/${encodeURIComponent(id)}/instantiate`, { method: 'POST', body: { ...body, timezone: userTimezone() } })
  if (r.ok && r.data?.id && r.data.editToken) saveToken(r.data.id, r.data.editToken, r.data.slug)
  return r
}

export const saveTemplate = (body: SaveTemplateBody) => call<TemplateSummary>('/templates', { method: 'POST', body })
export const renameTemplate = (id: string, name: string) => call<TemplateSummary>(`/templates/${encodeURIComponent(id)}`, { method: 'PATCH', body: { name } })
export const deleteTemplate = (id: string) => call<null>(`/templates/${encodeURIComponent(id)}`, { method: 'DELETE' })

/** The doc's collection (for the save dialog's default); null when unknown. */
export async function docCollectionId(docId: string): Promise<string | null> {
  const r = await call<{ collection?: TemplateCollectionRef | null }>(`/paste/${encodeURIComponent(docId)}?fields=meta,library`)
  return r.ok ? r.data?.collection?.id ?? null : null
}
