// #11 Format a pasted table — unit tests for the pure table functions
// (docs/build/specs/11-table-paste.md rules 2–7, 12–14; AC-11.1, .4, .5, .6, .7, .10, .11, .12, .15).
//
// Contract fixed by this test:
//   module  src/editor/tablePaste.ts
//   exports parseDelimited(text, delimiter) → string[][] | null   RFC 4180 quoting; null when a quote is left open
//           detectTable(text) → { rows: string[][], delimiter: '\t' | ',' } | null   rules 2–3
//           toMarkdownTable(rows) → string                          rules 4–7 (no trailing newline)
//           formatMarkdownTable(lines) → string                     rules 12–13 (lines joined with \n)
import { describe, it, expect } from 'vitest'
import { parseDelimited, detectTable, toMarkdownTable, formatMarkdownTable } from '@/editor/tablePaste'

const table = (text: string) => {
  const t = detectTable(text)
  expect(t, `a table: ${JSON.stringify(text)}`).not.toBeNull()
  return toMarkdownTable(t!.rows)
}

describe('#11 parseDelimited (rule 2)', () => {
  it('splits records and fields; RFC 4180 quotes may hold the delimiter, newlines and "" for a quote', () => {
    expect(parseDelimited('a\tb\nc\td', '\t')).toEqual([['a', 'b'], ['c', 'd']])
    expect(parseDelimited('id,name\n1,"Smith, J"\n2,"said ""hi"""', ',')).toEqual([['id', 'name'], ['1', 'Smith, J'], ['2', 'said "hi"']])
    expect(parseDelimited('a\tb\n"line1\nline2"\tx', '\t')).toEqual([['a', 'b'], ['line1\nline2', 'x']])
  })
  it('strips one trailing newline and normalises \\r\\n', () => {
    expect(parseDelimited('a\tb\r\nc\td\r\n', '\t')).toEqual([['a', 'b'], ['c', 'd']])
    expect(parseDelimited('a\tb\nc\td\n\n', '\t')).toEqual([['a', 'b'], ['c', 'd'], ['']])
  })
  it('keeps empty trailing fields (Sheets copies trailing empty columns)', () => {
    expect(parseDelimited('a\tb\t\nc\td\t', '\t')).toEqual([['a', 'b', ''], ['c', 'd', '']])
  })
  it('a quote inside an unquoted field is literal; an unterminated quoted field → null', () => {
    expect(parseDelimited('5" screen,x\ny,z', ',')).toEqual([['5" screen', 'x'], ['y', 'z']])
    expect(parseDelimited('"open,x\ny,z', ',')).toBeNull()
  })
})

describe('#11 detectTable (rule 3)', () => {
  it('TSV: ≥2 records with the same field count ≥2', () => {
    expect(detectTable('Name\tQty\nApple\t3\nPear\t12')).toEqual({ delimiter: '\t', rows: [['Name', 'Qty'], ['Apple', '3'], ['Pear', '12']] })
    expect(detectTable('a\tb\nc\td')?.delimiter).toBe('\t')
  })
  it('AC-11.6 a TSV whose 2nd record has a different field count is not a table', () => {
    expect(detectTable('a\tb\tc\nd\te\nf\tg\th')).toBeNull()
  })
  it('a single row or a single column is not a table', () => {
    expect(detectTable('a\tb\tc')).toBeNull()
    expect(detectTable('a\nb\nc')).toBeNull()
    expect(detectTable('')).toBeNull()
  })
  it('AC-11.5 a 2×2 comma pair of sentences is not a table', () => {
    expect(detectTable('Hello, world\nGoodbye, moon')).toBeNull()
  })
  it('CSV needs ≥3 fields or ≥3 records', () => {
    expect(detectTable('a,b,c\nd,e,f')?.delimiter).toBe(',')
    expect(detectTable('a,b\nc,d\ne,f')?.delimiter).toBe(',')
    expect(detectTable('a,b\nc,d')).toBeNull()
  })
  it('CSV is refused when a record starts with a markdown block marker', () => {
    for (const marker of ['# h', '> q', '- item', '* item', '+ item', '| x', '`code', '1. one']) {
      expect(detectTable(`${marker},b,c\nd,e,f\ng,h,i`), marker).toBeNull()
    }
    expect(detectTable('a,b,c\n2. two,e,f\ng,h,i')).toBeNull()
  })
  it('AC-11.4 the quoted CSV example is a 3-column table', () => {
    const t = detectTable('id,name,note\n1,"Smith, J","said ""hi"""\n2,Lee,a|b')
    expect(t?.rows).toEqual([['id', 'name', 'note'], ['1', 'Smith, J', 'said "hi"'], ['2', 'Lee', 'a|b']])
  })
  it('Windows line endings and a trailing newline are fine', () => {
    expect(detectTable('a\tb\r\nc\td\r\n')?.rows).toEqual([['a', 'b'], ['c', 'd']])
  })
})

