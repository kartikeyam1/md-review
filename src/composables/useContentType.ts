import type { ContentType } from '@/types'

// A real HTML *document* starts with a doctype or one of the root structural
// tags. Inline HTML sprinkled inside markdown (e.g. a stray <br> or <img>) does
// NOT match — markdown normally starts with a heading, list, or prose — so this
// sniff stays conservative and won't misclassify markdown as HTML.
const HTML_SNIFF_RE = /^﻿?\s*(?:<!doctype\s+html|<html[\s>]|<head[\s>]|<body[\s>])/i

export function isHtmlFilename(filename: string): boolean {
  return /\.html?$/i.test((filename || '').trim())
}

export function isMarkdownishFilename(filename: string): boolean {
  return /\.(md|markdown|txt)$/i.test((filename || '').trim())
}

export function looksLikeHtml(content: string): boolean {
  return HTML_SNIFF_RE.test(content || '')
}

/**
 * Decide whether a document should be treated as HTML or Markdown.
 *
 * Filename extension is the primary signal (.html/.htm → html). When the name
 * is ambiguous (pasted content named `pasted.md`, a `.txt`, or no extension)
 * we sniff the body for a document-level HTML structure.
 */
export function detectContentType(filename: string, content = ''): ContentType {
  if (isHtmlFilename(filename)) return 'html'
  return looksLikeHtml(content) ? 'html' : 'markdown'
}

/** Suggest a sensible default filename for pasted/blank content of a given type. */
export function defaultFilename(type: ContentType): string {
  return type === 'html' ? 'pasted.html' : 'pasted.md'
}
