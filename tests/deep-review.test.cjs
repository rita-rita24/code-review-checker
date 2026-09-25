const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createApp } = require('./harness.cjs');
const app = createApp();
const review = (source, lang = 'javascript') => app.reviewSource(source, lang);
const matches = (source, pattern, lang) => review(source, lang).issues.filter(issue => pattern.test(issue.title));

test('an invalid JS statement does not erase independent findings', () => {
  const source = 'var bad_name = ;\nif(userId == 1) { debugger; }';
  assert.equal(review(source).lex.complete, false);
  for (const title of [/var は禁止/, /bad_name/, /ではなく/, /debugger が/]) assert.ok(matches(source, title).length);
});

test('incomplete catch blocks are not invented empty catches', () => {
  assert.equal(matches('try { load(); } catch (error) {', /空の catch/).length, 0);
});

test('failed or partial parsing never renders the no-findings success state', () => {
  app.switchLanguage('javascript');
  app.element('codeInput').value = 'const userName =';
  app.runReview();
  assert.equal(app.element('resultList').dataset.analysisState, 'partial');
  assert.doesNotMatch(app.element('resultList').innerHTML, /現在のルールでは指摘はありません/);
});

test('destructuring checks bound names and leaves external property names alone', () => {
  const source = 'const { api_name: userName, bad_name, ...other_fields } = profile;\nconst [first_name] = names;';
  for (const name of ['bad_name', 'other_fields', 'first_name']) assert.equal(matches(source, new RegExp(name)).length, 1);
  assert.equal(matches(source, /api_name/).length, 0);
});

test('parameters and catch bindings use the existing naming rules', () => {
  const source = 'function loadUser(user_id) {}\ntry { load(); } catch (failure_info) {}';
  assert.equal(matches(source, /user_id/).length, 1);
  assert.equal(matches(source, /failure_info/).length, 1);
});

test('local console bindings do not trigger global debug logging rules', () => {
  assert.equal(matches('function run(console) { console.log(message); }', /console.log/).length, 0);
  assert.equal(matches('console.log(message);', /console.log/).length, 1);
});

test('numeric .value properties on ordinary objects are valid comparisons', () => {
  for (const source of [
    'const input = { value: 1 }; if (input.value === 1) {}',
    'function check(metric) { return metric.value === 1; }',
    "const document = { querySelector() {} }; const input = document.querySelector('input'); input.value === 1;"
  ]) assert.equal(matches(source, /比較相手/).length, 0);
});

test('known DOM elements and numeric constants retain value-comparison findings', () => {
  const source = "const input = document.querySelector('input');\nconst expected = 1;\nif (input.value === expected) {}";
  assert.equal(matches(source, /比較相手/).length, 1);
});

test('mutated values are not inferred from stale initializers', () => {
  const source = "let expected = 1;\nexpected = '1';\nif (input.value === expected) {}";
  assert.equal(matches(source, /比較相手/).length, 0);
});

test('multiline equality findings refer to the operator line', () => {
  const source = 'if (\n  userId\n  == 1\n) {}';
  assert.equal(matches(source, /ではなく/)[0].line, 3);
});

test('unbraced JS control statements accept their indented bodies', () => {
  const source = 'if (isReady)\n  loadUser();\nfor (const user of users)\n  saveUser(user);';
  assert.equal(matches(source, /インデント/).length, 0);
});

test('switch expressions with nested calls retain case indentation', () => {
  const source = 'switch (getKind(user)) {\n  case 1:\n    loadUser();\n    break;\n  default:\n    break;\n}';
  assert.equal(matches(source, /インデント/).length, 0);
});

