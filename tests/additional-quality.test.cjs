const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createApp } = require('./harness.cjs');
const app = createApp();
const jsIssues = source => app.reviewSource(source, 'javascript').issues;
const valueIssues = source => jsIssues(source).filter(issue => issue.title.startsWith('.value'));
const javaIssues = source => {
  const result = app.reviewSource(source, 'java');
  assert.equal(result.lex.complete, true, source);
  return result.issues;
};

test('global object property writes invalidate replaced JavaScript built-ins', () => {
  for (const assignment of [
    "globalThis.Number = () => '1'", "window['Number'] = converter",
    'self.Number = converter', 'global.Number = converter',
    '({ converter: globalThis.Number } = external)',
    'for (globalThis.Number of converters) {}', 'delete globalThis.Number'
  ]) {
    assert.equal(valueIssues(`${assignment}; input.value === Number(1);`).length, 0, assignment);
  }
  assert.equal(jsIssues('globalThis.Boolean = external; const status = Boolean(1);').filter(issue => /Boolean変数/.test(issue.title)).length, 0);
});

test('local global-object names and unrelated property writes preserve known built-ins', () => {
  for (const prefix of [
    'function configure(globalThis) { globalThis.Number = external; }',
    'const window = external; window.Number = external;',
    'globalThis.userName = external;',
    'globalThis = external; globalThis.Number = external;'
  ]) assert.equal(valueIssues(`${prefix} input.value === Number(1);`).length, 1, prefix);
});

test('replaced DOM factories and console methods are not assumed to be native', () => {
  for (const prefix of [
    'document.createElement = factory;',
    "document['createElement'] = factory;",
    'globalThis.document.createElement = factory;',
    '({ factory: document.createElement } = external);',
    'delete document.createElement;'
  ]) assert.equal(valueIssues(`${prefix} document.createElement('input').value === 1;`).length, 0, prefix);
  assert.equal(jsIssues('window.console = external; console.log(message);').filter(issue => /console.log/.test(issue.title)).length, 0);
  assert.equal(jsIssues('console.log = external; console.log(message);').filter(issue => /console.log/.test(issue.title)).length, 0);
  assert.equal(valueIssues("document.title = 'Review'; document.createElement('input').value === 1;").length, 1);
  assert.equal(valueIssues("function configure(document) { document.createElement = factory; } document.createElement('input').value === 1;").length, 1);
  assert.equal(jsIssues('console.warn = external; console.log(message);').filter(issue => /console.log/.test(issue.title)).length, 1);
  assert.equal(valueIssues("const editor = document.createElement('input'); delete editor; editor.value === 1;").length, 1);
});

test('static template property names receive the same checks as ordinary properties', () => {
  assert.equal(valueIssues('input[`value`] === 1;').length, 1);
  assert.equal(valueIssues("document[`createElement`]('input').value === 1;").length, 1);
  assert.equal(jsIssues('console[`log`](message);').filter(issue => /console.log/.test(issue.title)).length, 1);
  assert.equal(valueIssues('input[`value${suffix}`] === 1;').length, 0);
  assert.equal(jsIssues('console[`log${suffix}`](message);').filter(issue => /console.log/.test(issue.title)).length, 0);
});

test('private fields and methods never masquerade as public DOM or console properties', () => {
  assert.equal(valueIssues('class Editor { #value = 1; isReady() { return input.#value === 1; } }').length, 0);
  assert.equal(jsIssues('class Editor { #log() {} read() { console.#log(message); } }').filter(issue => /console.log/.test(issue.title)).length, 0);
  assert.equal(valueIssues("class Editor { #createElement() {} read() { document.#createElement('input').value === 1; } }").length, 0);
});

test('static template writes invalidate APIs while private writes leave public APIs intact', () => {
  assert.equal(valueIssues('globalThis[`Number`] = converter; input.value === Number(1);').length, 0);
  assert.equal(valueIssues("document[`createElement`] = factory; document.createElement('input').value === 1;").length, 0);
  assert.equal(jsIssues('class Editor { #log; read() { console.#log = custom; console.log(message); } }').filter(issue => /console.log/.test(issue.title)).length, 1);
});

