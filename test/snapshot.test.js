import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, unlinkSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULT_IGNORES, decodeText, diffSnapshot, makeIgnoreMatcher, takeSnapshot } from '../src/snapshot.js';

const isIgnored = makeIgnoreMatcher(DEFAULT_IGNORES);

function workspace(useGit) {
  const dir = mkdtempSync(path.join(tmpdir(), 'arb-snap-'));
  const w = (rel, data) => {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), data);
  };
  w('keep.txt', 'same\n');
  w('edit.txt', 'one\ntwo\n');
  w('gone.txt', 'bye\n');
  w('src/deep/file.js', 'x\n');
  w('node_modules/pkg/index.js', 'ignored\n');
  w('venv/lib/site.py', 'ignored\n');
  if (useGit) {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    w('.gitignore', 'build/\n');
    w('build/out.bin', 'ignored by gitignore\n');
  }
  return { dir, w };
}

test('ignore matcher', () => {
  assert.ok(isIgnored('node_modules/a/b.js'));
  assert.ok(isIgnored('pkg/venv/x.py'));
  assert.ok(isIgnored('a/b.pyc'));
  assert.ok(!isIgnored('src/venv.js'));
  const custom = makeIgnoreMatcher(['docs/*.md', 'secret?.txt']);
  assert.ok(custom('docs/a.md'));
  assert.ok(!custom('docs/sub/a.md'));
  assert.ok(custom('x/secret1.txt'));
});

test('decodeText detects binary and keeps BOM', () => {
  assert.equal(decodeText(Buffer.from([0x68, 0x00, 0x69])), null);
  assert.equal(decodeText(Buffer.from([0xff, 0xfe, 0xfd])), null);
  assert.equal(decodeText(Buffer.from('\ufeffhi')), '\ufeffhi');
});

for (const useGit of [true, false]) {
  test(`detects created / modified / deleted files (${useGit ? 'git' : 'plain dir'})`, async () => {
    const { dir, w } = workspace(useGit);
    try {
      const before = await takeSnapshot(dir, { isIgnored });
      assert.ok(before.has('edit.txt'));
      assert.ok(!before.has('node_modules/pkg/index.js'));
      assert.ok(!before.has('venv/lib/site.py'));
      if (useGit) assert.ok(!before.has('build/out.bin'));

      w('edit.txt', 'one\nTWO\n');
      w('src/new.ts', 'export {}\n');
      w('img.png', Buffer.from([0x89, 0x50, 0x00, 0x01]));
      w('node_modules/pkg/index.js', 'changed but ignored\n');
      unlinkSync(path.join(dir, 'gone.txt'));
      // Same size, different content, forced identical mtime: must still be detected.
      w('keep.txt', 'SAME\n');
      const t = before.get('keep.txt').mtimeMs / 1000;
      utimesSync(path.join(dir, 'keep.txt'), t, t);

      const changes = await diffSnapshot(dir, before, { isIgnored });
      const byRel = Object.fromEntries(changes.map((c) => [c.rel, c]));
      assert.deepEqual(Object.keys(byRel).sort(), ['edit.txt', 'gone.txt', 'img.png', 'keep.txt', 'src/new.ts']);
      assert.equal(byRel['edit.txt'].type, 'modified');
      assert.equal(byRel['edit.txt'].beforeText, 'one\ntwo\n');
      assert.equal(byRel['edit.txt'].afterText, 'one\nTWO\n');
      assert.ok(byRel['edit.txt'].reviewable);
      assert.equal(byRel['src/new.ts'].type, 'created');
      assert.ok(byRel['src/new.ts'].reviewable);
      assert.equal(byRel['gone.txt'].type, 'deleted');
      assert.ok(!byRel['gone.txt'].reviewable);
      assert.equal(byRel['img.png'].reason, 'binary file');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
