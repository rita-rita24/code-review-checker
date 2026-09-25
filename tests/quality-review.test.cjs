const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createApp } = require('./harness.cjs');
const app = createApp();
const findings = (source, language = 'javascript') => app.reviewSource(source, language).issues;
const valueIssues = source => findings(source).filter(issue => issue.title.startsWith('.value'));
const stringIssues = source => findings(source, 'java').filter(issue => issue.title.startsWith('Stringの比較'));

test('destructuring defaults do not assert the actual value or DOM receiver type', () => {
  for (const pattern of ['{ choice = 1 }', '[choice = 1]', '{ nested: { choice = 1 } }']) {
    assert.equal(valueIssues(`const ${pattern} = external;\ninput.value === choice;`).length, 0);
  }
  assert.equal(valueIssues("const { element = document.createElement('input') } = external;\nelement.value === 1;").length, 0);
  assert.equal(valueIssues("const element = document.createElement('input');\nelement.value === 1;").length, 1);
});

test('uncertain boolean defaults do not assert boolean naming rules', () => {
  for (const source of ['const { status = true } = external;', 'function readStatus(status = true) {}']) {
    assert.equal(findings(source).filter(issue => /Boolean/.test(issue.title)).length, 0);
  }
  assert.equal(findings('const status = true;').filter(issue => /Boolean/.test(issue.title)).length, 1);
});

test('with bodies do not resolve dynamic names to globals or outer declarations', () => {
  const source = "const choice = 1; with (external) { console.log('hello'); input.value === choice; }\nconsole.log('after');\ninput.value === choice;";
  assert.deepEqual(Array.from(findings(source).filter(issue => /console.log/.test(issue.title)), issue => issue.line), [2]);
  assert.deepEqual(Array.from(valueIssues(source), issue => issue.line), [3]);
  assert.equal(valueIssues('with (input.value === 1) {}').length, 1);
  assert.equal(valueIssues("let choice = 1; with (external) { choice = 'text'; }\ninput.value === choice;").length, 0);
});

test('BigInt conversions are non-string values, while shadowed conversions remain unknown', () => {
  assert.equal(valueIssues('input.value === BigInt(1);').length, 1);
  assert.equal(valueIssues('function readChoice(BigInt) { return input.value === BigInt(1); }').length, 0);
  for (const name of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) {
    assert.equal(valueIssues(`input.value === ${name}();`).length, 0);
  }
});

test('Java chained calls do not inherit the first method return type', () => {
  for (const expression of ['getText().length()', 'this.getText().length()', 'getText().trim().length()', 'other.getText().length()']) {
    assert.equal(stringIssues(`class User { String getText() { return "Ada"; } boolean isReady(User other) { return ${expression} == 3; } }`).length, 0, expression);
  }
});

test('Java direct and nested argument calls still resolve method return types', () => {
  for (const expression of ['getText()', 'this.getText()', 'other.getText()', 'getText(other.getText().length())']) {
    assert.equal(stringIssues(`class User { String getText() { return "Ada"; } String getText(int index) { return "Ada"; } boolean isReady(User other, String unknown) { return ${expression} == unknown; } }`).length, 1, expression);
  }
});

test('Java array-returning method chains are not inferred from the first call', () => {
  assert.equal(stringIssues('class User { String[] getNames() { return null; } boolean isReady() { return getNames()[0] == unknown; } }').length, 1);
  assert.equal(stringIssues('class User { String[] getNames() { return null; } boolean isReady() { return getNames().hashCode() == 3; } }').length, 0);
});

test('Java assignment comparisons use the declared target type', () => {
  for (const operator of ['=', '+=']) {
    assert.equal(stringIssues(`class User { String text; boolean isReady() { return (text ${operator} "Ada") == (text ${operator} "Bob"); } }`).length, 1);
  }
  assert.equal(stringIssues('class User { Object text; boolean isReady() { return (text = "Ada") == (text = "Bob"); } }').length, 0);
  assert.equal(stringIssues('class User { String text; boolean isReady() { return (text = "Ada") == null; } }').length, 0);
});

test('Java instanceof binds before equality without inventing String comparisons', () => {
  assert.equal(stringIssues('class User { boolean isReady(String text) { return text instanceof String == true; } }').length, 0);
  assert.equal(stringIssues('class User { boolean isReady(String text) { return text instanceof String && text == "Ada"; } }').length, 1);
});

test('Java boolean bitwise operations and instanceof retain boolean naming checks', () => {
  for (const expression of ['true & false', 'true | false', 'true ^ false', 'obj instanceof String']) {
    assert.equal(findings(`var status = ${expression};`, 'java').filter(issue => /Boolean変数/.test(issue.title)).length, 1, expression);
  }
  assert.equal(findings('var status = 1 & 2;', 'java').filter(issue => /Boolean変数/.test(issue.title)).length, 0);
});

test('DOM aliases retain receiver types through long chains', () => {
  const aliases = Array.from({ length: 1000 }, (_, i) => `const element${i + 1} = element${i};`).join('\n');
  assert.equal(valueIssues(`const element0 = document.createElement('input');\n${aliases}\nelement1000.value === 1;`).length, 1);
  assert.equal(valueIssues(`const element0 = external;\n${aliases}\nelement1000.value === 1;`).length, 0);
});

test('Java recovery distinguishes same-named methods from constructors', () => {
  const source = 'class User {\n  public User() {}\n  String User() { return "Ada"; }\n  void unfinished(';
  const result = app.reviewSource(source, 'java');
  assert.equal(result.lex.complete, false);
  assert.deepEqual(Array.from(result.issues.filter(issue => /メソッド名「User」/.test(issue.title)), issue => issue.line), [3]);
});