test('braces inside comments do not change switch spacing detection', () => {
  const source = 'switch (kind) /* { */ {\n  default:\n    break;\n}';
  assert.equal(matches(source, /\{ の前/).length, 0);
});

test('Java multiline signatures and declarations use syntax nodes', () => {
  const source = 'class Users {\n  public boolean\n  active(\n    String user_name\n  ) {\n    String first_name = "Ada",\n      second_name = "Bob";\n    return first_name\n      == second_name;\n  }\n}';
  assert.equal(review(source, 'java').lex.complete, true);
  assert.equal(matches(source, /Booleanを返すメソッド/, 'java').length, 1);
  for (const name of ['user_name', 'first_name', 'second_name']) assert.equal(matches(source, new RegExp(`変数名「${name}」`), 'java').length, 1);
  assert.equal(matches(source, /Stringの比較/, 'java')[0].line, 9);
});

test('Java interface constants and abstract methods are checked', () => {
  const source = 'interface users { int maxRetries = 3; boolean active(String user_name); }';
  for (const title of [/Java定数/, /クラス名/, /Booleanを返すメソッド/, /変数名/]) assert.ok(matches(source, title, 'java').length);
});

test('all inline Java enum constants are checked, not enum methods', () => {
  const source = 'enum Status { pending, active, DONE; void loadUser() { return; } }';
  assert.equal(matches(source, /enum定数/, 'java').length, 2);
});

test('Java constants accept reordered and annotated modifiers', () => {
  const source = 'class Users { final public static int maxRetries = 3; }';
  assert.equal(matches(source, /Java定数/, 'java').length, 1);
});

test('a Java method with a return type and the class name is not a constructor', () => {
  assert.equal(matches('class Users { String Users() { return "Ada"; } }', /メソッド名.*lowerCamelCase/, 'java').length, 1);
});

test('Java forward fields and explicit this fields retain String type', () => {
  const source = 'class Users {\n  boolean matches(int name) {\n    return this.name == other;\n  }\n  String name;\n}';
  assert.equal(matches(source, /Stringの比較/, 'java').length, 1);
});

test('Java inheritance and typed receivers resolve fields declared in the same source', () => {
  const source = 'class Profile { String name; }\nclass User extends Profile {\n  boolean matches(Profile other) {\n    return name == other.name;\n  }\n}';
  assert.equal(matches(source, /Stringの比較/, 'java').length, 1);
});

test('Java parentheses, array elements and method return types retain String type', () => {
  const source = 'class Users {\n  String getName() { return "Ada"; }\n  boolean matches(String[] names) {\n    return (names[0]) == getName();\n  }\n}';
  assert.equal(matches(source, /Stringの比較/, 'java').length, 1);
});

test('Java null checks with parentheses remain allowed', () => {
  const source = 'class Users { boolean exists(String name) { return (name) != (null); } }';
  assert.equal(matches(source, /Stringの比較/, 'java').length, 0);
});

test('Java concatenation and comparison precedence are kept distinct', () => {
  const source = 'class Users { boolean matches(String name, int count) { return name != null && name + count == other; } }';
  assert.equal(matches(source, /Stringの比較/, 'java').length, 1);
});

test('a user-defined Java String class is not java.lang.String', () => {
  const source = 'class String {}\nclass Users { boolean matches(String first, String second) { return first == second; } }';
  assert.equal(matches(source, /Stringの比較/, 'java').length, 0);
});

test('plain Java fragments and malformed files retain safe diagnostics', () => {
  assert.equal(review('String name = "Ada";\nif (name == other) {}', 'java').lex.complete, true);
  assert.equal(review('class Users {', 'java').lex.complete, false);
});

test('unrelated nested Java types do not shadow java.lang.String', () => {
  const source = 'class Other { class String {} } class Users { boolean matches(String name) { return name == other; } }';
  assert.equal(matches(source, /Stringの比較/, 'java').length, 1);
});

test('same-named nested classes retain their own field types', () => {
  const source = 'class First { class Profile { String name; } boolean matches(Profile user) { return user.name == other; } }\nclass Second { class Profile { int name; } boolean matches(Profile user) { return user.name == other; } }';
  const found = matches(source, /Stringの比較/, 'java');
  assert.equal(found.length, 1);
  assert.equal(found[0].line, 1);
});

test('generic Java type parameters shadow built-in simple names', () => {
  for (const source of [
    'class Users<String> { boolean matches(String name) { return name == other; } }',
    'class Users { <String> boolean matches(String name) { return name == other; } }',
    'class Users { <String> String getName() { return null; } boolean matches() { return getName() == other; } }'
  ]) assert.equal(matches(source, /Stringの比較/, 'java').length, 0);
});

test('implicit lambda parameters shadow outer fields in Java', () => {
  for (const parameters of ['name', '(name)', '(var name)']) {
    const source = `class Users { String name; void run() { users.filter(${parameters} -> name == other); } }`;
    assert.equal(review(source, 'java').lex.complete, true);
    assert.equal(matches(source, /Stringの比較/, 'java').length, 0);
  }
});

test('typed Java lambda parameters use their declared types', () => {
  const source = 'class Users { void run() { users.filter((String user_name) -> user_name == other); } }';
  assert.equal(matches(source, /Stringの比較/, 'java').length, 1);
  assert.equal(matches(source, /変数名「user_name」/, 'java').length, 1);
});

test('Java record components provide fields and implicit accessor types', () => {
  const source = 'record User(String user_name, String... names) { boolean matches(User other) { return user_name == other.user_name()\n || names[0] == other.names()[0]; } }';
  assert.equal(review(source, 'java').lex.complete, true);
  assert.equal(matches(source, /変数名「user_name」/, 'java').length, 1);
  assert.equal(matches(source, /Stringの比較/, 'java').length, 2);
});

test('constructing a custom Java String does not infer java.lang.String', () => {
  const source = 'class String {} class Users { boolean matches(String first) { return first == new String(); } }';
  assert.equal(matches(source, /Stringの比較/, 'java').length, 0);
});

test('JS imports shadow matching global APIs', () => {
  const source = "import console from 'logger'; import { document } from 'view'; import { Number } from 'types';\nconsole.log(message); const element = document.createElement('input'); element.value === 1; input.value === Number(count);";
  assert.equal(matches(source, /console.log|比較相手/).length, 0);
});

test('JS switch and static-block declarations remain in their own scopes', () => {
  for (const source of [
    'switch (kind) { case 1: const console = logger; console.log(message); break; }\nconsole.log(message);',
    'class User { static { var console = logger; console.log(message); } }\nconsole.log(message);'
  ]) assert.equal(matches(source, /console.log/).length, 1);
});

test('unknown JS addition is not assumed to produce a number', () => {
  assert.equal(matches('input.value === first + second;', /比較相手/).length, 0);
  assert.equal(matches('input.value === 1 + 2;', /比較相手/).length, 1);
});

test('JS loop assignments and redeclarations invalidate stale types', () => {
  for (const source of [
    'let expected = 1; for (expected of values) {} input.value === expected;',
    "var expected = 1; var expected = '1'; input.value === expected;"
  ]) assert.equal(matches(source, /比較相手/).length, 0);
});

test('DOM selector inference does not confuse numeric or descendant elements', () => {
  for (const expression of ["document.getElementById('progress')", "document.querySelector('input ~ meter')", "document.querySelector('input, progress')"]) {
    assert.equal(matches(`const element = ${expression}; element.value === 1;`, /比較相手/).length, 0);
  }
  assert.equal(matches("const element = document.querySelector('input[type=number].count'); element.value === 1;", /比較相手/).length, 1);
});

test('value comparison suggestions do not replace an unrelated string literal', () => {
  const source = 'const label = "caption"; input.value === 1;';
  const issue = matches(source, /比較相手/)[0];
  assert.equal(app.fixExampleForIssue(issue, source), issue.suggestion);
});

test('spacing examples fix the affected block rather than earlier objects or keywords', () => {
  for (const [source, pattern, expected] of [
    ['const options = {}; if (isReady){}', /\{ の前/, 'const options = {}; if (isReady) {}'],
    ['if (isReady) {} while(isActive) {}', /^while の後ろ/, 'if (isReady) {} while (isActive) {}'],
    ['if (isReady) {} if(isActive) {}', /^if の後ろ/, 'if (isReady) {} if (isActive) {}']
  ]) assert.equal(app.fixExampleForIssue(matches(source, pattern)[0], source), expected);
});

test('truncated result snippets use the existing suggestion without fabricating code', () => {
  const source = 'var label = "' + 'x'.repeat(300) + '";';
  const issue = matches(source, /var は禁止/)[0];
  assert.equal(app.fixExampleForIssue(issue, source.slice(0, 160)), issue.suggestion);
});

test('explicit Java imports do not masquerade as built-in String', () => {
  assert.equal(matches('import custom.String; class Users { boolean matches(String name) { return name == other; } }', /Stringの比較/, 'java').length, 0);
});

test('anonymous Java classes do not leak their fields into the enclosing class', () => {
  const source = 'class Users { void run() { Object instance = new Object() { String name; boolean matches() { return name == other; } }; }\nboolean matches() { return name == other; } }';
  const found = matches(source, /Stringの比較/, 'java');
  assert.equal(found.length, 1);
  assert.equal(found[0].line, 1);
});

test('Java reference casts carry the explicitly declared type', () => {
  assert.equal(matches('class Users { boolean matches(Object name) { return (String) name == other; } }', /Stringの比較/, 'java').length, 1);
});

test('Java instanceof pattern bindings remain separate from later locals', () => {
  const source = 'class Users { boolean matches(Object input) { if (input instanceof String name) { return name == other; }\nint name = 1; return name == other; } }';
  const found = matches(source, /Stringの比較/, 'java');
  assert.equal(found.length, 1);
  assert.equal(found[0].line, 1);
});
