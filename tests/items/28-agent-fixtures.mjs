// #28: one fixture table for shared/agentSections.mjs, used by the FE unit test
// (tests/items/28-agent-view.test.ts) and the server test
// (server/test-items/28-agent-view.test.mjs) — FE and server strip identically.
// `sections` = [start, end, label] (0-based inclusive lines); `human` = rule-15 output.

export const AGENT_FIXTURES = [
  {
    name: 'two sections, one labelled',
    src: '# Doc\n\nIntro\n\n<!-- agent -->\nSecret one\n<!-- /agent -->\n\nMiddle\n\n<!-- agent: Raw SQL -->\nSELECT 1;\n<!-- /agent -->\n\nEnd\n',
    sections: [[4, 6, ''], [10, 12, 'Raw SQL']],
    human: '# Doc\n\nIntro\n\nMiddle\n\nEnd\n',
  },
  {
    name: 'uppercase, no inner spaces, up to 3 leading spaces, trailing whitespace',
    src: 'a\n   <!--AGENT-->  \nx\n<!--/Agent-->\t\nb\n',
    sections: [[1, 3, '']],
    human: 'a\nb\n',
  },
  {
    name: 'indented 4 spaces is code, not a marker',
    src: 'a\n\n    <!-- agent -->\n\nb\n',
    sections: [],
    human: 'a\n\n    <!-- agent -->\n\nb\n',
  },
  {
    name: 'marker inside a backtick fence is literal',
    src: '```md\n<!-- agent -->\nshown\n<!-- /agent -->\n```\n\nafter\n',
    sections: [],
    human: '```md\n<!-- agent -->\nshown\n<!-- /agent -->\n```\n\nafter\n',
  },
  {
    name: 'marker inside a tilde fence is literal',
    src: '~~~\n<!-- agent -->\n~~~\n\nafter\n',
    sections: [],
    human: '~~~\n<!-- agent -->\n~~~\n\nafter\n',
  },
  {
    name: 'closer inside a fence within a section does not end it',
    src: 'a\n<!-- agent -->\n```\n<!-- /agent -->\n```\nstill hidden\n<!-- /agent -->\nb\n',
    sections: [[1, 6, '']],
    human: 'a\nb\n',
  },
  {
    name: 'marker inside a list item or blockquote is literal',
    src: '- item\n\n  <!-- agent -->\n  x\n  <!-- /agent -->\n\n> q\n> <!-- agent -->\n',
    sections: [],
    human: '- item\n\n  <!-- agent -->\n  x\n  <!-- /agent -->\n\n> q\n> <!-- agent -->\n',
  },
  {
    name: 'marker after a list at column 0 is top level',
    src: '- item\n<!-- agent -->\nx\n<!-- /agent -->\n',
    sections: [[1, 3, '']],
    human: '- item\n',
  },
  {
    name: 'marker on the same line as text is not a marker',
    src: 'foo <!-- agent -->\nbar\n',
    sections: [],
    human: 'foo <!-- agent -->\nbar\n',
  },
  {
    name: 'opener inside front matter is not a marker',
    src: '---\ntitle: T\nnote: <!-- agent -->\n---\nbody\n',
    sections: [],
    human: '---\ntitle: T\nnote: <!-- agent -->\n---\nbody\n',
  },
  {
    name: 'no nesting: inner opener ignored, first closer ends',
    src: '<!-- agent -->\n<!-- agent: inner -->\na\n<!-- /agent -->\nb\n<!-- /agent -->\n',
    sections: [[0, 3, '']],
    human: 'b\n<!-- /agent -->\n',
  },
  {
    name: 'unclosed opener at line 10 runs to EOF (AC-28.6)',
    src: 'l0\nl1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\n<!-- agent -->\nl11\nl12\n',
    sections: [[10, 12, '']],
    human: 'l0\nl1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\n',
  },
  {
    name: 'stray closer only: unchanged (AC-28.6)',
    src: 'a\n<!-- /agent -->\nb\n',
    sections: [],
    human: 'a\n<!-- /agent -->\nb\n',
  },
  {
    name: 'two adjacent sections',
    src: 'a\n\n<!-- agent -->\nx\n<!-- /agent -->\n<!-- agent: two -->\ny\n<!-- /agent -->\n\nb\n',
    sections: [[2, 4, ''], [5, 7, 'two']],
    human: 'a\n\nb\n',
  },
  {
    name: 'the whole document is one section',
    src: '<!-- agent -->\n# Hidden\n\ntext\n<!-- /agent -->\n',
    sections: [[0, 4, '']],
    human: '',
  },
  {
    name: 'CRLF line endings',
    src: 'a\r\n\r\n<!-- agent -->\r\nh\r\n<!-- /agent -->\r\n\r\nb\r\n',
    sections: [[2, 4, '']],
    human: 'a\r\n\r\nb\r\n',
  },
  {
    name: 'notes markers are kept; label is truncated to 80 chars',
    src: `## A\n<!-- notes -->\nSay hi\n<!-- /notes -->\n<!-- agent: ${'x'.repeat(90)} -->\nz\n<!-- /agent -->\n`,
    sections: [[4, 6, `${'x'.repeat(80)}…`]],
    human: '## A\n<!-- notes -->\nSay hi\n<!-- /notes -->\n',
  },
  {
    name: 'label with markup stays plain text (escaped at render)',
    src: '<!-- agent: <script>alert(1)</script> -->\nq\n<!-- /agent -->\n',
    sections: [[0, 2, '<script>alert(1)</script>']],
    human: '',
  },
  {
    name: 'a one-tag HTML line (CommonMark type 7) swallows the marker line after it',
    src: '<img src="a.png">\n<!-- agent -->\nSECRET\n<!-- /agent -->\n',
    sections: [],
    human: '<img src="a.png">\n<!-- agent -->\nSECRET\n<!-- /agent -->\n',
  },
  {
    name: 'a type-7 tag inside a section hides through EOF (its HTML block holds the closer)',
    src: '<!-- agent -->\n<span>\n<!-- /agent -->\nVISIBLE\n',
    sections: [[0, 3, '']],
    human: '',
  },
  {
    name: 'a one-tag line after paragraph text is a paragraph continuation (type 7 cannot interrupt)',
    src: 'para\n<img src=x>\n<!-- agent -->\ns\n<!-- /agent -->\n',
    sections: [[2, 4, '']],
    human: 'para\n<img src=x>\n',
  },
  {
    name: 'markers inside <?…?>, <!DOCTYPE …> and CDATA blocks are literal',
    src: '<?php\n<!-- agent -->\n?>\n\n<![CDATA[\n<!-- agent -->\n]]>\n',
    sections: [],
    human: '<?php\n<!-- agent -->\n?>\n\n<![CDATA[\n<!-- agent -->\n]]>\n',
  },
]
