const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const htmlPath = process.env.CHECKER_HTML || path.join(__dirname, '..', 'code-review-checker-2219.html');
const html = fs.readFileSync(htmlPath, 'utf8');

function createApp(overrides = {}) {
  const elements = new Map();
  const timers = new Map();
  let nextTimer = 0;
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      value: '', innerHTML: '', textContent: '', dataset: {}, style: {}, scrollTop: 0,
      selectionStart: 0, selectionEnd: 0, listeners: {}, attributes: {},
      setAttribute(key, value) { this.attributes[key] = value; },
      getAttribute(key) { return this.attributes[key]; },
      querySelectorAll() { return []; },
      addEventListener(event, listener) { this.listeners[event] = listener; },
      dispatchEvent(event) { this.listeners[event.type]?.(event); },
      focus() {},
      setRangeText(text, start, end) {
        this.value = this.value.slice(0, start) + text + this.value.slice(end);
        this.selectionStart = this.selectionEnd = start + text.length;
      },
      setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
    });
    return elements.get(id);
  }
  const context = vm.createContext({
    document: { currentScript: { textContent: '// worker test fixture' }, documentElement: { dataset: {} }, getElementById: element, querySelectorAll: () => [] },
    window: { matchMedia: () => ({ matches: false }) },
    localStorage: { getItem: () => null, setItem() {} },
    setTimeout(fn) { timers.set(++nextTimer, fn); return nextTimer; },
    clearTimeout(id) { timers.delete(id); },
    getComputedStyle: () => ({ lineHeight: '22px' }),
    console, Event,
    ...overrides
  });
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
  for (let index = 0; index < scripts.length; index++) {
    let script = scripts[index][1];
    if (index === scripts.length - 1) {
      script = script.replace(/\}\)\(\);\s*$/, `globalThis.checker = {
        reviewSource, lexSource, runReview, renderResults, jumpToLine, switchLanguage,
        fixExampleForIssue, checkVariableName
      };})();`);
    }
    vm.runInContext(script, context, { timeout: 10000 });
  }
  return { ...context.checker, element, timers };
}

module.exports = { createApp, html, htmlPath };
