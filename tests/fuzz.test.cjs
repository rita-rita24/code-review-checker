const assert = require('node:assert/strict');
const { Worker } = require('node:worker_threads');
const { test } = require('node:test');

// This suite checks correctness across 500 inputs. CPU limits are asserted in
// performance.test.cjs; allow a loaded CI host time to finish the full sample.
test('seeded malformed inputs keep diagnostic ranges valid and never execute code', { timeout: 60000 }, async t => {
  const worker = new Worker(`
    const { parentPort } = require('node:worker_threads');
    const assert = require('node:assert/strict');
    const app = require(${JSON.stringify(require.resolve('./harness.cjs'))}).createApp();
    let seed = 0x5eed1234;
    const random = max => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) % max; };
    const fragments = [
      'var bad_name = "text";', 'if (name == null) {', '}', '/* TODO', '*/',
      '// if (ready) { run(); }', 'const regex = /[{}]/g;', 'String name = "Ada";',
      'class User {', 'boolean matches(String name) {', 'return name == other;',
      'const label = ' + String.fromCharCode(96) + 'hello ' + '$' + '{name == 1}' + String.fromCharCode(96) + ';',
      'const { api_name: userName } = profile;', 'try { run(); } catch (error) {}',
      'switch (name)', 'switch (name) { case', 'class', 'bad_name {}',
      'if (!(input instanceof String name)) return false;',
      'try (var name = getResource()) {', 'return names[indices[0]] == other;',
      String.fromCharCode(0, 0xd800), '名前 = 1;', '('.repeat(32),
      'throw new Error("This source must never execute");'
    ];
    let count = 0;
    for (const language of ['javascript', 'java']) for (let sample = 0; sample < 250; sample++) {
      const chunks = Array.from({ length: 1 + random(12) }, () => fragments[random(fragments.length)]);
      let source = chunks.join('\\n');
      if (sample % 3 === 0) source = source.slice(0, random(source.length + 1));
      const result = app.reviewSource(source, language);
      const lines = source.split('\\n').length;
      const keys = new Set();
      let previous = 0;
      for (const issue of result.issues) {
        assert.ok(Number.isInteger(issue.line) && issue.line >= previous && issue.line >= 1);
        assert.ok(Number.isInteger(issue.endLine) && issue.endLine >= issue.line && issue.endLine <= lines);
        assert.ok(['fix', 'warn', 'info'].includes(issue.level));
        const key = [issue.line, issue.endLine, issue.title].join('|');
        assert.ok(!keys.has(key)); keys.add(key); previous = issue.line;
      }
      assert.equal(typeof result.lex.complete, 'boolean');
      count++;
    }
    parentPort.postMessage(count);
  `, { eval: true });
  t.after(() => worker.terminate());
  const count = await new Promise((resolve, reject) => {
    worker.once('message', resolve);
    worker.once('error', reject);
  });
  assert.equal(count, 500);
});
