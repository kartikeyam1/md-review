import MarkdownIt from 'markdown-it'
// highlight.js core + a curated language set. The default 'highlight.js' entry
// bundles every language (~1 MB minified) into the initial download; the
// languages below cover what shows up in review documents. Unregistered
// languages fall back to plain escaped code.
import hljs from 'highlight.js/lib/core'
import javascript from 'highlight.js/lib/languages/javascript'
import typescript from 'highlight.js/lib/languages/typescript'
import json from 'highlight.js/lib/languages/json'
import bash from 'highlight.js/lib/languages/bash'
import shell from 'highlight.js/lib/languages/shell'
import python from 'highlight.js/lib/languages/python'
import java from 'highlight.js/lib/languages/java'
import kotlin from 'highlight.js/lib/languages/kotlin'
import go from 'highlight.js/lib/languages/go'
import rust from 'highlight.js/lib/languages/rust'
import yaml from 'highlight.js/lib/languages/yaml'
import xml from 'highlight.js/lib/languages/xml'
import css from 'highlight.js/lib/languages/css'
import scss from 'highlight.js/lib/languages/scss'
import sql from 'highlight.js/lib/languages/sql'
import markdown from 'highlight.js/lib/languages/markdown'
import diff from 'highlight.js/lib/languages/diff'
import dockerfile from 'highlight.js/lib/languages/dockerfile'
import ini from 'highlight.js/lib/languages/ini'
import plaintext from 'highlight.js/lib/languages/plaintext'
import c from 'highlight.js/lib/languages/c'
import cpp from 'highlight.js/lib/languages/cpp'
import csharp from 'highlight.js/lib/languages/csharp'
import ruby from 'highlight.js/lib/languages/ruby'
import php from 'highlight.js/lib/languages/php'
import swift from 'highlight.js/lib/languages/swift'
import groovy from 'highlight.js/lib/languages/groovy'
import makefile from 'highlight.js/lib/languages/makefile'
import http from 'highlight.js/lib/languages/http'
import graphql from 'highlight.js/lib/languages/graphql'
import properties from 'highlight.js/lib/languages/properties'
import protobuf from 'highlight.js/lib/languages/protobuf'
import lua from 'highlight.js/lib/languages/lua'
import perl from 'highlight.js/lib/languages/perl'
import r from 'highlight.js/lib/languages/r'
import scala from 'highlight.js/lib/languages/scala'

const LANGUAGES: Record<string, Parameters<typeof hljs.registerLanguage>[1]> = {
  javascript, typescript, json, bash, shell, python, java, kotlin, go, rust, yaml, xml, css, scss,
  sql, markdown, diff, dockerfile, ini, plaintext, c, cpp, csharp, ruby, php, swift, groovy,
  makefile, http, graphql, properties, protobuf, lua, perl, r, scala,
}
for (const [name, def] of Object.entries(LANGUAGES)) hljs.registerLanguage(name, def)
// Common fence names that are not built-in aliases.
hljs.registerAliases(['html', 'vue', 'svelte'], { languageName: 'xml' })
hljs.registerAliases(['jsonc', 'json5'], { languageName: 'json' })
hljs.registerAliases(['gradle'], { languageName: 'groovy' })
hljs.registerAliases(['toml'], { languageName: 'ini' })
hljs.registerAliases(['zsh', 'sh'], { languageName: 'bash' })
hljs.registerAliases(['text', 'txt', 'plain'], { languageName: 'plaintext' })
import taskLists from 'markdown-it-task-lists'

export interface LineMapEntry {
  startLine: number
  endLine: number
  htmlIndex: number
}

function lineAttrs(map: [number, number]): string {
  return ` data-line-start="${map[0]}" data-line-end="${map[1]}"`
}

// Plugin that adds id attributes to headings so TOC anchor links work
function headingAnchorPlugin(md: MarkdownIt) {
  md.core.ruler.push('heading_anchors', (state) => {
    const usedSlugs = new Map<string, number>()
    for (const token of state.tokens) {
      if (token.type === 'heading_open') {
        const inline = state.tokens[state.tokens.indexOf(token) + 1]
        if (inline?.type === 'inline' && inline.content) {
          let slug = inline.content
            .toLowerCase()
            .replace(/<[^>]*>/g, '')
            .replace(/[^\w\s-]/g, '')
            .replace(/\s+/g, '-')
            .replace(/-+/g, '-')
            .replace(/^-|-$/g, '')
          const count = usedSlugs.get(slug) || 0
          usedSlugs.set(slug, count + 1)
          if (count > 0) slug = `${slug}-${count}`
          token.attrSet('id', slug)
        }
      }
    }
  })
}

