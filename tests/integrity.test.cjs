const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { test } = require('node:test');
const { html } = require('./harness.cjs');

test('all static markup, styles, labels and buttons match the UI after comment cleanup', () => {
  const markup = html.replace(/  <!-- (?:BEGIN|END) EMBEDDED ACORN -->\n/g, '')
    .replace(/  <script\b[^>]*>[\s\S]*?<\/script>\n/gi, '');
  assert.equal(createHash('sha256').update(markup).digest('hex'), '7b90d4c3eb9a9521c513dfb03416273ad8d90e0fda38f1d9b29a4fbaa6f061b5');
});

test('all runtime scripts remain embedded for offline single-file distribution', () => {
  assert.doesNotMatch(html, /<script\b[^>]*\bsrc\s*=/i);
  assert.match(html, /<script id="review-parser">/);
  assert.match(html, /Acorn 8\.18\.0/);
});
