// Helpers shared by the #5 acceptance tests (05-*.test.mjs). Not a test file:
// scripts/verify.sh only runs *.test.mjs.
//
//   pdfInfo(buffer)  -> { pages, text, uris }
//     A minimal reader for the PDFs Chromium (Skia/PDF) writes from page.pdf():
//     page count from the /Pages tree, the shown text decoded through each
//     font's /ToUnicode CMap (Type0 / Identity-H, 2-byte codes, and simple
//     1-byte fonts), and every link annotation /URI. Text runs are joined
//     without separators, so search for markers with whitespace removed
//     (see `squash`). No dependency: zlib only.
//   squash(s)        -> s without any whitespace
//   pngDataUri(w, h) -> a solid-colour PNG of w×h px as a data: URI
//   luminance(rgb) / contrast(a, b) / parseRgb(css)  WCAG colour maths
//   eventually(fn, { timeout, interval })            retry an assertion

import { inflateSync, deflateSync, crc32 } from 'node:zlib'

// ── PDF ─────────────────────────────────────────────────────────────────────

function readObjects(buf) {
  const s = buf.toString('latin1')
  const objs = new Map()
  const re = /(\d+) 0 obj\b/g
  let m
  while ((m = re.exec(s))) {
    const start = m.index + m[0].length
    const end = s.indexOf('endobj', start)
    if (end < 0) break
    const body = s.slice(start, end)
    const si = body.search(/stream\r?\n/)
    let dict = body
    let stream = null
    if (si >= 0) {
      dict = body.slice(0, si)
      const dataStart = start + si + body.slice(si).match(/^stream\r?\n/)[0].length
      const len = Number((dict.match(/\/Length (\d+)(?! 0 R)/) || [])[1])
      const dataEnd = Number.isFinite(len) ? dataStart + len : s.indexOf('endstream', dataStart)
      let raw = buf.subarray(dataStart, dataEnd)
      if (/\/FlateDecode/.test(dict)) {
        try { raw = inflateSync(raw) } catch { raw = Buffer.alloc(0) }
      }
      stream = raw
    }
    objs.set(Number(m[1]), { dict, stream })
    re.lastIndex = end
  }
  return objs
}

function parseCMap(text) {
  const map = new Map()
  let width = 2
  const hexToCode = (h) => parseInt(h, 16)
  const hexToStr = (h) => {
    let out = ''
    for (let i = 0; i + 4 <= h.length; i += 4) out += String.fromCharCode(parseInt(h.slice(i, i + 4), 16))
    return out
  }
  const range = text.match(/begincodespacerange\s*<([0-9A-Fa-f]+)>/)
  if (range) width = range[1].length / 2
  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const [, src, dst] of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) map.set(hexToCode(src), hexToStr(dst))
  }
  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const [, a, b, rest] of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(<[0-9A-Fa-f]+>|\[[^\]]*\])/g)) {
      const lo = hexToCode(a); const hi = hexToCode(b)
      if (rest.startsWith('[')) {
        const items = [...rest.matchAll(/<([0-9A-Fa-f]+)>/g)].map((x) => hexToStr(x[1]))
        for (let c = lo; c <= hi; c++) map.set(c, items[c - lo] ?? '')
      } else {
        const base = rest.slice(1, -1)
        const first = hexToStr(base)
        const last = first.charCodeAt(first.length - 1)
        for (let c = lo; c <= hi; c++) map.set(c, first.slice(0, -1) + String.fromCharCode(last + (c - lo)))
      }
    }
  }
  return { map, width }
}

