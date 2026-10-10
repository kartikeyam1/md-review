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
import { tableScroll } from '@/markdown/tableScroll'
import { autolink } from '@/markdown/autolink'
import { parseFrontMatter, frontMatterTable, bodyWithAbsoluteLines } from '@/markdown/frontMatter'

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
  // Markdown plugins (00 §4.4): one file each under src/markdown/, registered here.
  const PLUGINS: ((md: MarkdownIt) => void)[] = [
    headingAnchorPlugin,
    lineDataPlugin,
    (m) => m.use(taskLists, { enabled: true }),
    tableScroll, // #5 rule 5
    autolink, // #5 rule 15
  ]
  for (const plugin of PLUGINS) plugin(md)

  // Front matter renders as a table; the body keeps absolute line numbers (#5 rule 20).
  function renderHtml(source: string): string {
    const fm = parseFrontMatter(source)
    if (fm) return frontMatterTable(fm) + md.render(bodyWithAbsoluteLines(fm))
    return md.render(source)
  }

  function getLineMap(source: string): LineMapEntry[] {
    const fm = parseFrontMatter(source)
    const tokens = md.parse(fm ? bodyWithAbsoluteLines(fm) : source, {})
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
