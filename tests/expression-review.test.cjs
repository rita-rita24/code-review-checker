const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createApp } = require('./harness.cjs');
const app = createApp();
const valueIssues = source => app.reviewSource(source, 'javascript').issues.filter(issue => issue.title.startsWith('.value'));
const javaIssues = source => {
  const result = app.reviewSource(source, 'java');
  assert.equal(result.lex.complete, true, source);
  return result.issues;
};
const stringIssues = source => javaIssues(source).filter(issue => issue.title.startsWith('Stringの比較'));

test('JS assignment expressions carry the assigned value type', () => {
  for (const expression of ['choice = 1', 'choice = true', 'choice = {}', 'choice = 1n']) {
    assert.equal(valueIssues(`let choice; input.value === (${expression});`).length, 1, expression);
  }
  for (const expression of ["choice = '1'", 'choice = external', 'choice ||= 1', 'choice &&= 1', 'choice ??= 1']) {
    assert.equal(valueIssues(`let choice; input.value === (${expression});`).length, 0, expression);
  }
  assert.equal(app.reviewSource('let choice; const status = (choice = true);', 'javascript').issues.filter(issue => /Boolean変数「status」/.test(issue.title)).length, 1);
});

test('JS updates and arithmetic compound assignments produce numeric values', () => {
  for (const expression of ['++choice', 'choice++', '--choice', 'choice--', 'choice -= 1', 'choice *= 2', 'choice **= 2', 'choice >>>= 1']) {
    assert.equal(valueIssues(`let choice; input.value === (${expression});`).length, 1, expression);
  }
  for (const expression of ["choice += 'x'", 'choice += external']) {
    assert.equal(valueIssues(`let choice; input.value === (${expression});`).length, 0, expression);
  }
  assert.equal(valueIssues('let choice; input.value === (ready ? ++choice : 1);').length, 1);
  assert.equal(valueIssues('input.value === (ready ? 1n : 2);').length, 1);
});

test('assignments preserve DOM receiver types without asserting logical assignment results', () => {
  assert.equal(valueIssues("let element; (element = document.createElement('input')).value === 1;").length, 1);
  assert.equal(valueIssues("let element; (element ||= document.createElement('input')).value === 1;").length, 0);
});

test('writes to unbound globals invalidate built-in and DOM assumptions', () => {
  for (const source of [
    "Number = () => '1'; input.value === Number(1);",
    '({ Number } = external); input.value === Number(1);',
    'for (Number of converters) { input.value === Number(1); }',
    'input = external; input.value === 1;',
    "document = external; document.createElement('input').value === 1;",
    "console = external; console.log('hello');"
  ]) {
    assert.equal(app.reviewSource(source, 'javascript').issues.filter(issue => /^\.value|console.log/.test(issue.title)).length, 0, source);
  }
  assert.equal(valueIssues('function local(Number) { Number = external; } input.value === Number(1);').length, 1);
});

test('annotated Java reference types retain String comparisons and Boolean naming', () => {
  const source = 'class User { java.lang.@Nullable String name; java.lang.@Nullable Boolean status; boolean isReady() { return name == unknown; } }';
  assert.equal(stringIssues(source).length, 1);
  assert.equal(javaIssues(source).filter(issue => /Boolean変数「status」/.test(issue.title)).length, 1);
  assert.equal(stringIssues('class String {} class User { @Nullable String name; boolean isReady() { return name == unknown; } }').length, 0);
});

test('Java array annotations preserve dimensions even with nested annotation arguments', () => {
  for (const type of ['String @Nullable []', 'String @A(text = ")", nested = @B({1, 2})) []', 'java.lang.@Nullable String @Nullable []']) {
    assert.equal(stringIssues(`class User { boolean isReady(${type} names) { return names[0] == unknown; } }`).length, 1, type);
    assert.equal(stringIssues(`class User { boolean isReady(${type} names) { return names == unknown; } }`).length, 0, type);
  }
});

