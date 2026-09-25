const assert = require('node:assert/strict');
const { test } = require('node:test');
const acorn = require('acorn');
const { createApp } = require('./harness.cjs');
const app = createApp();
const review = (source, lang = 'javascript') => app.reviewSource(source, lang);
const matches = (source, pattern, lang) => review(source, lang).issues.filter(issue => pattern.test(issue.title));

test('parenthesized comparisons point to the operator, including DOM values', () => {
  for (const [operand, operator, pattern] of [['userId', '==', /ではなく/], ['input.value', '===', /比較相手/]]) {
    const source = `if ((\n  ${operand}\n)\n${operator} 1) {}`;
    assert.equal(matches(source, pattern)[0].line, 4);
  }
});

test('all multiline and same-line JS class declarations and expressions are checked', () => {
  const source = 'class\nfirst_class {} class second_class {}\nconst User = class inner_class {};';
  assert.deepEqual(Array.from(matches(source, /クラス名/), issue => issue.line), [2, 2, 3]);
  assert.equal(matches('class User {}\nconst name = { class: {} };', /クラス名/).length, 0);
  assert.equal(matches('class', /クラス名/).length, 0);
});

test('multiline class and function naming findings use the declared name line', () => {
  assert.equal(matches('class\nbad_name {}', /クラス名/, 'java')[0].line, 2);
  assert.equal(matches('function\nBadName() {}', /メソッド名/)[0].line, 2);
});

test('incomplete switches retain findings before the unfinished construct', () => {
  for (const tail of ['switch (name)', 'switch (name) {', 'switch (name) { case', 'switch (', 'switch']) {
    const source = `var userName = 1;\n${tail}`;
    assert.equal(review(source).lex.complete, false);
    assert.equal(matches(source, /var は禁止/).length, 1);
  }
});

test('JS parameter defaults cannot see declarations in the function body', () => {
  assert.equal(matches('function run(userName = console.log(message)) { var console = logger; }', /console.log/).length, 1);
  assert.equal(matches('function run(console, userName = console.log(message)) {}', /console.log/).length, 0);
  assert.equal(matches('function run() { var console = logger; console.log(message); }', /console.log/).length, 0);
});

test('the switch discriminant uses its outer lexical environment', () => {
  assert.equal(matches('switch (console.log(message)) { case 1: let console; console.log(message); }', /console.log/).length, 1);
});

test('optional DOM value comparisons are checked without flagging ordinary objects', () => {
  assert.equal(matches('if (input?.value === 1) {}', /比較相手/).length, 1);
  assert.equal(matches('const input = { value: 1 }; if (input?.value === 1) {}', /比較相手/).length, 0);
  assert.equal(matches('if (input?.value === void 0) {}', /比較相手/).length, 0);
});

test('delete and sequence expressions infer their actual result types', () => {
  for (const source of ['const removed = delete profile.name;', 'const active = (save(), true);']) assert.equal(matches(source, /Boolean変数/).length, 1);
  assert.equal(matches('const pending = void true;', /Boolean変数/).length, 0);
});

test('shared conditional aliases retain known and unknown types through long chains', () => {
  for (const [initial, count] of [['1', 1], ['externalValue', 0]]) {
    const source = `const level0 = ${initial};\n` + Array.from({ length: 100 }, (_, i) => `const level${i + 1} = ready ? level${i} : level${i};`).join('\n') + '\ninput.value === level100;';
    assert.equal(matches(source, /比較相手/).length, count);
  }
});

test('quote examples preserve escaped directives and literal spellings', () => {
  for (const source of ['"use\\x20strict";', '"use\\u0020strict";', 'const label = "\\x41\\n\\\"\\\\\'";']) {
    const fixed = app.fixExampleForIssue(matches(source, /シングルクォート/)[0], source);
    const parse = value => acorn.parse(value, { ecmaVersion: 'latest' }).body[0];
    const original = parse(source);
    const updated = parse(fixed);
    assert.equal(updated.directive, original.directive);
    assert.equal(updated.expression?.value ?? updated.declarations[0].init.value, original.expression?.value ?? original.declarations[0].init.value);
  }
});

test('spacing suggestions never delete comments between keywords and conditions', () => {
  const source = 'if /* keep reason */(isReady) {}';
  assert.equal(matches(source, /^if の後ろ/).length, 0);
  const issue = { title: 'if の後ろは半角スペース1個にしてください', suggestion: '例: if (...)' };
  assert.equal(app.fixExampleForIssue(issue, source), issue.suggestion);
});

