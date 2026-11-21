import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { promptToText, stripAnsi } from '../src/text.js';

test('stripAnsi removes colours, OSC links and CR redraws', () => {
  assert.equal(stripAnsi('\x1b[1;32mgreen\x1b[0m'), 'green');
  assert.equal(stripAnsi('\x1b]8;;https://x\x07link\x1b]8;;\x07'), 'link');
  assert.equal(stripAnsi('a\r\nb\rc'), 'a\nbc');
});

test('promptToText flattens text, mentions and embedded resources', () => {
  const cwd = '/work/proj';
  const text = promptToText(
    [
      { type: 'text', text: 'Fix the bug in' },
      { type: 'resource_link', uri: pathToFileURL('/work/proj/src/a.js').href, name: 'a.js' },
      { type: 'resource_link', uri: pathToFileURL('/elsewhere/b.js').href, name: 'b.js' },
      { type: 'resource', resource: { uri: pathToFileURL('/work/proj/c.txt').href, text: 'hello' } },
    ],
    cwd,
  );
  assert.match(text, /^Fix the bug in @src\/a\.js @\/elsewhere\/b\.js/);
  assert.match(text, /c\.txt:\n```\nhello\n```/);
});
