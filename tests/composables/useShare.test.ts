import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useShare } from '@/composables/useShare'

describe('useShare – fetchGithub', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('returns content and filename on success', async () => {
    const mockResponse = { content: '# Hello', filename: 'README.md' }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    }))

    const { fetchGithub } = useShare()
    const result = await fetchGithub('https://github.com/owner/repo/blob/main/README.md')

    expect(result).toEqual({ content: '# Hello', filename: 'README.md' })
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('/github?url=https%3A%2F%2Fgithub.com%2Fowner%2Frepo%2Fblob%2Fmain%2FREADME.md')
    )
  })

  it('sets shareError and returns null on HTTP error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: () => Promise.resolve({ error: 'Not a recognized GitHub file URL' }),
    }))

    const { fetchGithub, shareError } = useShare()
    const result = await fetchGithub('https://example.com/not-github')

    expect(result).toBeNull()
    expect(shareError.value).toBe('Not a recognized GitHub file URL')
  })

  it('sets shareError and returns null on network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')))

    const { fetchGithub, shareError } = useShare()
    const result = await fetchGithub('https://github.com/owner/repo/blob/main/README.md')

    expect(result).toBeNull()
    expect(shareError.value).toBe('Could not reach server. Are you on VPN?')
  })

  it('sets shareError with fallback when error response is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      json: () => Promise.reject(new Error('not json')),
    }))

    const { fetchGithub, shareError } = useShare()
    const result = await fetchGithub('https://github.com/owner/repo/blob/main/README.md')

    expect(result).toBeNull()
    expect(shareError.value).toBe('Server error (502)')
  })
})