// Plugin that injects data-line-start/data-line-end into block-level elements
function lineDataPlugin(md: MarkdownIt) {
  // Handle normal block tokens (headings, paragraphs, lists, tables, etc.)
  const originalRender = md.renderer.renderToken.bind(md.renderer)
  md.renderer.renderToken = function (tokens, idx, options) {
    const token = tokens[idx]
    if (token.map && token.nesting === 1) {
      token.attrSet('data-line-start', String(token.map[0]))
      token.attrSet('data-line-end', String(token.map[1]))
    }
    return originalRender(tokens, idx, options)
  }

  // Handle fenced code blocks (``` ... ```) — these bypass renderToken
  const originalFence = md.renderer.rules.fence!
  md.renderer.rules.fence = function (tokens, idx, options, env, slf) {
    const token = tokens[idx]
    const attrs = token.map ? lineAttrs(token.map) : ''

    // Mermaid blocks: render as <div class="mermaid"> with raw content
    if (token.info.trim().toLowerCase() === 'mermaid') {
      const escaped = md.utils.escapeHtml(token.content)
      return `<div${attrs} class="mermaid">${escaped}</div>\n`
    }

    const result = originalFence(tokens, idx, options, env, slf)
    // Inject attrs into the opening <pre> tag
    return result.replace(/^<pre/, `<pre${attrs}`)
  }

  // Handle indented code blocks — these also bypass renderToken
  const originalCodeBlock = md.renderer.rules.code_block!
  md.renderer.rules.code_block = function (tokens, idx, options, env, slf) {
    const token = tokens[idx]
    const attrs = token.map ? lineAttrs(token.map) : ''
    const result = originalCodeBlock(tokens, idx, options, env, slf)
    return result.replace(/^<pre/, `<pre${attrs}`)
  }
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/

function extractFrontmatter(source: string): { body: string; table: string; endLine: number } | null {
  const match = source.match(FRONTMATTER_RE)
  if (!match) return null

  const raw = match[1]
  const endLine = match[0].split('\n').length - 1
  const rows = raw
    .split('\n')
    .map((line) => {
      const idx = line.indexOf(':')
      if (idx === -1) return null
      return { key: line.slice(0, idx).trim(), value: line.slice(idx + 1).trim() }
    })
    .filter(Boolean) as { key: string; value: string }[]

  if (!rows.length) return null

  const escape = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

  const trs = rows
    .map((r) => `<tr><td>${escape(r.key)}</td><td>${escape(r.value)}</td></tr>`)
    .join('\n')
  const table = `<table class="frontmatter" data-line-start="0" data-line-end="${endLine}">
<thead><tr><th>Field</th><th>Value</th></tr></thead>
<tbody>\n${trs}\n</tbody></table>\n`

  return { body: source.slice(match[0].length), table, endLine }
}

export function useMarkdown() {
  const md = new MarkdownIt({
    html: true,
    linkify: true,
    typographer: true,
    highlight(str, lang) {
      if (lang && hljs.getLanguage(lang)) {
        try {
          return hljs.highlight(str, { language: lang }).value
        } catch {
          // fall through to default escaping
        }
      }
      return '' // use default escaping
    },
  })
  md.use(headingAnchorPlugin)
  md.use(lineDataPlugin)
  md.use(taskLists, { enabled: true })

  function renderHtml(source: string): string {
    const fm = extractFrontmatter(source)
    if (fm) {
      return fm.table + md.render(fm.body)
    }
    return md.render(source)
  }

  function getLineMap(source: string): LineMapEntry[] {
    const tokens = md.parse(source, {})
    const entries: LineMapEntry[] = []
    let htmlIndex = 0

    for (const token of tokens) {
      if (token.type.endsWith('_open') && token.map) {
        entries.push({
          startLine: token.map[0],
          endLine: token.map[1],
          htmlIndex: htmlIndex++,
        })
      }
    }

    return entries
  }

  return { renderHtml, getLineMap, md }
}
