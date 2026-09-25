const assert = require('node:assert/strict');
const { test } = require('node:test');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const { chromium, firefox, webkit } = require('playwright');

const url = pathToFileURL(path.join(__dirname, '..', '..', 'code-review-checker-2219.html')).href;

for (const [name, engine] of Object.entries({ chromium, firefox, webkit })) {
  test(`${name}: offline browser regression`, { timeout: 60000 }, async t => {
    const browser = await engine.launch({ headless: true });
    t.after(() => browser.close());
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'light' });
    // WebKit offline emulation blocks file:// and blob: worker loads, even though
    // neither needs the network. Abort all HTTP requests instead on that engine.
    await context.route(/^https?:/, route => route.abort());
    if (name !== 'webkit') await context.setOffline(true);
    const errors = [];
    const network = [];
    context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
    context.on('request', request => {
      if (/^https?:/.test(request.url())) network.push(request.url());
    });
    const page = await context.newPage();
    await page.goto(url);
    const input = page.locator('#codeInput');

    await t.test('initial UI and offline single-file startup', async () => {
      assert.equal(await input.count(), 1);
      assert.equal(await page.locator('.lang-btn').count(), 2);
      assert.equal(await page.locator('.line-card').count(), 0);
      assert.equal(await page.locator('#gutterInner').innerText(), '1');
      assert.deepEqual(network, []);
      if (process.env.QA_BASELINE_HTML) {
        const current = await page.screenshot({ animations: 'disabled' });
        const baselinePage = await context.newPage();
        await baselinePage.goto(pathToFileURL(process.env.QA_BASELINE_HTML).href);
        const baseline = await baselinePage.screenshot({ animations: 'disabled' });
        assert.ok(current.equals(baseline), 'Initial UI pixels changed');
        await baselinePage.close();
      }
    });

    await t.test('Java analysis and language switch recompute the same source', async () => {
      await input.fill('String userName = "Ada";\nif (userName == "Bob") {}');
      await page.waitForFunction(() => document.querySelector('#resultList').textContent.includes('Stringの比較'));
      await page.locator('[data-language="javascript"]').click();
      assert.equal(await page.locator('[data-language="javascript"]').getAttribute('aria-pressed'), 'true');
      assert.doesNotMatch(await page.locator('#resultList').innerText(), /Stringの比較/);
    });

    await t.test('results show the correct line and select it when clicked', async () => {
      const source = "const greeting = 'hello\\nworld';\nvar userName = 'Ada';";
      await input.fill(source);
      await page.waitForFunction(() => document.querySelector('[data-line="2"] .line-code')?.textContent === "var userName = 'Ada';");
      await page.locator('[data-line="2"]').click();
      assert.equal(await input.evaluate(el => el.value.slice(el.selectionStart, el.selectionEnd)), "var userName = 'Ada';");
      assert.match(await page.locator('#summary').innerText(), /要修正 1/);
    });

    await t.test('pasted source never executes or creates HTML elements', async () => {
      await input.fill('globalThis.__reviewExecuted = true;\nvar label = "<img src=x onerror=alert(1)>";');
      await page.waitForFunction(() => document.querySelector('#resultList').textContent.includes('<img'));
      assert.equal(await page.evaluate(() => globalThis.__reviewExecuted), undefined);
      assert.equal(await page.locator('#resultList img, #resultList script').count(), 0);
      assert.deepEqual(network, []);
    });

    await t.test('templates are reviewed while regular expressions remain data', async () => {
      await input.fill('const pattern = /var debugger ==/;\nconst label = `hello ${userId == 1}`;');
      await page.waitForFunction(() => document.querySelector('#resultList').textContent.includes('== ではなく ==='));
      assert.equal(await page.locator('.issue-title').filter({ hasText: 'var は禁止' }).count(), 0);
      assert.equal(await page.locator('.issue-title').filter({ hasText: 'debugger が' }).count(), 0);
    });

    await t.test('rapid input, language switching and clearing leave no stale result', async () => {
      await input.fill('var bad_name = "old";');
      await input.fill("const userName = 'Ada';");
      await page.locator('[data-language="java"]').click();
      await page.locator('[data-language="javascript"]').click();
      await page.locator('#clearBtn').click();
      await page.waitForTimeout(450);
      assert.equal(await input.inputValue(), '');
      assert.equal(await page.locator('#resultList').innerText(), '');
      assert.equal(await page.locator('#summary').innerText(), '');
      assert.equal(await page.locator('#gutterInner').innerText(), '1');
    });

    await t.test('Tab indents selected code without deleting it; Shift+Tab preserves input', async () => {
      await input.fill('first();\nsecond();\nthird();');
      await input.evaluate(el => { el.focus(); el.setSelectionRange(0, 19); });
      await page.keyboard.press('Tab');
      assert.equal(await input.inputValue(), '  first();\n  second();\nthird();');
      const value = await input.inputValue();
      await page.keyboard.press('Shift+Tab');
      assert.equal(await input.inputValue(), value);
    });

    await t.test('Tab edits can be undone through the native editor history', async () => {
      // Directly replacing .value after prior native edits leaves WebKit's old
      // undo stack attached to unrelated fixture text. Start a fresh editor.
      const fresh = await context.newPage();
      try {
        await fresh.goto(url);
        await fresh.locator('[data-language="javascript"]').click();
        const editor = fresh.locator('#codeInput');
        await editor.evaluate(el => { el.value = 'userName'; el.focus(); el.setSelectionRange(8, 8); });
        await fresh.keyboard.press('Tab');
        assert.equal(await editor.inputValue(), 'userName  ');
        await fresh.keyboard.press('ControlOrMeta+Z');
        assert.equal(await editor.inputValue(), 'userName');
        await fresh.keyboard.press('ControlOrMeta+Shift+Z');
        assert.equal(await editor.inputValue(), 'userName  ');
      } finally { await fresh.close(); }
    });

    await t.test('clearing code can be undone and redone with matching review results', async () => {
      const fresh = await context.newPage();
      try {
        await fresh.goto(url);
        await fresh.locator('[data-language="javascript"]').click();
        const editor = fresh.locator('#codeInput');
        const source = 'var userName = 1;\nvar userId = 2;';
        await editor.fill(source);
        await fresh.waitForFunction(() => document.querySelectorAll('.line-card').length === 2);
        await fresh.locator('#clearBtn').click();
        assert.equal(await editor.inputValue(), '');
        await fresh.keyboard.press('ControlOrMeta+Z');
        assert.equal(await editor.inputValue(), source);
        await fresh.waitForFunction(() => document.querySelectorAll('.line-card').length === 2);
        await fresh.keyboard.press('ControlOrMeta+Shift+Z');
        assert.equal(await editor.inputValue(), '');
        await fresh.waitForFunction(() => document.querySelector('#resultList').textContent === '');
        assert.equal(await fresh.locator('#gutterInner').innerText(), '1');
      } finally { await fresh.close(); }
    });

    await t.test('Tab preserves a leading blank line and backward selection', async () => {
      await input.fill('\nfirst();\nsecond();');
      await input.evaluate(el => { el.focus(); el.setSelectionRange(0, el.value.length, 'backward'); });
      await page.keyboard.press('Tab');
      assert.equal(await input.inputValue(), '  \n  first();\n  second();');
      assert.equal(await input.evaluate(el => el.selectionDirection), 'backward');
    });

    await t.test('Tab preserves Unicode separators within a logical editor line', async () => {
      const source = "const text = 'before\u2028middle\u2029after';\nreadText(text);";
      await input.fill(source);
      await input.evaluate(el => { el.focus(); el.setSelectionRange(0, el.value.length); });
      await page.keyboard.press('Tab');
      assert.equal(await input.inputValue(), source.split('\n').map(line => '  ' + line).join('\n'));
    });

    await t.test('Tab still updates text and findings when legacy editing commands are blocked', async () => {
      const restricted = await context.newPage();
      try {
        await restricted.addInitScript(() => { document.execCommand = () => { throw new Error('Blocked'); }; });
        await restricted.goto(url);
        await restricted.locator('[data-language="javascript"]').click();
        const editor = restricted.locator('#codeInput');
        await editor.fill('var userName = 1;');
        await editor.evaluate(el => { el.focus(); el.setSelectionRange(0, el.value.length); });
        await restricted.keyboard.press('Tab');
        assert.equal(await editor.inputValue(), '  var userName = 1;');
        await restricted.waitForFunction(() => document.querySelector('#resultList').textContent.includes('var は禁止'));
        await restricted.locator('#clearBtn').click();
        assert.equal(await editor.inputValue(), '');
      } finally { await restricted.close(); }
    });

    await t.test('parenthesized multiline comparisons select the actual operator line', async () => {
      await input.fill('if ((\n  userId\n)\n== 1) {}');
      await page.waitForFunction(() => document.querySelector('[data-line="4"] .issue-title')?.textContent.includes('ではなく'));
      await page.locator('[data-line="4"]').click();
      assert.equal(await input.evaluate(el => el.value.slice(el.selectionStart, el.selectionEnd)), '== 1) {}');
    });

    await t.test('partial input retains independent findings without showing success', async () => {
      await input.fill('var bad_name = ;\nif(userId == 1) { debugger; }');
      await page.waitForFunction(() => document.querySelector('#resultList').dataset.analysisState === 'partial');
      assert.match(await page.locator('#resultList').innerText(), /var は禁止/);
      assert.match(await page.locator('#resultList').innerText(), /debugger が/);
      assert.doesNotMatch(await page.locator('#resultList').innerText(), /現在のルールでは指摘はありません/);
    });

    await t.test('large completed results render in batches and line numbers stay bounded', async () => {
      const source = Array.from({ length: 1000 }, (_, index) => `var userName${index} = 1;`).join('\n');
      await input.fill(source);
      await page.waitForFunction(() => document.querySelectorAll('.line-card').length === 1000, null, { timeout: 15000 });
      assert.ok(await page.locator('.gutter-line').count() < 200);
      await page.locator('[data-line="1000"]').click();
      assert.equal(await input.evaluate(el => el.value.slice(el.selectionStart, el.selectionEnd)), 'var userName999 = 1;');
      assert.match(await page.locator('#gutterInner').innerText(), /1000/);
    });

    await t.test('an expensive review remains cancellable and cannot restore stale results', async () => {
      const source = Array.from({ length: 40000 }, (_, index) => `var userName${index} = 1;`).join('\n');
      // Set the stress fixture directly: huge automation insertText calls can
      // stall browser editing itself, and tests must not replace OS clipboard data.
      await input.evaluate((element, value) => {
        element.value = value;
        element.dispatchEvent(new Event('input', { bubbles: true }));
      }, source);
      await page.waitForFunction(() => document.querySelector('#resultList').getAttribute('aria-busy') === 'true');
      const started = Date.now();
      await page.locator('#clearBtn').click({ timeout: 2000 });
      assert.ok(Date.now() - started < 1500, 'The main thread was blocked by analysis');
      await page.waitForTimeout(450);
      assert.equal(await input.inputValue(), '');
      assert.equal(await page.locator('#resultList').innerText(), '');
      // terminate() is synchronous in the app, but the browser's worker-target
      // teardown event can arrive after the editor has already cleared.
      const remaining = page.workers();
      await Promise.all(remaining.map(worker => new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('A terminated worker was not released')), 5000);
        worker.once('close', () => { clearTimeout(timeout); resolve(); });
      })));
      assert.equal(page.workers().length, 0);
    });

    await t.test('IME composition does not review uncommitted input', async () => {
      await input.dispatchEvent('compositionstart');
      await input.evaluate(el => {
        el.value = 'var userName = 1;';
        el.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true, inputType: 'insertCompositionText' }));
      });
      await page.waitForTimeout(400);
      assert.equal(await page.locator('.line-card').count(), 0);
      await input.dispatchEvent('compositionend');
      await page.waitForFunction(() => document.querySelector('#resultList').textContent.includes('var は禁止'));
    });

    await t.test('IME language switches defer analysis and clear restores normal input', async () => {
      await input.dispatchEvent('compositionstart');
      await input.evaluate(el => { el.value = 'String userName = "Ada";'; });
      await page.locator('[data-language="java"]').click();
      await page.waitForTimeout(400);
      assert.equal(await page.locator('#resultList').getAttribute('aria-busy'), 'false');
      assert.equal(await page.locator('.line-card').count(), 0);
      await page.locator('#clearBtn').click();
      await page.locator('[data-language="javascript"]').click();
      await input.fill('var userName = 1;');
      await page.waitForFunction(() => document.querySelector('#resultList').textContent.includes('var は禁止'));
    });

    await t.test('editing during batched rendering cancels the remaining old cards', async () => {
      await input.fill(Array.from({ length: 1000 }, (_, index) => `var userName${index} = 1;`).join('\n'));
      await page.waitForFunction(() => document.querySelectorAll('.line-card').length >= 40);
      await input.fill("const userName = 'Ada';");
      await page.waitForFunction(() => document.querySelector('.empty-title') !== null);
      await page.waitForTimeout(400);
      assert.equal(await page.locator('.line-card').count(), 0);
      assert.equal(await page.locator('.gutter-line.has-issue').count(), 0);
    });

    await t.test('a failed worker message channel recovers without a stuck busy state', async () => {
      const restricted = await context.newPage();
      await restricted.addInitScript(() => {
        window.Worker = class { postMessage() { throw new Error('Closed channel'); } terminate() {} };
      });
      await restricted.goto(url);
      await restricted.locator('[data-language="javascript"]').click();
      await restricted.locator('#codeInput').fill('var userName = 1;');
      await restricted.waitForFunction(() => document.querySelector('#resultList').textContent.includes('var は禁止'));
      assert.equal(await restricted.locator('#resultList').getAttribute('aria-busy'), 'false');
      await restricted.close();
    });

    await t.test('the reviewer works when browser policy prevents workers', async () => {
      const restricted = await context.newPage();
      await restricted.addInitScript(() => { window.Worker = class { constructor() { throw new DOMException('Blocked', 'SecurityError'); } }; });
      await restricted.goto(url);
      await restricted.locator('[data-language="javascript"]').click();
      await restricted.locator('#codeInput').fill('var userName = 1;');
      await restricted.waitForFunction(() => document.querySelector('#resultList').textContent.includes('var は禁止'));
      assert.equal(restricted.workers().length, 0);
      await restricted.close();
    });

    await t.test('page lifecycle cleanup and resume recreate a usable worker', async () => {
      await input.fill('var userName = 1;');
      await page.waitForFunction(() => document.querySelector('#resultList').textContent.includes('var は禁止'));
      assert.equal(page.workers().length, 1);
      await page.evaluate(() => {
        window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
        window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
      });
      await page.waitForFunction(() => document.querySelector('#resultList').textContent.includes('var は禁止'));
      assert.equal(page.workers().length, 1);
    });

    await t.test('restored form values are reviewed on ordinary pageshow', async () => {
      await input.fill('');
      await page.evaluate(() => {
        document.querySelector('#codeInput').value = 'var restoredName = 1;';
        window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: false }));
      });
      await page.waitForFunction(() => document.querySelector('#resultList').textContent.includes('var は禁止'));
      assert.equal(await page.locator('#resultList').getAttribute('aria-busy'), 'false');
    });

    await t.test('theme switching survives storage restrictions', async () => {
      await page.addInitScript(() => {
        Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('Blocked', 'SecurityError'); } });
      });
      await page.reload();
      await page.locator('#themeToggle').click();
      assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
      assert.equal(await page.locator('html').getAttribute('data-mode'), 'dark');
      await page.locator('#themeToggle').click();
      assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
    });

    await t.test('system dark mode survives inaccessible preference storage', async () => {
      await page.emulateMedia({ colorScheme: 'dark' });
      await page.reload();
      assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
      assert.equal(await page.locator('html').getAttribute('data-mode'), 'dark');
      await page.locator('#themeToggle').click();
      assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
    });

    await t.test('open pages follow system theme changes until an explicit choice', async () => {
      const fresh = await context.newPage();
      try {
        await fresh.addInitScript(() => localStorage.removeItem('code-review-checker-theme'));
        await fresh.goto(url);
        await fresh.emulateMedia({ colorScheme: 'dark' });
        await fresh.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
        assert.equal(await fresh.locator('#themeToggleLabel').innerText(), 'ダーク');
        await fresh.locator('#themeToggle').click();
        await fresh.emulateMedia({ colorScheme: 'light' });
        await fresh.emulateMedia({ colorScheme: 'dark' });
        await fresh.waitForTimeout(100);
        assert.equal(await fresh.locator('html').getAttribute('data-theme'), 'light');
      } finally { await fresh.close(); }
    });

    await t.test('saved and storage-blocked theme choices survive live system changes', async () => {
      for (const blocked of [false, true]) {
        const fresh = await context.newPage();
        try {
          await fresh.addInitScript(blocked => {
            if (blocked) Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('Blocked', 'SecurityError'); } });
            else localStorage.setItem('code-review-checker-theme', 'light');
          }, blocked);
          await fresh.emulateMedia({ colorScheme: 'dark' });
          await fresh.goto(url);
          if (blocked) await fresh.locator('#themeToggle').click();
          await fresh.emulateMedia({ colorScheme: 'light' });
          await fresh.emulateMedia({ colorScheme: 'dark' });
          await fresh.waitForTimeout(100);
          assert.equal(await fresh.locator('html').getAttribute('data-theme'), 'light');
        } finally { await fresh.close(); }
      }
    });

    await t.test('theme preferences synchronize between pages and removal restores system mode', async () => {
      const sender = await context.newPage();
      const receiver = await context.newPage();
      try {
        await sender.goto(url);
        await sender.evaluate(() => localStorage.removeItem('code-review-checker-theme'));
        await receiver.goto(url);
        await sender.locator('#themeToggle').click();
        await receiver.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
        assert.equal(await receiver.locator('#themeToggleLabel').innerText(), 'ダーク');
        await sender.evaluate(() => localStorage.removeItem('code-review-checker-theme'));
        await receiver.waitForFunction(() => document.documentElement.dataset.theme === 'light');
        await receiver.emulateMedia({ colorScheme: 'dark' });
        await receiver.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
      } finally { await sender.close(); await receiver.close(); }
    });

    await t.test('expression fixes and long-line suggestions also work through real workers', async () => {
      const fresh = await context.newPage();
      try {
        await fresh.goto(url);
        const editor = fresh.locator('#codeInput');
        await editor.fill('class User { java.lang.@Nullable String name; boolean isReady() { return name == unknown; } }');
        await fresh.waitForFunction(() => document.querySelector('#resultList').textContent.includes('Stringの比較'));
        await fresh.locator('[data-language="javascript"]').click();
        await editor.fill('let choice; input.value === ++choice;');
        await fresh.waitForFunction(() => document.querySelector('#resultList').textContent.includes('.value の比較相手'));
        await editor.fill('var userName = 1; //' + 'x'.repeat(180));
        await fresh.waitForFunction(() => document.querySelector('#resultList').textContent.includes('再代入しない場合は const'));
        assert.doesNotMatch(await fresh.locator('.fix-example').first().innerText(), /let userName/);
      } finally { await fresh.close(); }
    });

    await t.test('replaced globals do not produce native-API findings through real workers', async () => {
      const fresh = await context.newPage();
      try {
        await fresh.goto(url);
        await fresh.locator('[data-language="javascript"]').click();
        const editor = fresh.locator('#codeInput');
        await editor.fill('input.value === Number(1);');
        await fresh.waitForFunction(() => document.querySelector('#resultList').textContent.includes('.value の比較相手'));
        await editor.fill("globalThis.Number = () => '1';\ninput.value === Number(1);\nconsole.log = customLogger;\nconsole.log('hello');");
        await fresh.waitForFunction(() => document.querySelector('#resultList').dataset.analysisState === 'complete');
        assert.doesNotMatch(await fresh.locator('#resultList').innerText(), /\.value の比較相手|console.log が残っています/);
        assert.equal(await fresh.evaluate(() => Number(1)), 1, 'Reviewed code must remain inert');
      } finally { await fresh.close(); }
    });

    await t.test('annotated Java catches and multiline debug calls retain actionable line locations', async () => {
      const fresh = await context.newPage();
      try {
        await fresh.goto(url);
        const editor = fresh.locator('#codeInput');
        await editor.fill('class User { void read() { try {}\ncatch (@A(text = ")") final Exception error) {}\nSystem\n. out\n. println("hello"); } }');
        await fresh.waitForFunction(() => document.querySelector('[data-line="2"] .issue-title')?.textContent.includes('空の catch'));
        assert.match(await fresh.locator('[data-line="2"]').innerText(), /広く catch/);
        await fresh.locator('[data-line="5"]').click();
        assert.equal(await editor.evaluate(el => el.value.slice(el.selectionStart, el.selectionEnd)), '. println("hello"); } }');
      } finally { await fresh.close(); }
    });

    await t.test('existing result buttons describe their findings and support keyboard navigation', async () => {
      const fresh = await context.newPage();
      try {
        await fresh.goto(url);
        await fresh.locator('[data-language="javascript"]').click();
        const editor = fresh.locator('#codeInput');
        await editor.fill("const userName = 'Ada';\nvar userId = 1;");
        const card = fresh.locator('[data-line="2"]');
        await card.waitFor();
        const description = await card.getAttribute('aria-describedby');
        assert.equal(await fresh.locator(`[id="${description}"]`).count(), 1);
        assert.match(await fresh.locator(`[id="${description}"]`).innerText(), /var は禁止です/);
        assert.equal(await card.getAttribute('aria-controls'), 'codeInput');
        if (name === 'chromium') {
          const session = await context.newCDPSession(fresh);
          try {
            const tree = await session.send('Accessibility.getFullAXTree');
            const button = tree.nodes.find(node => node.role?.value === 'button' && node.name?.value === 'Line 2 の指摘 1件');
            assert.match(button?.description?.value || '', /var は禁止です/);
          } finally { await session.detach(); }
        }
        await card.focus();
        await fresh.keyboard.press('Enter');
        assert.equal(await editor.evaluate(el => el === document.activeElement), true);
        assert.equal(await editor.evaluate(el => el.value.slice(el.selectionStart, el.selectionEnd)), 'var userId = 1;');
        await fresh.keyboard.press('Shift+Tab');
        // WebKit's default keyboard-access preference skips buttons and moves
        // focus to browser chrome. Every engine must let users leave the editor.
        assert.equal(await editor.evaluate(el => el === document.activeElement && document.hasFocus()), false);
      } finally { await fresh.close(); }
    });

    assert.deepEqual(errors, []);
    assert.deepEqual(network, []);
  });
}
