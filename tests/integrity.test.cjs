const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { test } = require('node:test');
const { html } = require('./harness.cjs');

test('all static markup, styles, labels and buttons match the pre-QA UI', () => {
  const markup = html.replace(/  <!-- (?:BEGIN|END) EMBEDDED ACORN -->\n/g, '')
    .replace(/  <script\b[^>]*>[\s\S]*?<\/script>\n/gi, '');
  assert.equal(createHash('sha256').update(markup).digest('hex'), '2210ac9e6729286ebfd8f4d9e6a9270776558e0d4de63d1114ea95c1fd6ccaa6');
});

test('all runtime scripts remain embedded for offline single-file distribution', () => {
  assert.doesNotMatch(html, /<script\b[^>]*\bsrc\s*=/i);
  assert.match(html, /<script id="review-parser">/);
  assert.match(html, /Acorn 8\.18\.0/);
});
