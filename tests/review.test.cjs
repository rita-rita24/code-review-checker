const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createApp } = require('./harness.cjs');
const app = createApp();
const issues = (source, lang = 'javascript') => app.reviewSource(source, lang).issues;
const matching = (source, pattern, lang) => issues(source, lang).filter(issue => pattern.test(issue.title));

test('snippets refer to actual source lines, including literal backslash-n', () => {
  app.switchLanguage('javascript');
  app.element('codeInput').value = "const greeting = 'hello\\nworld';\nvar userName = 'Ada';";
  app.runReview();
  assert.match(app.element('resultList').innerHTML, /var userName = &#039;Ada&#039;;<\/pre>/);
});

for (const source of [
  'const pattern = /var if(x) { debugger == 1 \\"/;',
  'const pattern = /https?:\\/\\/[^/]+/;\nvar userName = 1;',
  'if (isReady) /var == debugger/.test(text);',
  'const pattern = /[/]{2}var/;'
]) test(`regular expression contents are not code: ${source}`, () => {
  assert.equal(matching(source, /var は禁止/).length, source.includes('\nvar') ? 1 : 0);
  assert.equal(matching(source, /debugger|ではなく|クォート/).length, 0);
});

test('division does not hide subsequent comparisons', () => {
  assert.equal(matching('if (total / count == 2) {}', /ではなく/).length, 1);
});

test('template expressions are reviewed, including nested templates', () => {
  const source = 'const label = `hello ${userId == 1 ? `nested ${otherId != 2}` : name}`;';
  assert.equal(matching(source, /ではなく/).length, 2);
});

test('multiline template contents are not statements or comparisons', () => {
  const source = 'const label = `\ninput.value === 1\nvar text = "hello"\ndebugger;\n`;';
  assert.equal(matching(source, /比較相手|var は禁止|セミコロン|クォート|debugger/).length, 0);
});

test('multiline function calls and object callbacks do not need mid-expression semicolons', () => {
  const source = "const users = [\n  loadUser(1)\n];\nconst names = users.map(user => {\n  return user.name;\n});\nconst makeUser = function namedUser() {\n  return { name: 'Ada' };\n};";
  assert.equal(matching(source, /セミコロン/).length, 0);
});

test('missing semicolons are reported at the end of a multiline statement', () => {
  const found = matching('const user = loadUser(\n  1\n)\nconst name = user.name;', /文末にセミコロン/);
  assert.equal(found.length, 1);
  assert.equal(found[0].line, 3);
});

test('function declarations and expressions have distinct semicolon rules', () => {
  assert.equal(matching('function loadUser() {};', /関数宣言の末尾/).length, 1);
  assert.equal(matching('const loadUser = function namedUser() {};', /関数宣言の末尾/).length, 0);
});

test('reserved word properties are not var or debugger statements', () => {
  assert.equal(matching('const options = { var: 1, debugger: false };\noptions.var = 2;\noptions.debugger;', /var は禁止|debugger が/).length, 0);
});

test('only an actual null literal gets the equality exception', () => {
  assert.equal(matching('if (user == null) {}\nif (null != user) {}', /ではなく/).length, 0);
  assert.equal(matching('if (user == options.null) {}\nif (user == null + 1) {}', /ではなく/).length, 2);
});

test('unknown .value operands are not assumed to be numbers', () => {
  assert.equal(matching("if (input.value === expected || input.value === String(count) || input.value === `1`) {}", /比較相手/).length, 0);
  assert.equal(matching('if (input.value === 1 || 2 !== select.value) {}', /比較相手/).length, 1);
});

test('all variables in a declaration are checked without inferring a ternary string as boolean', () => {
  assert.equal(matching('let userName = 1, bad_name = 2;', /bad_name/).length, 1);
  assert.equal(matching("const label = isReady === true ? 'yes' : 'no';", /Boolean変数/).length, 0);
});

test('abbreviation detection respects camel-case boundaries', () => {
  assert.equal(matching("const msgpack = load();\nconst configuration = load();", /略語/).length, 0);
  assert.equal(matching("const msgText = load();", /略語/).length, 1);
});

test('Java null checks and array identity checks are not String comparisons', () => {
  const source = 'String userName = "Ada";\nif (userName != null) {}\nString[] names = {};\nif (names == otherNames) {}';
  assert.equal(matching(source, /Stringの比較/, 'java').length, 0);
});

test('Java string literal contents cannot trigger String comparisons', () => {
  assert.equal(matching('String userName = "Ada";\nString example = "userName == otherName";', /Stringの比較/, 'java').length, 0);
});

test('Java literal and variable String equality are still detected', () => {
  assert.equal(matching('String userName = "Ada";\nif (userName == "Bob") {}\nif ("Ada" != otherName) {}', /Stringの比較/, 'java').length, 2);
});

test('Java return statements are not variable declarations', () => {
  assert.equal(matching('return result;', /変数名/, 'java').length, 0);
});

test('Java method-local String names do not leak into other methods', () => {
  const source = 'class Users {\n  void first() {\n    String status = "ready";\n  }\n  void second() {\n    int status = 1;\n    if (status == other) {}\n  }\n}';
  assert.equal(matching(source, /Stringの比較/, 'java').length, 0);
});

test('rendered code is escaped and never inserted as HTML', () => {
  app.element('codeInput').value = 'var label = "<img src=x onerror=alert(1)>";';
  app.runReview();
  assert.doesNotMatch(app.element('resultList').innerHTML, /<img|<script/);
  assert.match(app.element('resultList').innerHTML, /&lt;img/);
});

test('clear and language changes cancel pending reviews', () => {
  app.element('codeInput').listeners.input();
  assert.equal(app.timers.size, 1);
  app.element('clearBtn').listeners.click();
  assert.equal(app.timers.size, 0);
  assert.equal(app.element('resultList').innerHTML, '');
});

test('jumping to a result selects that full source line', () => {
  const input = app.element('codeInput');
  input.value = 'first\nsecond\nthird';
  app.jumpToLine(2);
  assert.equal(input.value.slice(input.selectionStart, input.selectionEnd), 'second');
});

test('snippets preserve whitespace inside string literals', () => {
  app.element('codeInput').value = 'var label = "hello  world";';
  app.runReview();
  assert.match(app.element('resultList').innerHTML, /hello  world/);
});

test('quote examples preserve apostrophes, escapes and the literal value', () => {
  const acorn = require('acorn');
  for (const source of ['const label = "it\'s ready";', 'const label = "a\\\\b\\n\\\"c";']) {
    const issue = matching(source, /シングルクォート/)[0];
    const example = app.fixExampleForIssue(issue, source);
    const value = code => acorn.parse(code, { ecmaVersion: 'latest' }).body[0].declarations[0].init.value;
    assert.equal(value(example), value(source));
  }
});

test('equality examples change only the operator, preserving strings and null checks', () => {
  const source = "if (label == 'a == b') {}";
  assert.equal(app.fixExampleForIssue(matching(source, /ではなく/)[0], source), "if (label === 'a == b') {}");
  const nullCheck = 'if (user == null || userId == 1) {}';
  assert.equal(app.fixExampleForIssue(matching(nullCheck, /ではなく/)[0], nullCheck), 'if (user == null || userId === 1) {}');
});

test('var examples remain assignable and do not change string contents', () => {
  const source = "var label = 'var';";
  assert.equal(app.fixExampleForIssue(matching(source, /var は禁止/)[0], source), "let label = 'var';");
});

test('switch case blocks and nested switches have correct indentation', () => {
  const source = 'switch (kind) {\n  case 1: {\n    loadUser();\n    break;\n  }\n  default:\n    switch (state) {\n      case 2:\n        loadUser();\n        break;\n    }\n    break;\n}';
  assert.equal(matching(source, /インデント/).length, 0);
});

test('comment markers and code in escaped Java text blocks stay masked', () => {
  const source = 'String template = """\n  \\""" // TODO var userName = 1;\n  System.out.println("example");\n  """;\nSystem.out.println(template);';
  assert.equal(matching(source, /TODO|System.out.println/, 'java').length, 1);
  assert.equal(matching(source, /System.out.println/, 'java')[0].line, 5);
});

test('Java String parameters are tracked within their method only', () => {
  const source = 'class Users {\n  boolean matches(String userName) {\n    return userName == otherName;\n  }\n  boolean matches(int userName) {\n    return userName == otherId;\n  }\n}';
  const found = matching(source, /Stringの比較/, 'java');
  assert.equal(found.length, 1);
  assert.equal(found[0].line, 3);
});

test('both valid Java modifier orders recognize constants', () => {
  for (const modifiers of ['static final', 'final static']) {
    assert.equal(matching(`${modifiers} int maxRetries = 3;`, /Java定数/, 'java').length, 1);
  }
});

test('same-line Java annotations retain method naming checks', () => {
  assert.equal(matching('@Override public boolean active() { return true; }', /Booleanを返すメソッド/, 'java').length, 1);
  assert.equal(matching('public String [] LoadUsers() { return names; }', /メソッド名.*lowerCamelCase/, 'java').length, 1);
});

test('missing semicolons on assigned blocks retain the existing diagnostic wording', () => {
  for (const source of ['const loadUser = () => {}', 'const users = {}', 'const loadUser = function namedUser() {}']) {
    assert.equal(matching(source, /関数式・アロー関数・オブジェクト代入の末尾にセミコロン/).length, 1);
  }
});

test('CRLF and CR preserve issue line numbers', () => {
  for (const newline of ['\r\n', '\r', '\n']) {
    const source = `const userName = 'Ada';${newline}var userId = 1;`;
    assert.equal(matching(source, /var は禁止/)[0].line, 2);
  }
});

test('Unicode line separators preserve string values and textarea line positions', () => {
  for (const separator of ['\u2028', '\u2029']) {
    const source = `const label = 'hello${separator}world'; const other = "ok";\nvar userId = 1;`;
    assert.equal(matching(source, /var は禁止/)[0].line, 2);
    assert.equal(matching(source, /シングルクォート/)[0].line, 1);
    assert.equal(app.lexSource(source, 'javascript').lines.length, 2);
  }
});

test('unfinished and deeply nested input does not crash the reviewer', () => {
  for (const source of ['const label = "', 'const label = `hello ${', '/* TODO', 'const pattern = /[', '('.repeat(15000)]) {
    assert.doesNotThrow(() => issues(source));
  }
});

test('incomplete literals do not leak into code rules', () => {
  for (const source of ['const label = "var debugger ==', 'const label = `var debugger ==', 'const pattern = /var debugger ==']) {
    assert.equal(matching(source, /var は禁止|debugger が|ではなく/).length, 0);
  }
});

test('line ranges, ordering and deduplication remain valid on representative input', () => {
  for (const lang of ['java', 'javascript']) {
    const source = '/* TODO\n * FIXME\n */\nvar bad_name = "example";\nif(bad_name == 1){\n  debugger;\n}';
    const found = issues(source, lang);
    assert.ok(found.length);
    const keys = found.map(issue => [issue.line, issue.endLine, issue.title].join('|'));
    assert.equal(keys.length, new Set(keys).size);
    for (let index = 0; index < found.length; index++) {
      const issue = found[index];
      assert.ok(issue.line >= 1 && issue.endLine >= issue.line && issue.endLine <= source.split('\n').length);
      assert.ok(['fix', 'warn', 'info'].includes(issue.level));
      if (index) assert.ok(issue.line >= found[index - 1].line);
    }
  }
});

test('ordinary explanatory comments are not treated as commented-out code', () => {
  const source = '// Used for active users.\n// String values are immutable.\n// Let callers decide what to return.';
  for (const lang of ['java', 'javascript']) {
    assert.equal(matching(source, /コメントアウト/, lang).length, 0);
  }
});

test('actual commented code and TODOs are still detected', () => {
  for (const lang of ['java', 'javascript']) {
    const source = '// TODO: remove legacy implementation\n// if (isReady) { loadUser(); }';
    assert.equal(matching(source, /コメントアウト/, lang).length, 1);
    assert.equal(matching(source, /TODO/, lang).length, 1);
  }
});