test('function declaration semicolon examples preserve later assigned expressions', () => {
  const source = 'function run() {}; const callback = () => {};';
  const fixed = app.fixExampleForIssue(matches(source, /関数宣言の末尾/)[0], source);
  assert.equal(fixed, 'function run() {} const callback = () => {};');
  assert.equal(matches(fixed, /セミコロン/).length, 0);
});

test('Java array indices do not consume dimensions belonging to nested expressions', () => {
  for (const expression of ['names[indices[0]]', '(names)[indices[0]]', 'getNames()[indices[0]]']) {
    const source = `class Users { String[] getNames(){return null;} boolean matches(String[] names, int[] indices) { return ${expression} == other; } }`;
    assert.equal(matches(source, /Stringの比較/, 'java').length, 1, expression);
  }
  assert.equal(matches('class Users { boolean matches(String[][] names, int[] indices) { return names[indices[0]] == other; } }', /Stringの比較/, 'java').length, 0);
});

test('Java resource scopes do not shadow fields in catch, finally or following code', () => {
  const source = 'class Users { String name; void run() {\ntry (var name = getResource()) { boolean inside = name == other; }\ncatch (Exception error) { boolean caught = name == other; }\nfinally { boolean finished = name == other; }\nboolean after = name == other;\n} }';
  assert.deepEqual(Array.from(matches(source, /Stringの比較/, 'java'), issue => issue.line), [3, 4, 5]);
});

test('Java boxed Boolean naming respects qualification and shadowed type names', () => {
  assert.equal(matches('class Users { java.lang.Boolean active; java.lang.Boolean active() {return true;} }', /Boolean/, 'java').length, 2);
  assert.equal(matches('class Boolean {} class Users { Boolean active; Boolean active() {return null;} }', /Boolean/, 'java').length, 0);
  assert.equal(matches('class Users<Boolean> { Boolean active; Boolean active() {return null;} }', /Boolean/, 'java').length, 0);
});

test('Java method calls on constructed Strings are not themselves String values', () => {
  assert.equal(matches('class Users { boolean matches(int count) { return new String().length() == count; } }', /Stringの比較/, 'java').length, 0);
  assert.equal(matches('class Users { boolean matches(Object other) { return new String() == other; } }', /Stringの比較/, 'java').length, 1);
});

test('Java pattern bindings are visible only in branches where the match is proven', () => {
  for (const [condition, expected] of [['input instanceof String name', [2]], ['!(input instanceof String name)', [3]]]) {
    const source = `class Users { int name; boolean matches(Object input) { if (${condition}) {\nreturn name == other;\n} else { return name == other; } } }`;
    assert.deepEqual(Array.from(matches(source, /Stringの比較/, 'java'), issue => issue.line), expected);
  }
  const source = 'class Users { String name; boolean matches(Object input) { if (input instanceof Integer name) {}\nelse { return name == other; } return false; } }';
  assert.equal(matches(source, /Stringの比較/, 'java')[0].line, 2);
});

test('Java pattern facts follow short circuit conditions and early return guards', () => {
  for (const condition of ['input instanceof String name && name == other', '!(input instanceof String name) || name == other']) {
    assert.equal(matches(`class Users { boolean matches(Object input) { return ${condition}; } }`, /Stringの比較/, 'java').length, 1, condition);
  }
  for (const guard of ['return false;', '{ return false; }', 'throw new IllegalArgumentException();']) {
    const source = `class Users { boolean matches(Object input) { if (!(input instanceof String name)) ${guard}\nreturn name == other; } }`;
    assert.equal(matches(source, /Stringの比較/, 'java')[0].line, 2);
  }
  assert.equal(matches('class Users { int name; boolean matches(Object input) { if (input instanceof String name || isReady) { return name == other; } return false; } }', /Stringの比較/, 'java').length, 0);
});

test('Java loop pattern variables are visible in the body and for update only', () => {
  const source = 'class Users { int name; void run() {\nfor (; input instanceof String name; use(name == other)) {\nboolean inside = name == other;\n}\nboolean after = name == other;\n} }';
  assert.deepEqual(Array.from(matches(source, /Stringの比較/, 'java'), issue => issue.line), [2, 3]);
});