export function pdfInfo(buf) {
  const objs = readObjects(Buffer.from(buf))
  const ref = (txt, key) => { const m = txt.match(new RegExp(`/${key} (\\d+) 0 R`)); return m ? Number(m[1]) : null }

  // Fonts: object number -> cmap
  const fonts = new Map()
  for (const [n, o] of objs) {
    if (!/\/Type \/Font\b/.test(o.dict)) continue
    const tu = ref(o.dict, 'ToUnicode')
    const cm = tu != null && objs.get(tu)?.stream ? parseCMap(objs.get(tu).stream.toString('latin1')) : null
    const width = /\/Subtype \/Type0/.test(o.dict) ? 2 : (cm?.width ?? 1)
    fonts.set(n, { map: cm?.map ?? new Map(), width })
  }

  let pages = 0
  for (const o of objs.values()) {
    if (/\/Type \/Pages\b/.test(o.dict) && !/\/Parent /.test(o.dict)) {
      const c = o.dict.match(/\/Count (\d+)/)
      if (c) pages = Math.max(pages, Number(c[1]))
    }
  }
  const pageObjs = [...objs.values()].filter((o) => /\/Type \/Page\b(?!s)/.test(o.dict))
  if (!pages) pages = pageObjs.length

  const resolveDict = (txt, key) => {
    // `/Key << ... >>` inline, or `/Key N 0 R`
    const i = txt.indexOf(`/${key}`)
    if (i < 0) return ''
    const rest = txt.slice(i + key.length + 1).trimStart()
    if (rest.startsWith('<<')) {
      let depth = 0
      for (let j = 0; j < rest.length; j++) {
        if (rest.startsWith('<<', j)) { depth++; j++ } else if (rest.startsWith('>>', j)) { depth--; j++; if (!depth) return rest.slice(0, j + 1) }
      }
      return rest
    }
    const m = rest.match(/^(\d+) 0 R/)
    return m ? (objs.get(Number(m[1]))?.dict ?? '') : ''
  }

  let text = ''
  for (const page of pageObjs) {
    const res = resolveDict(page.dict, 'Resources')
    const fontDict = resolveDict(res, 'Font')
    const fontByName = new Map([...fontDict.matchAll(/\/([^\s/<>[\]]+)\s+(\d+) 0 R/g)].map(([, name, num]) => [name, fonts.get(Number(num))]))
    const contents = []
    const arr = page.dict.match(/\/Contents\s*\[([^\]]*)\]/)
    if (arr) for (const [, n] of arr[1].matchAll(/(\d+) 0 R/g)) contents.push(Number(n))
    else { const c = ref(page.dict, 'Contents'); if (c != null) contents.push(c) }
    for (const c of contents) {
      const cs = objs.get(c)?.stream?.toString('latin1') ?? ''
      let font = null
      for (const t of cs.matchAll(/\/([^\s/<>[\]]+)\s+[-\d.]+\s+Tf|<([0-9A-Fa-f]*)>|\((?:\\.|[^\\)])*\)|\b(ET|T\*|Td|TD)\b/g)) {
        if (t[1] !== undefined) { font = fontByName.get(t[1]) ?? null; continue }
        if (t[3]) { text += '\n'; continue }
        if (t[2] !== undefined) {
          const w = (font?.width ?? 2) * 2
          for (let i = 0; i + w <= t[2].length; i += w) {
            const code = parseInt(t[2].slice(i, i + w), 16)
            text += font?.map.get(code) ?? ''
          }
        } else if (t[0].startsWith('(')) {
          const raw = t[0].slice(1, -1).replace(/\\([()\\])/g, '$1')
          for (const ch of raw) text += font?.map.get(ch.charCodeAt(0)) ?? ch
        }
      }
      text += '\n'
    }
  }
  const uris = [...objs.values()].flatMap((o) => [...o.dict.matchAll(/\/URI \(([^)]*)\)/g)].map((m) => m[1]))
  return { pages, text, uris }
}

export const squash = (s) => String(s).replace(/\s+/g, '')

// ── images ──────────────────────────────────────────────────────────────────

export function pngDataUri(width, height, rgb = [0x3a, 0x7b, 0xd5]) {
  const row = Buffer.alloc(1 + width * 3)
  for (let x = 0; x < width; x++) rgb.forEach((v, i) => { row[1 + x * 3 + i] = v })
  const raw = Buffer.concat(Array.from({ length: height }, () => row))
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data])
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0)
    return Buffer.concat([len, td, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
  return `data:image/png;base64,${png.toString('base64')}`
}

// ── colour ──────────────────────────────────────────────────────────────────

/** 'rgb(1, 2, 3)' / 'rgba(1, 2, 3, 0.5)' / 'color(srgb r g b)' -> [r, g, b, a] (0–255, a 0–1) or null. */
export function parseRgb(css) {
  const s = String(css || '').trim()
  let m = s.match(/^rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/)
  if (m) {
    const a = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4])
    return [Number(m[1]), Number(m[2]), Number(m[3]), a]
  }
  m = s.match(/^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\)$/)
  if (m) return [m[1] * 255, m[2] * 255, m[3] * 255, m[4] === undefined ? 1 : Number(m[4])]
  if (s === 'transparent') return [0, 0, 0, 0]
  if (/^#[0-9a-f]{6}$/i.test(s)) return [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16)).concat(1)
  if (s === 'white') return [255, 255, 255, 1]
  if (s === 'black') return [0, 0, 0, 1]
  return null
}

export function luminance([r, g, b]) {
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}

export function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p)
  return (x + 0.05) / (y + 0.05)
}

// ── misc ────────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export async function eventually(fn, { timeout = 5000, interval = 100 } = {}) {
  const end = Date.now() + timeout
  for (;;) {
    try { return await fn() } catch (e) {
      if (Date.now() > end) throw e
    }
    await sleep(interval)
  }
}
