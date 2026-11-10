'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const html = fs.readFileSync(process.env.SEND_SOURCE || path.join(__dirname, '..', 'send.html'), 'utf8');
const start = html.indexOf("window.addEventListener('paste'");
const source = html.slice(start, html.indexOf('\napplyLocale(currentLocale, false);', start));
assert.ok(start >= 0 && source.length > 0, 'sender paste listener must be present');
for (const [name, text, markup, files, shouldStage] of [
  ['plain number', '12', '', [], false],
  ['number copied from a webpage', '12', '<span>12</span>', [], false],
  ['number with an embedded image', '12', '<p>12<img src="data:image/png;base64,AA=="></p>', [], true],
  ['number with a file', '12', '', [{}], true],
  ['non-numeric text', 'notes', '<span>notes</span>', [], true],
]) {
  test(name, async () => {
    let listener, staged = 0, prevented = false;
    const field = { isContentEditable: false, closest: selector => selector === 'input[type="number"]' ? field : null };
    vm.runInNewContext(source, { window: { addEventListener: (_name, fn) => { listener = fn; } },
      State: { active: false }, _packingBundle: false, stageClipboard: async () => { staged++; } });
    await listener({ target: field, clipboardData: { files, getData: type => type === 'text/plain' ? text : markup },
      preventDefault() { prevented = true; } });
    assert.equal(prevented, shouldStage);
    assert.equal(staged, Number(shouldStage));
  });
}
