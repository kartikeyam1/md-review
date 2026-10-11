// Item #27 — template variable substitution (pure module server/template-vars.cjs): AC-27.3, AC-27.5
// and the spec's variable edge cases. Spec: docs/build/specs/27-templates.md rules 4–8.
// Unit level: the clock is injected (`now`), so date/week/timezone cases are exact.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const tv = require('../template-vars.cjs');

const NOW = Date.parse('2026-10-10T20:00:00Z');
const render = (content, opts = {}, contentType = 'markdown') =>
  tv.renderTemplate({ content, contentType }, { now: NOW, ...opts });

describe('#27 variables list (rule 8)', () => {
  test('sorted, de-duplicated names; escaped ones and invalid names excluded', () => {
    const c = '{{title}} {{ date }} {{date}} \\{{escaped}} {{author}} {{1abc}} {{ }} {{week}} A{{Decide}} {{title}';
    assert.deepEqual(tv.listVariables(c), ['Decide', 'author', 'date', 'title', 'week']);
  });
  test('the weekly-update skeleton uses author, date, title, week', () => {
    assert.deepEqual(tv.listVariables('# {{title}}\n\n**Week {{week}}** · {{author}} · {{date}}\n'), ['author', 'date', 'title', 'week']);
  });
  test('empty / non-string content → []', () => {
    assert.deepEqual(tv.listVariables(''), []);
    assert.deepEqual(tv.listVariables(undefined), []);
  });
});

describe('#27 substitution (rules 4–7)', () => {
  test('AC-27.3 unknown stays, \\{{date}} → literal {{date}}, {{ date }} → today, {{author}} verbatim without author', () => {
    const out = render('a {{unknown}} b \\{{date}} c {{ date }} d {{author}}', { timezone: 'UTC' });
    assert.equal(out, 'a {{unknown}} b {{date}} c 2026-10-10 d {{author}}');
  });

  test('AC-27.5 variables override built-ins and are single-pass: title "{{date}}" stays literal', () => {
    const out = render('# {{title}}\n{{date}}', { title: 'Real', variables: { title: '{{date}}' } });
    assert.equal(out, '# {{date}}\n2026-10-10');
  });

  test('built-ins: title, date, week, author, collection', () => {
    const out = render('{{title}}|{{date}}|{{week}}|{{author}}|{{collection}}', { title: 'T', author: 'Asha', collection: 'Ops' });
    assert.equal(out, 'T|2026-10-10|2026-W41|Asha|Ops');
  });

  test('no author / no collection / empty author → placeholders stay', () => {
    assert.equal(render('{{author}} {{collection}}', { title: 'x', author: '   ' }), '{{author}} {{collection}}');
  });

  test('names are case-sensitive', () => {
    assert.equal(render('{{Title}} {{title}}', { title: 'x' }), '{{Title}} x');
  });

  test('custom variables fill unknown names; non-matching names untouched', () => {
    assert.equal(render('{{sprint}} {{team_1}} {{other}}', { variables: { sprint: '42', team_1: 'core' } }), '42 core {{other}}');
  });

  test('applies everywhere, code blocks included', () => {
    const out = render('```\n{{title}}\n```\n`{{title}}`', { title: 'X' });
    assert.equal(out, '```\nX\n```\n`X`');
  });

  test('edge: split across lines, nested braces, unclosed, empty, digit-first, mermaid hexagon', () => {
    const src = [
      '{{\ntitle}}', '{{title\n}}', '{{ti\ntle}}', // split across lines: unchanged
      '{{{title}}}', // nested: only the inner valid placeholder changes
      '{{title}', '{title}}', // unclosed
      '{{ }}', '{{}}', '{{1abc}}', '{{a-b}}',
      'graph TD; A{{Decide}} --> B{{title}}', // mermaid: unknown name stays, known name changes
    ].join('\n');
    const out = render(src, { title: 'T' });
    assert.equal(out, [
      '{{\ntitle}}', '{{title\n}}', '{{ti\ntle}}',
      '{T}',
      '{{title}', '{title}}',
      '{{ }}', '{{}}', '{{1abc}}', '{{a-b}}',
      'graph TD; A{{Decide}} --> BT',
    ].join('\n'));
  });

  test('tabs/spaces inside braces are allowed', () => {
    assert.equal(render('{{\ttitle  }}', { title: 'T' }), 'T');
  });

  test('$&, $1, $$, backslashes and regex specials are inserted literally', () => {
    const title = "$& $1 $$ $` $' \\ \\1 .*+?^()[]{}|";
    assert.equal(render('<{{title}}>', { title }), `<${title}>`);
    assert.equal(render('{{x}}', { variables: { x: '$&$&' } }), '$&$&');
  });

  test('escaped placeholder with an unknown name also becomes literal', () => {
    assert.equal(render('\\{{nope}} \\{{ title }}', { title: 'T' }), '{{nope}} {{ title }}');
  });

  test('html: values are escaped (& < > " \'), markdown: inserted as-is', () => {
    const t = `<script>x</script> & "q" 'a'`;
    assert.equal(render('<h1>{{title}}</h1>', { title: t }, 'html'), '<h1>&lt;script&gt;x&lt;/script&gt; &amp; &quot;q&quot; &#39;a&#39;</h1>');
    assert.equal(render('# {{title}}', { title: t }, 'markdown'), `# ${t}`);
  });

  test('non-string content is treated as empty', () => {
    assert.equal(tv.substitute(undefined, { a: 'x' }), '');
  });
});

