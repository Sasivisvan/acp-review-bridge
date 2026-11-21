import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { Connection, RpcError } from '../src/jsonrpc.js';

function pair() {
  const aToB = new PassThrough();
  const bToA = new PassThrough();
  return [new Connection(bToA, aToB), new Connection(aToB, bToA)];
}

test('request / response round trip', async () => {
  const [a, b] = pair();
  b.onRequest('add', ({ x, y }) => ({ sum: x + y }));
  assert.deepEqual(await a.request('add', { x: 2, y: 3 }), { sum: 5 });
});

test('errors propagate with code', async () => {
  const [a, b] = pair();
  b.onRequest('boom', () => {
    throw new RpcError(-32602, 'bad params');
  });
  await assert.rejects(a.request('boom', {}), (e) => e.code === -32602 && e.message === 'bad params');
  await assert.rejects(a.request('missing', {}), (e) => e.code === -32601);
});

test('notifications are delivered and requests run concurrently', async () => {
  const [a, b] = pair();
  let release;
  const gate = new Promise((r) => (release = r));
  b.onRequest('slow', async () => {
    await gate;
    return { done: true };
  });
  b.onNotification('wake', () => release());
  const slow = a.request('slow', {});
  a.notify('wake', {});
  assert.deepEqual(await slow, { done: true });
});

test('handles messages split across chunks', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const conn = new Connection(input, output);
  conn.onRequest('ping', () => ({ pong: 1 }));
  const line = JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'ping', params: {} }) + '\n';
  input.write(line.slice(0, 10));
  input.write(line.slice(10));
  const reply = await new Promise((r) => output.once('data', (d) => r(JSON.parse(d.toString()))));
  assert.deepEqual(reply, { jsonrpc: '2.0', id: 7, result: { pong: 1 } });
});