test('annotated Java return types, casts and inherited fields keep their types', () => {
  assert.equal(stringIssues('class User { java.lang.@Nullable String readName() { return null; } boolean isReady() { return readName() == unknown; } }').length, 1);
  assert.equal(stringIssues('class User { boolean isReady(Object name) { return ((java.lang.@Nullable String) name) == unknown; } }').length, 1);
  assert.equal(stringIssues('class Parent { String name; } class Child extends @Nullable Parent { boolean isReady() { return name == unknown; } }').length, 1);
});

test('annotated Java constructors distinguish String instances from custom types and method results', () => {
  for (const expression of ['new @Nullable String("Ada")', 'new java.lang.@Nullable String("Ada")']) {
    assert.equal(stringIssues(`class User { boolean isReady() { return ${expression} == unknown; } }`).length, 1, expression);
    assert.equal(stringIssues(`class User { boolean isReady() { return ${expression}.length() == 3; } }`).length, 0, expression);
  }
  assert.equal(stringIssues('class String {} class User { boolean isReady() { return new @Nullable String() == unknown; } }').length, 0);
});

test('Java array creation distinguishes an array from its String elements', () => {
  for (const expression of ['new String[]{"Ada"}[0]', '(new String[1])[0]', '(new java.lang.String[choose(new int[1])])[0]', '(new String[1][])[0][0]', '(new String[]{"Ada"})[0]']) {
    assert.equal(stringIssues(`class User { boolean isReady() { return ${expression} == unknown; } }`).length, 1, expression);
  }
  for (const expression of ['new String[]{"Ada"}', 'new String[1]', 'new String[1][0]', '(new String[1][])[0]', '(new int[1])[0]']) {
    assert.equal(stringIssues(`class User { boolean isReady() { return ${expression} == unknown; } }`).length, 0, expression);
  }
  assert.equal(stringIssues('class String {} class User { boolean isReady() { return (new String[1])[0] == unknown; } }').length, 0);
});

test('unqualified Java method calls resolve enclosing classes while explicit this stays local', () => {
  const source = 'class Outer { String readName() { return null; } class Inner { boolean isReady() { return readName() == unknown; } } }';
  assert.equal(stringIssues(source).length, 1);
  assert.equal(stringIssues(source.replace('return readName()', 'return this.readName()')).length, 0);
  assert.equal(stringIssues(source.replace('class Inner {', 'class Inner { int readName() { return 1; }')).length, 0);
});

test('truncated but parseable result lines do not fabricate partial replacement code', () => {
  const isolated = createApp();
  isolated.switchLanguage('javascript');
  isolated.element('codeInput').value = 'var userName = 1; //' + 'x'.repeat(180);
  isolated.runReview();
  const output = isolated.element('resultList').innerHTML;
  assert.match(output, /再代入しない場合は const/);
  assert.doesNotMatch(output, /<strong>修正例<\/strong>let userName/);
});

test('keyword spacing examples skip commented controls and fix the actual violation', () => {
  const source = 'if/* keep */(ready) {} if(other) {}';
  const issue = app.reviewSource(source, 'javascript').issues.find(issue => /^if の後ろ/.test(issue.title));
  assert.ok(issue);
  assert.equal(app.fixExampleForIssue(issue, source), 'if/* keep */(ready) {} if (other) {}');
});

test('do-while spacing uses the trailing while keyword and preserves comments', () => {
  const source = 'do {\n  readNext();\n} while(ready);';
  const issues = app.reviewSource(source, 'javascript').issues.filter(issue => /^while の後ろ/.test(issue.title));
  assert.deepEqual(Array.from(issues, issue => issue.line), [3]);
  assert.equal(app.fixExampleForIssue(issues[0], source), 'do {\n  readNext();\n} while (ready);');
  assert.equal(app.reviewSource('do {} while/* keep */(ready);', 'javascript').issues.filter(issue => /^while の後ろ/.test(issue.title)).length, 0);
});
