// #10 Paste / drop image → attachment — unit tests for the pure helpers
// (docs/build/specs/10-paste-image.md rules 3–8, 10).
//
// Contract fixed by this test:
//   module  src/composables/attachments.ts   (no CodeMirror import — 00 §4.7)
//   exports MAX_IMAGE_BYTES (10 MiB), MAX_IMAGES (10)
//           isImageFile({name,type})       image/* type, or (no type) an image extension
//           imageExtension({name,type})    accepted ext (png/jpg/gif/webp/svg) or null; jpeg → jpg
//           altFromName(name)              rule 7
//           assetName(ext, date, hex)      rule 5: assets/YYYYMMDD-HHMMSS-<6 hex>.<ext> (local time)
//           attachmentUrl(api, id, name, origin)   rule 6 (absolute)
//           placeholderText(alt)           rule 8: ![Uploading <alt>…]()
//           imageMarkup(alt, url, contentType)     rule 10
import { describe, it, expect } from 'vitest'
import {
  MAX_IMAGE_BYTES, MAX_IMAGES, isImageFile, imageExtension, altFromName, assetName, attachmentUrl,
  placeholderText, imageMarkup,
} from '@/composables/attachments'

const f = (name: string, type = '') => ({ name, type })

describe('#10 limits', () => {
  it('10 MiB per image, 10 images per paste/drop (rule 4)', () => {
    expect(MAX_IMAGE_BYTES).toBe(10_485_760)
    expect(MAX_IMAGES).toBe(10)
  })
})

describe('#10 accepted types (rule 3)', () => {
  it('maps the five accepted MIME types, jpeg → jpg', () => {
    expect(imageExtension(f('a.png', 'image/png'))).toBe('png')
    expect(imageExtension(f('a.jpeg', 'image/jpeg'))).toBe('jpg')
    expect(imageExtension(f('a', 'image/jpeg'))).toBe('jpg')
    expect(imageExtension(f('a.gif', 'image/gif'))).toBe('gif')
    expect(imageExtension(f('a.webp', 'image/webp'))).toBe('webp')
    expect(imageExtension(f('a.svg', 'image/svg+xml'))).toBe('svg')
  })
  it('falls back to the extension only when File.type is empty', () => {
    expect(imageExtension(f('Shot.PNG'))).toBe('png')
    expect(imageExtension(f('x.jpeg'))).toBe('jpg')
    expect(imageExtension(f('x.JPG'))).toBe('jpg')
    expect(imageExtension(f('x.svg'))).toBe('svg')
    expect(imageExtension(f('noext'))).toBeNull()
    // A declared type wins over the name.
    expect(imageExtension(f('x.png', 'image/bmp'))).toBeNull()
  })
  it('rejects other image types (bmp, tiff, heic)', () => {
    expect(imageExtension(f('a.bmp', 'image/bmp'))).toBeNull()
    expect(imageExtension(f('a.tiff', 'image/tiff'))).toBeNull()
    expect(imageExtension(f('a.heic', 'image/heic'))).toBeNull()
    expect(imageExtension(f('a.bmp'))).toBeNull()
  })
  it('isImageFile: any image/* type, or an image extension with no type; never text/pdf', () => {
    expect(isImageFile(f('a.bmp', 'image/bmp'))).toBe(true)
    expect(isImageFile(f('a.png', 'image/png'))).toBe(true)
    expect(isImageFile(f('a.png'))).toBe(true)
    expect(isImageFile(f('a.bmp'))).toBe(true)
    expect(isImageFile(f('a.txt', 'text/plain'))).toBe(false)
    expect(isImageFile(f('a.pdf', 'application/pdf'))).toBe(false)
    expect(isImageFile(f('noext'))).toBe(false)
  })
})

describe('#10 alt text (rule 7)', () => {
  it('drops the extension, brackets and backslashes, collapses whitespace', () => {
    expect(altFromName('shot.png')).toBe('shot')
    expect(altFromName('image.png')).toBe('image')
    expect(altFromName('my [best]\\ shot  (v2).final.jpeg')).toBe('my best shot (v2).final')
    expect(altFromName('  spaced\tout\n name .gif')).toBe('spaced out name')
    expect(altFromName('🦊 fox.webp')).toBe('🦊 fox')
  })
  it('empty → image', () => {
    expect(altFromName('.png')).toBe('image')
    expect(altFromName('[].png')).toBe('image')
    expect(altFromName('')).toBe('image')
  })
  it('a name without an extension is kept whole', () => {
    expect(altFromName('screenshot')).toBe('screenshot')
  })
})

describe('#10 stored name (rule 5)', () => {
  it('assets/<YYYYMMDD>-<HHMMSS>-<6 hex>.<ext> in local time', () => {
    const d = new Date(2026, 9, 10, 14, 22, 33) // local time
    expect(assetName('png', d, 'a1b2c3')).toBe('assets/20261010-142233-a1b2c3.png')
    expect(assetName('jpg', new Date(2026, 0, 2, 3, 4, 5), '00ff00')).toBe('assets/20260102-030405-00ff00.jpg')
  })
  it('generates 6 lowercase hex chars when none is given', () => {
    const n = assetName('gif')
    expect(n).toMatch(/^assets\/\d{8}-\d{6}-[0-9a-f]{6}\.gif$/)
    const names = new Set(Array.from({ length: 50 }, () => assetName('png')))
    expect(names.size).toBeGreaterThan(45)
  })
})

describe('#10 URL and markup (rules 6, 8, 10)', () => {
  it('absolute URL on the API origin, or the page origin when the API base is empty', () => {
    expect(attachmentUrl('https://api.example', 'ab12', 'assets/x.png', 'https://app.example'))
      .toBe('https://api.example/paste/ab12/files/assets/x.png')
    expect(attachmentUrl('', 'ab12', 'assets/x.png', 'http://localhost:5173'))
      .toBe('http://localhost:5173/paste/ab12/files/assets/x.png')
    expect(attachmentUrl('https://api.example/', 'ab12', 'assets/x.png', 'https://app.example'))
      .toBe('https://api.example/paste/ab12/files/assets/x.png')
  })
  it('placeholder uses the U+2026 ellipsis', () => {
    expect(placeholderText('shot')).toBe('![Uploading shot…]()')
  })
  it('markdown image for markdown docs, <img> for html docs', () => {
    expect(imageMarkup('shot', 'https://a/x.png', 'markdown')).toBe('![shot](https://a/x.png)')
    expect(imageMarkup('shot', 'https://a/x.png', 'html')).toBe('<img src="https://a/x.png" alt="shot">')
    expect(imageMarkup('say "hi" & <b>', 'https://a/x.png', 'html')).toBe('<img src="https://a/x.png" alt="say &quot;hi&quot; &amp; &lt;b&gt;">')
  })
})
