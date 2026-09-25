const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createApp } = require('./harness.cjs');

function workerApp(options = {}) {
  const workers = [];
  const revoked = [];
  let nextURL = 0;
  class MockWorker {
    constructor() { workers.push(this); }
    postMessage(message) { if (options.throwOnPost) throw new Error('Worker channel closed'); this.message = message; }
    terminate() { this.terminated = true; }
    complete(text = 'completed') {
      this.onmessage({ data: { id: this.message.id, result: {
        issues: [{ level: 'fix', line: 1, endLine: 1, title: text }],
        lex: { complete: true, lines: this.message.source.split('\n') }, cards: [text]
      } } });
    }
  }
  const app = createApp({ Worker: MockWorker, Blob: class {}, URL: {
    createObjectURL: () => `blob:${++nextURL}`, revokeObjectURL: value => revoked.push(value)
  } });
  app.switchLanguage('javascript');
  return { app, workers, revoked };
}

test('new input terminates active work and ignores a late result', () => {
  const { app, workers, revoked } = workerApp();
  const input = app.element('codeInput');
  input.value = 'var oldName = 1;'; app.runReview();
  const old = workers[0];
  input.value = 'var newName = 1;'; input.listeners.input(); app.runReview();
  assert.equal(old.terminated, true);
  assert.equal(revoked.length, 1);
  workers[1].complete('new result');
  old.complete('old result');
  assert.equal(app.element('resultList').innerHTML, 'new result');
});

test('clearing invalidates pending replies and releases the blob URL', () => {
  const { app, workers, revoked } = workerApp();
  app.element('codeInput').value = 'var userName = 1;'; app.runReview();
  const old = workers[0];
  app.element('clearBtn').listeners.click();
  old.complete();
  assert.equal(app.element('resultList').innerHTML, '');
  assert.equal(old.terminated, true);
  assert.equal(revoked.length, 1);
  assert.equal(app.timers.size, 0);
});

test('an idle worker is reused without repeating parser initialization', () => {
  const { app, workers } = workerApp();
  app.element('codeInput').value = 'var firstName = 1;'; app.runReview(); workers[0].complete();
  app.element('codeInput').value = 'var secondName = 1;'; app.runReview();
  assert.equal(workers.length, 1);
  workers[0].complete('latest result');
  assert.equal(app.element('resultList').innerHTML, 'latest result');
});

test('worker load failures fall back to the same engine', () => {
  const { app, workers, revoked } = workerApp();
  app.element('codeInput').value = 'var userName = 1;'; app.runReview();
  workers[0].onerror({ preventDefault() {} });
  assert.match(app.element('resultList').innerHTML, /var は禁止/);
  assert.equal(revoked.length, 1);
});

test('engine failures do not produce the successful empty state', () => {
  const { app, workers } = workerApp();
  app.element('codeInput').value = 'var userName = 1;'; app.runReview();
  workers[0].onmessage({ data: { id: workers[0].message.id, failed: true } });
  assert.equal(app.element('resultList').dataset.analysisState, 'partial');
  assert.equal(app.element('resultList').innerHTML, '');
});

test('IME composition pauses analysis until text is committed', () => {
  const { app, workers } = workerApp();
  const input = app.element('codeInput');
  input.listeners.compositionstart(); input.value = 'var 名前'; input.listeners.input();
  assert.equal(app.timers.size, 0);
  assert.equal(workers.length, 0);
  input.listeners.compositionend();
  assert.equal(app.timers.size, 1);
});

test('clearing also releases an already idle worker and its source memory', () => {
  const { app, workers, revoked } = workerApp();
  app.element('codeInput').value = 'var userName = 1;'; app.runReview(); workers[0].complete();
  app.element('clearBtn').listeners.click();
  assert.equal(workers[0].terminated, true);
  assert.equal(revoked.length, 1);
});

test('worker send failures use the fallback and finish the busy state', () => {
  const { app, workers, revoked } = workerApp({ throwOnPost: true });
  app.element('codeInput').value = 'var userName = 1;';
  assert.doesNotThrow(() => app.runReview());
  assert.match(app.element('resultList').innerHTML, /var は禁止/);
  assert.equal(app.element('resultList').getAttribute('aria-busy'), 'false');
  assert.equal(workers[0].terminated, true);
  assert.equal(revoked.length, 1);
});

test('worker message decoding failures use the fallback', () => {
  const { app, workers } = workerApp();
  app.element('codeInput').value = 'var userName = 1;'; app.runReview();
  workers[0].onmessageerror({ preventDefault() {} });
  assert.match(app.element('resultList').innerHTML, /var は禁止/);
  assert.equal(workers[0].terminated, true);
});

test('language switching during IME waits for composition end', () => {
  const { app, workers } = workerApp();
  app.element('codeInput').listeners.compositionstart();
  app.element('codeInput').value = 'String userName = "Ada";';
  app.switchLanguage('java');
  assert.equal(workers.length, 0);
  assert.equal(app.timers.size, 0);
  app.element('codeInput').listeners.compositionend();
  assert.equal(app.timers.size, 1);
});

test('clearing during IME resumes subsequent input even without compositionend', () => {
  const { app, workers } = workerApp();
  const input = app.element('codeInput');
  input.listeners.compositionstart(); input.value = 'var 名前';
  app.element('clearBtn').listeners.click();
  input.value = 'var userName = 1;'; input.listeners.input();
  assert.equal(app.timers.size, 1);
  app.runReview();
  assert.equal(workers.length, 1);
});

test('Tab cannot modify an active IME composition when the key event lacks its flag', () => {
  const { app } = workerApp();
  const input = app.element('codeInput');
  input.listeners.compositionstart(); input.value = '名前';
  let prevented = false;
  input.listeners.keydown({ key: 'Tab', isComposing: false, preventDefault() { prevented = true; } });
  assert.equal(prevented, false);
  assert.equal(input.value, '名前');
});

test('invalidating a review clears stale gutter issue markers immediately', () => {
  const { app, workers } = workerApp();
  app.element('codeInput').value = 'var userName = 1;'; app.runReview(); workers[0].complete();
  assert.match(app.element('gutterInner').innerHTML, /has-fix/);
  app.switchLanguage('java');
  assert.doesNotMatch(app.element('gutterInner').innerHTML, /has-issue/);
});
