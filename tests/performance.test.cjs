const assert = require('node:assert/strict');
const { Worker } = require('node:worker_threads');
const { test } = require('node:test');

test('large and adversarial inputs finish within a bounded CPU budget', { timeout: 15000 }, async t => {
  const worker = new Worker(`
    const { parentPort } = require('node:worker_threads');
    const app = require(${JSON.stringify(require.resolve('./harness.cjs'))}).createApp();
    const cases = [
      ['java', ' '.repeat(30000) + 'x'],
      ['java', 'x'.repeat(100000)],
      ['java', 'static final ' + ' '.repeat(30000) + 'x'],
      ['java', '// ' + 'load('.repeat(10000)],
      ['java', 'Type<'.repeat(10000)],
      ['java', 'Type<'.repeat(10000) + ';'],
      ['java', 'String text = "Ada";'],
      ['java', Array.from({ length: 10000 }, (_, i) => 'void loadUser' + i + '() { return; }').join('\\n')],
      ['javascript', Array.from({ length: 10000 }, (_, i) => "const userName" + i + " = 'Ada';").join('\\n')],
      ['javascript', "const label = '" + 'x'.repeat(100000) + "';"]
    ];
    for (const initial of ['1', 'externalValue']) cases.push(['javascript',
      'const level0 = ' + initial + ';\\n' + Array.from({ length: 1000 }, (_, i) =>
        'const level' + (i + 1) + ' = ready ? level' + i + ' : level' + i + ';'
      ).join('\\n') + '\\ninput.value === level1000;'
    ]);
    const results = cases.map(([lang, source]) => {
      const start = performance.now();
      const result = app.reviewSource(source, lang);
      if (source.startsWith('Type<')) assertPartial(result);
      if ((lang === 'javascript' || source.startsWith('void loadUser')) && !result.lex.complete) throw new Error('Valid stress input was not completely parsed: ' + lang + ', ' + source.length + ' characters');
      if (source === 'String text = "Ada";' && !result.lex.complete) throw new Error('Parser did not recover after budget exhaustion');
      return { lang, chars: source.length, ms: performance.now() - start, issues: result.issues.length };
    });
    parentPort.postMessage(results);
    function assertPartial(result) {
      if (result.lex.complete) throw new Error('Over-budget input was reported as complete');
    }
  `, { eval: true });
  t.after(() => worker.terminate());
  const results = await new Promise((resolve, reject) => {
    worker.once('message', resolve);
    worker.once('error', reject);
  });
  for (const result of results) {
    assert.ok(result.ms < 5000, JSON.stringify(result));
    t.diagnostic(`${result.lang}: ${result.chars} characters in ${result.ms.toFixed(1)} ms`);
  }
});
