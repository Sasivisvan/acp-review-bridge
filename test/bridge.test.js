// End-to-end tests: launch the real CLI over stdio and drive it with a simulated ACP client
// that behaves like an editor (serves fs/read_text_file and fs/write_text_file from disk).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Connection } from '../src/jsonrpc.js';
import { buildArgv } from '../src/bridge.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(here, '..', 'bin', 'acp-review-bridge.js');
const FAKE = path.join(here, 'fixtures', 'fake-agent.js');

function setup({ fs = true, agentArgs = ['{prompt}'], extra = [] } = {}) {
  const cwd = mkdtempSync(path.join(tmpdir(), 'arb-e2e-'));
  const backupDir = mkdtempSync(path.join(tmpdir(), 'arb-bak-'));
  writeFileSync(path.join(cwd, 'edit.txt'), 'one\ntwo\n');
  writeFileSync(path.join(cwd, 'gone.txt'), 'delete me\n');

  const proc = spawn(process.execPath, [BIN, '--backup-dir', backupDir, ...extra, '--', process.execPath, FAKE, ...agentArgs], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const client = new Connection(proc.stdout, proc.stdin);
  const updates = [];
  const writes = [];
  client.onNotification('session/update', (p) => updates.push(p.update));
  client.onRequest('fs/read_text_file', ({ path: p }) => ({ content: readFileSync(p, 'utf8') }));
  client.onRequest('fs/write_text_file', ({ path: p, content }) => {
    writes.push({ path: p, content, diskAtWrite: existsSync(p) ? readFileSync(p, 'utf8') : null });
    writeFileSync(p, content);
    return {};
  });

  const caps = fs ? { fs: { readTextFile: true, writeTextFile: true } } : {};
  const start = async () => {
    const init = await client.request('initialize', { protocolVersion: 1, clientCapabilities: caps });
    const { sessionId } = await client.request('session/new', { cwd, mcpServers: [] });
    return { init, sessionId };
  };
  const prompt = (sessionId, text) => client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] });
  const cleanup = () => {
    proc.stdin.end();
    proc.kill();
    rmSync(cwd, { recursive: true, force: true });
    rmSync(backupDir, { recursive: true, force: true });
  };
  return { cwd, backupDir, client, updates, writes, start, prompt, cleanup };
}

const messages = (updates, kind = 'agent_message_chunk') =>
  updates.filter((u) => u.sessionUpdate === kind).map((u) => u.content.text).join('');

test('buildArgv places next-turn args before the prompt', () => {
  assert.deepEqual(buildArgv(['a', '-p', '{prompt}'], ['--continue'], 0, 'hi'), ['a', '-p', 'hi']);
  assert.deepEqual(buildArgv(['a', '-p', '{prompt}'], ['--continue'], 1, 'hi'), ['a', '-p', '--continue', 'hi']);
  assert.deepEqual(buildArgv(['a', '--msg={prompt}'], [], 0, 'x y'), ['a', '--msg=x y']);
  assert.deepEqual(buildArgv(['a'], ['-c'], 2, 'hi'), ['a', '-c']);
});

