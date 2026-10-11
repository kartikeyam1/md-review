// #14 Copy button + language label — unit acceptance tests
// (docs/build/specs/14-code-copy.md rules 1–3, AC-14.3; 00-cross-cutting.md §4.4).
// Renders through the preview's own markdown-it (useMarkdown().renderHtml) and inspects the DOM.
import { describe, it, expect } from 'vitest'
import { useMarkdown } from '@/composables/useMarkdown'

function render(src: string): HTMLElement {
  const div = document.createElement('div')
  div.innerHTML = useMarkdown().renderHtml(src)
  return div
}

const blocks = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>('[data-testid="code-block"]')]
const labelOf = (b: HTMLElement) => b.querySelector('[data-testid="code-lang-label"]')?.textContent ?? null

describe('#14 codeBlock plugin', () => {
  it('rule 1: wraps a fence in code-block > code-toolbar + the original <pre>', () => {
    const root = render('```bash\necho hi\n```\n')
    const [b] = blocks(root)
    expect(b).toBeTruthy()
    expect(b!.classList.contains('code-block')).toBe(true)
    const kids = [...b!.children]
    expect(kids.map((k) => k.getAttribute('data-testid') ?? k.tagName)).toEqual(['code-toolbar', 'PRE'])
    // the wrapper carries no data-line-*; the <pre> keeps its range
    expect([...b!.attributes].some((a) => a.name.startsWith('data-line'))).toBe(false)
    const pre = b!.querySelector('pre')!
    expect(pre.getAttribute('data-line-start')).toBe('0')
    expect(pre.getAttribute('data-line-end')).toBe('3')
    expect(pre.querySelector('code')!.textContent).toBe('echo hi\n')
  })

  it('rule 2: toolbar = label then a native copy button', () => {
    const root = render('```ts\nlet a = 1\n```\n')
    const tb = root.querySelector('[data-testid="code-toolbar"]')!
    const ids = [...tb.querySelectorAll('[data-testid]')].map((e) => e.getAttribute('data-testid'))
    expect(ids).toEqual(['code-lang-label', 'code-copy-btn'])
    const btn = tb.querySelector('[data-testid="code-copy-btn"]') as HTMLButtonElement
    expect(btn.tagName).toBe('BUTTON')
    expect(btn.type).toBe('button')
    expect(btn.getAttribute('aria-label')).toBe('Copy ts code')
    expect(btn.getAttribute('data-state')).toBe('idle')
    expect(btn.textContent!.trim()).toBe('Copy')
  })

  it('AC-14.3 / rule 3: label = first word, lower-cased, {…} stripped; none for bare fences', () => {
    const root = render([
      '```ts', 'a', '```', '',
      '```Terraform', 'b', '```', '',
      '```json {linenos}', 'c', '```', '',
      '```', 'd', '```', '',
      '```TypeScript title="x"', 'e', '```', '',
      '```python{1,3}', 'f', '```', '',
    ].join('\n'))
    const bs = blocks(root)
    expect(bs.map(labelOf)).toEqual(['ts', 'terraform', 'json', null, 'typescript', 'python'])
    expect(bs[3]!.querySelector('[data-testid="code-copy-btn"]')!.getAttribute('aria-label')).toBe('Copy code')
  })

  it('rule 3: label text is escaped', () => {
    const root = render('```<img>\nx\n```\n\n```"><script>alert(1)</script>\ny\n```\n')
    expect(root.querySelector('img')).toBeNull()
    expect(root.querySelector('script')).toBeNull()
    const bs = blocks(root)
    expect(labelOf(bs[0]!)).toBe('<img>')
    expect(labelOf(bs[1]!)).toBe('"><script>alert(1)</script>')
  })

  it('rule 3: indented code blocks get a copy button but no label', () => {
    const root = render('para\n\n    indented code\n')
    const [b] = blocks(root)
    expect(b).toBeTruthy()
    expect(labelOf(b!)).toBeNull()
    expect(b!.querySelector('[data-testid="code-copy-btn"]')).toBeTruthy()
    expect(b!.querySelector('pre')!.getAttribute('data-line-start')).toBe('2')
    expect(b!.querySelector('pre code')!.textContent).toBe('indented code\n')
  })

  it('mermaid fences are untouched (no wrapper, no button)', () => {
    const root = render('```mermaid\ngraph TD\n  A-->B\n```\n')
    expect(blocks(root)).toHaveLength(0)
    const m = root.querySelector('.mermaid')!
    expect(m.getAttribute('data-line-start')).toBe('0')
    expect(m.textContent).toContain('A-->B')
  })

  it('highlighting still applies inside the wrapper; unknown languages are escaped text', () => {
    const root = render('```typescript\nconst a: number = 1\n```\n\n```terraform\nresource "<x>" {}\n```\n')
    const bs = blocks(root)
    expect(bs[0]!.querySelector('pre code span.hljs-keyword')).toBeTruthy()
    expect(bs[1]!.querySelector('pre code')!.textContent).toBe('resource "<x>" {}\n')
  })

  it('a fence inside a list item / blockquote is wrapped too', () => {
    const root = render('- item\n\n  ```sh\n  ls\n  ```\n\n> ```sh\n> pwd\n> ```\n')
    expect(blocks(root)).toHaveLength(2)
  })
})