test('broad Java catches recognize modifiers, annotations and qualified types', () => {
  for (const type of ['final Exception', 'java.lang.Exception', '@Nullable Exception', '@A(text = ")") final java.lang.Exception']) {
    const source = `class User { void read() { try {}\ncatch (${type} error) { recover(); } } }`;
    assert.deepEqual(Array.from(javaIssues(source).filter(issue => /広く catch/.test(issue.title)), issue => issue.line), [2], type);
  }
});

test('custom Java Exception types do not trigger the standard broad-catch rule', () => {
  for (const declaration of ['class Exception extends RuntimeException {}', 'import example.Exception;']) {
    assert.equal(javaIssues(`${declaration} class User { void read() { try {} catch (Exception error) { recover(); } } }`).filter(issue => /広く catch/.test(issue.title)).length, 0);
  }
  assert.equal(javaIssues('class Exception {} class User { void read() { try {} catch (java.lang.Exception error) { recover(); } } }').filter(issue => /広く catch/.test(issue.title)).length, 1);
});

test('annotated Java catch blocks distinguish empty bodies from handled errors', () => {
  for (const body of ['', '/* explanation */', '// explanation\n']) {
    const source = `class User { void read() { try {}\ncatch (@A(text = ")") Exception error) {${body}} } }`;
    assert.deepEqual(Array.from(javaIssues(source).filter(issue => /空の catch/.test(issue.title)), issue => issue.line), [2]);
  }
  assert.equal(javaIssues('class User { void read() { try {} catch (@A(text = ")") Exception error) { recover(); } } }').filter(issue => /空の catch/.test(issue.title)).length, 0);
});

test('Java debugging calls tolerate whitespace and comments and point at the method', () => {
  const source = 'class User { void read() { System /* keep */\n. out\n. println("hello");\nerror. /* keep */\nprintStackTrace(); } }';
  assert.deepEqual(Array.from(javaIssues(source).filter(issue => /println|printStackTrace/.test(issue.title)), issue => [issue.line, issue.title]), [
    [3, 'System.out.println が残っています'], [5, 'printStackTrace() が残っています']
  ]);
  assert.equal(javaIssues('class User { void read() { java.lang.System /* keep */ . out . println("hello"); } }').filter(issue => /println/.test(issue.title)).length, 1);
});

test('Java debug rules ignore custom System names and unrelated member chains', () => {
  for (const source of [
    'class System { static Printer out; } class User { void read() { System.out.println("hello"); } }',
    'class User { void read(Logger System) { System.out.println("hello"); } }',
    'import example.System; class User { void read() { System.out.println("hello"); } }',
    'class User { void read() { custom.System.out.println("hello"); } }'
  ]) assert.equal(javaIssues(source).filter(issue => /println/.test(issue.title)).length, 0, source);
  assert.equal(javaIssues('class System {} class User { void read() { java.lang.System.out.println("hello"); } }').filter(issue => /println/.test(issue.title)).length, 1);
});

test('nullable Java conditional expressions retain String and array element types', () => {
  for (const initializer of ['ready ? "Ada" : null', 'ready ? null : "Ada"', '(ready ? new String[]{"Ada"} : null)[0]']) {
    const source = `class User { boolean isReady() { var name = ${initializer}; return name == unknown; } }`;
    assert.equal(javaIssues(source).filter(issue => /Stringの比較/.test(issue.title)).length, 1, initializer);
  }
  for (const expression of ['(ready ? "Ada" : null) == null', '(ready ? new String[]{"Ada"} : null) == unknown', '(ready ? new Object() : null) == unknown']) {
    assert.equal(javaIssues(`class User { boolean isReady() { return ${expression}; } }`).filter(issue => /Stringの比較/.test(issue.title)).length, 0, expression);
  }
});

test('result cards expose their existing findings as an accessible description', () => {
  const isolated = createApp();
  isolated.switchLanguage('javascript');
  isolated.element('codeInput').value = 'var bad_name = 1;';
  isolated.runReview();
  const html = isolated.element('resultList').innerHTML;
  assert.match(html, /aria-describedby="line-issues-1"/);
  assert.match(html, /class="line-issues" id="line-issues-1"/);
  assert.match(html, /aria-controls="codeInput"/);
});
