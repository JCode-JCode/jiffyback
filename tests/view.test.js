import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileTemplate, escapeHtml } from '../src/view.js';

async function renderStr(source, data = {}) {
  const render = compileTemplate(source);
  return render(data);
}

test('escapeHtml(): escapes &, <, >, ", \' and treats null/undefined as empty string', () => {
  assert.equal(escapeHtml(`<script>alert("x")</script>`), '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
  assert.equal(escapeHtml(`a & b`), 'a &amp; b');
  assert.equal(escapeHtml(`it's`), 'it&#39;s');
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
  assert.equal(escapeHtml(42), '42');
});

test('static text with no tags passes through unchanged', async () => {
  assert.equal(await renderStr('<h1>Hello</h1>'), '<h1>Hello</h1>');
});

test('{{ expr }} interpolates and HTML-escapes by default (XSS protection)', async () => {
  const out = await renderStr('<p>{{ name }}</p>', { name: '<b>Ali</b>' });
  assert.equal(out, '<p>&lt;b&gt;Ali&lt;/b&gt;</p>');
});

test('{{{ expr }}} interpolates raw, unescaped', async () => {
  const out = await renderStr('<p>{{{ html }}}</p>', { html: '<b>Ali</b>' });
  assert.equal(out, '<p><b>Ali</b></p>');
});

test('{{ expr }} supports arbitrary JS expressions, not just bare variable names', async () => {
  const out = await renderStr('{{ user.name.toUpperCase() }}', { user: { name: 'ali' } });
  assert.equal(out, 'ALI');
});

test('{{ expr }} on a missing/null/undefined value renders empty string, not "null"/"undefined"', async () => {
  assert.equal(await renderStr('[{{ missing }}]', {}), '[]');
  assert.equal(await renderStr('[{{ n }}]', { n: null }), '[]');
});

test('{{if}}/{{elseif}}/{{else}}/{{/if}}', async () => {
  const tpl = '{{if score >= 90}}A{{elseif score >= 80}}B{{else}}C{{/if}}';
  assert.equal(await renderStr(tpl, { score: 95 }), 'A');
  assert.equal(await renderStr(tpl, { score: 85 }), 'B');
  assert.equal(await renderStr(tpl, { score: 10 }), 'C');
});

test('{{if}} without else renders nothing when false', async () => {
  assert.equal(await renderStr('a{{if false}}b{{/if}}c', {}), 'ac');
});

test('{{each item in items}} iterates an array', async () => {
  const out = await renderStr('{{each fruit in fruits}}({{fruit}}){{/each}}', { fruits: ['a', 'b', 'c'] });
  assert.equal(out, '(a)(b)(c)');
});

test('{{each item, index in items}} exposes the index', async () => {
  const out = await renderStr('{{each fruit, i in fruits}}{{i}}:{{fruit}} {{/each}}', { fruits: ['a', 'b'] });
  assert.equal(out, '0:a 1:b ');
});

test('{{each}} over a plain object iterates as [key, value] pairs (PHP-style associative foreach)', async () => {
  const out = await renderStr('{{each val, key in obj}}{{key}}={{val}} {{/each}}', { obj: { a: 1, b: 2 } });
  assert.equal(out, 'a=1 b=2 ');
});

test('{{each}} over undefined/null renders nothing rather than throwing', async () => {
  assert.equal(await renderStr('[{{each x in missing}}{{x}}{{/each}}]', {}), '[]');
});

test('nested {{each}} inside {{if}}', async () => {
  const tpl = '{{if show}}{{each n in nums}}{{n}}{{/each}}{{/if}}';
  assert.equal(await renderStr(tpl, { show: true, nums: [1, 2, 3] }), '123');
  assert.equal(await renderStr(tpl, { show: false, nums: [1, 2, 3] }), '');
});

test('{{! comment !}} renders nothing', async () => {
  assert.equal(await renderStr('a{{! this is a comment !}}b', {}), 'ab');
});

test('a data key literally named "data" does not break `with`-based scoping', async () => {
  const out = await renderStr('{{ data }}', { data: 'hello' });
  assert.equal(out, 'hello');
});

test('a missing top-level variable renders as empty string, not a ReferenceError (regression test)', async () => {
  assert.equal(await renderStr('[{{ totallyUnset }}]', {}), '[]');
  assert.equal(await renderStr('[{{each x in totallyUnset}}{{x}}{{/each}}]', {}), '[]');
});

test('global built-ins (Math, JSON, Date, ...) are usable inside {{ }} expressions', async () => {
  assert.equal(await renderStr('{{ Math.max(1, 2, 3) }}', {}), '3');
  assert.equal(await renderStr('{{{ JSON.stringify({a:1}) }}}', {}), '{"a":1}');
});

test(
  'engine-internal names (__out, __esc, __include, __yield, __data) are reserved and cannot be used as data keys',
  async () => {
    const out = await renderStr('{{ __out }}-{{ real }}', { __out: 'should not be reachable', real: 'ok' });
    assert.doesNotMatch(out, /should not be reachable/);
    assert.match(out, /ok$/);
  }
);

test('unclosed {{ tag is a clear compile-time error', () => {
  assert.throws(() => compileTemplate('<p>{{ name'), /unclosed/);
});

test('unclosed {{{ raw tag is a clear compile-time error', () => {
  assert.throws(() => compileTemplate('<p>{{{ name }}'), /unclosed/);
});

test('{{elseif}}/{{else}}/{{/if}} without a matching {{if}} is a clear compile-time error', () => {
  assert.throws(() => compileTemplate('{{/if}}'), /without a matching/);
  assert.throws(() => compileTemplate('{{else}}{{/if}}'), /without a matching/);
});

test('{{/each}} without a matching {{each}} is a clear compile-time error', () => {
  assert.throws(() => compileTemplate('{{/each}}'), /without a matching/);
});

test('an unclosed {{if}} block is a clear compile-time error', () => {
  assert.throws(() => compileTemplate('{{if true}}x'), /unclosed.*\{\{if\}\}/);
});

test('an unclosed {{each}} block is a clear compile-time error', () => {
  assert.throws(() => compileTemplate('{{each x in xs}}x'), /unclosed.*\{\{each\}\}/);
});

test('a JS syntax error inside {{ }} is reported clearly, naming the file', () => {
  assert.throws(() => compileTemplate('{{ a + }}', { filename: 'broken.html' }), /broken\.html.*invalid JavaScript/s);
});

test('{{include}} without a view engine (compileTemplate used directly) throws a helpful error', async () => {
  const render = compileTemplate('{{include "partial"}}', { filename: 'x.html' });
  await assert.rejects(() => render({}), /no include handler was provided/);
});

test('{{yield}} with no layout content renders empty string', async () => {
  assert.equal(await renderStr('before{{yield}}after', {}), 'beforeafter');
});