test('edits are reverted and re-applied through the client for review', async () => {
  const t = setup();
  try {
    const { init, sessionId } = await t.start();
    assert.equal(init.protocolVersion, 1);
    assert.deepEqual(init.authMethods, []);

    const res = await t.prompt(sessionId, 'please edit things');
    assert.equal(res.stopReason, 'end_turn');

    // Agent output streamed, ANSI stripped; stderr shown as thoughts.
    assert.match(messages(t.updates), /Working on: please edit things/);
    assert.match(messages(t.updates, 'agent_thought_chunk'), /thinking/);

    // Modified file: original restored on disk before the client write -> reviewable baseline.
    const edit = t.writes.find((w) => w.path.endsWith('edit.txt'));
    assert.equal(edit.diskAtWrite, 'one\ntwo\n');
    assert.equal(edit.content, 'one\nTWO\n');

    // Created file: removed before the client write, so the client creates it as a new file.
    const created = t.writes.find((w) => w.path.endsWith(path.join('src', 'new.js')));
    assert.equal(created.diskAtWrite, null);
    assert.equal(t.writes.length, 2, 'binary and deleted files are not routed through the client');

    // Final disk state equals what the agent produced.
    assert.equal(readFileSync(path.join(t.cwd, 'edit.txt'), 'utf8'), 'one\nTWO\n');
    assert.ok(existsSync(path.join(t.cwd, 'src', 'new.js')));
    assert.ok(existsSync(path.join(t.cwd, 'image.bin')));
    assert.ok(!existsSync(path.join(t.cwd, 'gone.txt')));

    // Tool calls carry real diffs.
    const calls = t.updates.filter((u) => u.sessionUpdate === 'tool_call');
    const editCall = calls.find((c) => c.title === 'Edit edit.txt');
    assert.equal(editCall.kind, 'edit');
    assert.deepEqual(editCall.content[0], {
      type: 'diff',
      path: path.join(t.cwd, 'edit.txt'),
      oldText: 'one\ntwo\n',
      newText: 'one\nTWO\n',
    });
    assert.equal(calls.find((c) => c.title === 'Create src/new.js').content[0].oldText, null);

    // Deleted file is backed up and reported.
    const del = calls.find((c) => c.title === 'Delete gone.txt');
    assert.equal(del.kind, 'delete');
    const backup = del.content[0].content.text.match(/saved to (.+)$/)[1];
    assert.equal(readFileSync(backup, 'utf8'), 'delete me\n');

    // Every in-progress tool call is completed.
    const done = new Set(t.updates.filter((u) => u.status === 'completed').map((u) => u.toolCallId));
    for (const c of calls) assert.ok(done.has(c.toolCallId), `${c.title} completed`);
  } finally {
    t.cleanup();
  }
});

test('without client fs support, diffs are only reported', async () => {
  const t = setup({ fs: false });
  try {
    const { sessionId } = await t.start();
    await t.prompt(sessionId, 'edit please');
    assert.equal(t.writes.length, 0);
    assert.equal(readFileSync(path.join(t.cwd, 'edit.txt'), 'utf8'), 'one\nTWO\n');
    assert.ok(t.updates.some((u) => u.title === 'Edit edit.txt' && u.content[0].type === 'diff'));
  } finally {
    t.cleanup();
  }
});

test('cancel stops the agent and still reviews partial changes', async () => {
  const t = setup();
  try {
    const { sessionId } = await t.start();
    const started = Date.now();
    const pending = t.prompt(sessionId, 'sleep for a while');
    setTimeout(() => t.client.notify('session/cancel', { sessionId }), 300);
    const res = await pending;
    assert.equal(res.stopReason, 'cancelled');
    assert.ok(Date.now() - started < 3000, 'cancelled promptly');
    assert.ok(t.writes.some((w) => w.path.endsWith('partial.txt')));
  } finally {
    t.cleanup();
  }
});

test('prompt via stdin, next-turn args and non-zero exit', async () => {
  const t = setup({ agentArgs: [], extra: ['--next-turn-arg', '--continue'] });
  try {
    const { sessionId } = await t.start();
    await t.prompt(sessionId, 'first');
    assert.match(messages(t.updates), /Working on: first/);
    assert.match(messages(t.updates), /flags: \[\]/);

    t.updates.length = 0;
    await t.prompt(sessionId, 'fail now');
    // With no {prompt} placeholder the next-turn arg is appended, and the prompt still goes to stdin.
    assert.match(messages(t.updates), /Working on: fail now/);
    assert.match(messages(t.updates), /flags: \["--continue"\]/);
    assert.match(messages(t.updates), /exited with code 3/);
    assert.ok(t.updates.some((u) => u.sessionUpdate === 'tool_call_update' && u.status === 'failed'));
  } finally {
    t.cleanup();
  }
});

test('unknown session and relative cwd are rejected', async () => {
  const t = setup();
  try {
    await t.client.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
    await assert.rejects(t.client.request('session/new', { cwd: 'relative', mcpServers: [] }), (e) => e.code === -32602);
    await assert.rejects(t.prompt('nope', 'hi'), (e) => e.code === -32602);
  } finally {
    t.cleanup();
  }
});