describe('#27 date / ISO week by IANA timezone (rule 5)', () => {
  test('AC-27.2 clock: 2026-10-10T20:00Z in Asia/Kolkata → 2026-10-11, 2026-W41', () => {
    assert.deepEqual(tv.dateValues(NOW, 'Asia/Kolkata'), { date: '2026-10-11', week: '2026-W41' });
    assert.deepEqual(tv.dateValues(NOW, 'UTC'), { date: '2026-10-10', week: '2026-W41' });
    assert.deepEqual(tv.dateValues(NOW, 'America/Los_Angeles'), { date: '2026-10-10', week: '2026-W41' });
  });
  test('invalid / absent / non-string timezone → UTC', () => {
    for (const tz of ['Not/AZone', '', undefined, null, 42, {}, 'utc+5']) {
      assert.deepEqual(tv.dateValues(NOW, tz), { date: '2026-10-10', week: '2026-W41' }, String(tz));
    }
  });
  test('year boundaries: 2026-12-31 and 2027-01-01 → 2026-W53', () => {
    assert.equal(tv.dateValues(Date.parse('2026-12-31T12:00:00Z'), 'UTC').week, '2026-W53');
    assert.deepEqual(tv.dateValues(Date.parse('2027-01-01T12:00:00Z'), 'UTC'), { date: '2027-01-01', week: '2026-W53' });
    assert.equal(tv.dateValues(Date.parse('2027-01-04T00:00:00Z'), 'UTC').week, '2027-W01');
    // timezone moves the day across the boundary
    assert.deepEqual(tv.dateValues(Date.parse('2026-12-31T20:00:00Z'), 'Asia/Tokyo'), { date: '2027-01-01', week: '2026-W53' });
  });
  test('more ISO weeks: 2025-12-29 → 2026-W01, 2024-12-30 → 2025-W01, 2021-01-03 → 2020-W53, single-digit padded', () => {
    assert.equal(tv.isoWeek(2025, 12, 29), '2026-W01');
    assert.equal(tv.isoWeek(2024, 12, 30), '2025-W01');
    assert.equal(tv.isoWeek(2021, 1, 3), '2020-W53');
    assert.equal(tv.isoWeek(2026, 2, 2), '2026-W06');
  });
});

describe('#27 custom variables validation (rule 5 limits)', () => {
  test('valid: undefined, null, {}, 20 keys of ≤ 500 chars', () => {
    assert.equal(tv.validateVariables(undefined), null);
    assert.equal(tv.validateVariables(null), null);
    assert.equal(tv.validateVariables({}), null);
    const v = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, 'x'.repeat(500)]));
    assert.equal(tv.validateVariables(v), null);
  });
  test('invalid: > 20 keys, value > 500 chars, non-string value, bad key, array, string', () => {
    const many = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, 'x']));
    for (const bad of [many, { a: 'x'.repeat(501) }, { a: 1 }, { a: null }, { '1a': 'x' }, { 'a-b': 'x' }, ['x'], 'x', 3]) {
      assert.equal(typeof tv.validateVariables(bad), 'string', JSON.stringify(bad));
    }
  });
});