describe('#11 toMarkdownTable (rules 4–7)', () => {
  it('AC-11.1 the exact GFM output, numeric column right-aligned', () => {
    expect(table('Name\tQty\nApple\t3\nPear\t12')).toBe('| Name  | Qty |\n| ----- | --: |\n| Apple |   3 |\n| Pear  |  12 |')
  })
  it('AC-11.4 delimiters inside quotes stay in the cell; unescaped | → \\|; "" → "', () => {
    const out = table('id,name,note\n1,"Smith, J","said ""hi"""\n2,Lee,a|b').split('\n')
    expect(out[2]).toContain('| Smith, J |')
    expect(out[2]).toContain('said "hi"')
    expect(out[3]).toContain('a\\|b')
    expect(out[0].split(/(?<!\\)\|/).length - 2).toBe(3)
  })
  it('a backslash already before | is kept (no double escape); a cell that is just | becomes \\|', () => {
    const out = table('a\tb\nx\\|y\t|').split('\n')
    expect(out[2]).toBe('| x\\|y | \\|  |')
  })
  it('AC-11.7 a quoted cell with a newline becomes line1<br>line2', () => {
    const out = table('a\tb\n"line1\nline2"\tx')
    expect(out.split('\n')[2]).toBe('| line1<br>line2 | x   |')
  })
  it('cells are trimmed; empty stays empty; min width 3', () => {
    expect(table(' a \t b\n  \tc')).toBe('| a   | b   |\n| --- | --- |\n|     | c   |')
  })
  it('AC-11.10 $1,200 / 15% / -3.5 / empty → right-aligned; a column with 12a is not', () => {
    const out = table('amt\tcode\n$1,200\t12a\n15%\t3\n-3.5\t4\n\t5').split('\n')
    const delim = out[1].split('|').map((s) => s.trim()).filter(Boolean)
    expect(delim[0].endsWith(':')).toBe(true)
    expect(delim[1].endsWith(':')).toBe(false)
    expect(out[2]).toMatch(/^\| \$1,200 \|/)
    expect(out[3]).toMatch(/^\|    15% \|/)
    expect(out[5]).toMatch(/^\|        \|/)
  })
  it('numeric needs at least one non-empty body cell; other currency/sign forms', () => {
    const allEmpty = table('h\tk\n\tx\n\ty').split('\n')[1]
    expect(allEmpty).toBe('| --- | --- |')
    const money = table('p\tq\n€5\t+1\n£1,000.50\t₹7').split('\n')[1]
    expect(money).toBe('| --------: | --: |')
  })
  it('AC-11.11 a cell over 40 chars: the column is 40 wide, others padded to 40, the long cell unpadded', () => {
    const long = 'x'.repeat(55)
    const out = table(`h\tk\n${long}\t1\nshort\t2`).split('\n')
    expect(out[0]).toBe(`| h${' '.repeat(39)} |   k |`)
    expect(out[1]).toBe(`| ${'-'.repeat(40)} | --: |`)
    expect(out[2]).toBe(`| ${long} |   1 |`)
    expect(out[3]).toBe(`| short${' '.repeat(35)} |   2 |`)
  })
  it('widths count code points (emoji = 1)', () => {
    expect(table('🦊🦊🦊🦊\tb\nx\ty').split('\n')[2]).toBe('| x    | y   |')
  })
})

describe('#11 formatMarkdownTable (rules 12–13)', () => {
  it('AC-11.12 the ragged table: column count = max, markers kept, new column ---', () => {
    expect(formatMarkdownTable(['|a|b|', '|:-|-:|', '|long cell|1|2|']))
      .toBe('| a         |   b |     |\n| :-------- | --: | --- |\n| long cell |   1 | 2   |')
  })
  it('centre alignment splits padding, the extra space on the right', () => {
    expect(formatMarkdownTable(['| h | x |', '|:-:|---|', '| ab | y |']))
      .toBe('|  h  | x   |\n| :-: | --- |\n| ab  | y   |')
    expect(formatMarkdownTable(['|wide|', '|:--:|', '|a|'])).toBe('| wide |\n| :--: |\n|  a   |')
  })
  it('AC-11.15 an escaped pipe in code is preserved byte-for-byte and adds no column', () => {
    const out = formatMarkdownTable(['| a | b |', '|---|---|', '| `x\\|y` | z |']).split('\n')
    expect(out[2]).toBe('| `x\\|y` | z   |')
    expect(out[0].split(/(?<!\\)\|/).length - 2).toBe(2)
  })
  it('an already formatted table formats to itself', () => {
    const t = ['| Name  | Qty |', '| ----- | --: |', '| Apple |   3 |', '| Pear  |  12 |']
    expect(formatMarkdownTable(t)).toBe(t.join('\n'))
  })
  it('no numeric detection and no re-escaping in the command; rows without a trailing pipe', () => {
    expect(formatMarkdownTable(['| n | v', '|---|---', '| 1 | 22'])).toBe('| n   | v   |\n| --- | --- |\n| 1   | 22  |')
  })
  it('keeps the first row\'s indentation on every row', () => {
    expect(formatMarkdownTable(['  |a|b|', '  |-|-|', '  |c|d|'])).toBe('  | a   | b   |\n  | --- | --- |\n  | c   | d   |')
  })
})
