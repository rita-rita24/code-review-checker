const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createApp } = require('./harness.cjs');

function themeApp(saved, blocked = false) {
  const media = { matches: false, addEventListener(name, listener) { this.changed = listener; } };
  const events = {};
  const writes = [];
  const storage = {
    getItem() { if (blocked) throw new Error('Blocked'); return saved; },
    setItem(key, value) { if (blocked) throw new Error('Blocked'); writes.push([key, value]); }
  };
  const app = createApp({
    window: { matchMedia: () => media, addEventListener(name, listener) { events[name] = listener; } },
    localStorage: storage
  });
  return { app, media, events, storage, writes, label: () => app.element('themeToggleLabel').textContent };
}

test('system theme changes update the existing theme until the user chooses one', () => {
  const { app, media, writes, label } = themeApp(null);
  media.matches = true; media.changed();
  assert.equal(label(), 'ダーク');
  assert.equal(writes.length, 0);
  app.element('themeToggle').listeners.click();
  assert.equal(label(), 'ライト');
  media.matches = false; media.changed();
  media.matches = true; media.changed();
  assert.equal(label(), 'ライト');
  assert.equal(writes.length, 1);
});

test('a stored theme and an in-memory choice survive system changes', () => {
  const saved = themeApp('light');
  saved.media.matches = true; saved.media.changed();
  assert.equal(saved.label(), 'ライト');
  const blocked = themeApp(null, true);
  blocked.media.matches = true; blocked.media.changed();
  assert.equal(blocked.label(), 'ダーク');
  blocked.app.element('themeToggle').listeners.click();
  blocked.media.changed();
  assert.equal(blocked.label(), 'ライト');
});

test('theme storage changes synchronize without persisting feedback or unrelated keys', () => {
  const { events, media, storage, writes, label } = themeApp(null);
  events.storage({ key: 'code-review-checker-theme', newValue: 'dark', storageArea: storage });
  assert.equal(label(), 'ダーク');
  events.storage({ key: 'unrelated', newValue: 'light', storageArea: storage });
  events.storage({ key: 'code-review-checker-theme', newValue: 'light', storageArea: {} });
  assert.equal(label(), 'ダーク');
  events.storage({ key: null, newValue: null, storageArea: storage });
  assert.equal(label(), 'ライト');
  media.matches = true; media.changed();
  assert.equal(label(), 'ダーク');
  assert.equal(writes.length, 0);
});
