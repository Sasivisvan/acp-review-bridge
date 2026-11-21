// The ACP agent: wraps a non-ACP CLI coding agent and turns its file edits into
// reviewable edits in the client (Zed shows them inline with Keep / Reject).
//
// Per prompt turn:
//   1. snapshot the workspace
//   2. run the wrapped CLI agent, streaming stdout/stderr into the agent panel
//   3. diff the workspace against the snapshot
//   4. for each changed text file: restore the original on disk, wait until the editor
//      sees the original, then re-apply the agent's version via `fs/write_text_file`.
//      The client records that write as an agent edit -> inline review.

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { Connection, ErrorCodes, RpcError } from './jsonrpc.js';
import { DEFAULT_IGNORES, DEFAULT_MAX_FILE_BYTES, diffSnapshot, makeIgnoreMatcher, takeSnapshot } from './snapshot.js';
import { promptToText, stripAnsi } from './text.js';

export const PROTOCOL_VERSION = 1;
const PROMPT_PLACEHOLDER = '{prompt}';

/**
 * @typedef {object} BridgeConfig
 * @property {string[]} command          wrapped agent argv; `{prompt}` is replaced by the prompt, else prompt goes to stdin
 * @property {string[]} [nextTurnArgs]   extra args for the 2nd+ turn of a session (e.g. `--continue`)
 * @property {string[]} [ignores]        extra ignore patterns
 * @property {number}   [maxBytes]       files larger than this are applied directly instead of reviewed
 * @property {'markdown'|'code'} [output] how agent stdout is rendered
 * @property {boolean}  [review]         false = only report diffs, never route edits through the client
 * @property {number}   [syncTimeoutMs]  how long to wait for the editor to reload a reverted file
 * @property {string}   [backupDir]      where contents of deleted files are saved
 * @property {string}   [title]          display name shown by the client
 * @property {string}   [version]
 */

export function defaultBackupDir() {
  const state = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  return path.join(state, 'acp-review-bridge', 'backups');
}

/** Build the argv for one turn. Next-turn args go right before the `{prompt}` arg (or at the end). */
export function buildArgv(command, nextTurnArgs, turn, prompt) {
  const argv = [...command];
  if (turn > 0 && nextTurnArgs?.length) {
    const at = argv.findIndex((a) => a.includes(PROMPT_PLACEHOLDER));
    argv.splice(at === -1 ? argv.length : at, 0, ...nextTurnArgs);
  }
  return argv.map((a) => a.split(PROMPT_PLACEHOLDER).join(prompt));
}

const normalize = (s) => s.replace(/^﻿/, '').replace(/\r\n/g, '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Bridge {
  /**
   * @param {{ input: import('node:stream').Readable, output: import('node:stream').Writable,
   *           config: BridgeConfig, log?: (...a: any[]) => void }} opts
   */
  constructor({ input, output, config, log = () => {} }) {
    this.config = {
      nextTurnArgs: [],
      ignores: [],
      maxBytes: DEFAULT_MAX_FILE_BYTES,
      output: 'markdown',
      review: true,
      syncTimeoutMs: 2000,
      backupDir: defaultBackupDir(),
      title: 'CLI agent (reviewed)',
      version: '0.0.0',
      ...config,
    };
    this.log = log;
    this.isIgnored = makeIgnoreMatcher([...DEFAULT_IGNORES, ...this.config.ignores]);
    this.sessions = new Map();
    this.clientCapabilities = {};
    this.callSeq = 0;

    const conn = (this.conn = new Connection(input, output, { log }));
    conn.onRequest('initialize', (p) => this.initialize(p));
    conn.onRequest('authenticate', () => ({}));
    conn.onRequest('session/new', (p) => this.newSession(p));
    conn.onRequest('session/prompt', (p) => this.prompt(p));
    conn.onNotification('session/cancel', (p) => this.cancel(p));
    this.closed = conn.closedPromise.then(() => this.shutdown());
  }

  initialize({ protocolVersion, clientCapabilities }) {
    this.clientCapabilities = clientCapabilities ?? {};
    this.log(`client protocol v${protocolVersion}, fs caps:`, JSON.stringify(this.clientCapabilities.fs ?? {}));
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: { image: false, audio: false, embeddedContext: false },
      },
      agentInfo: { name: 'acp-review-bridge', title: this.config.title, version: this.config.version },
      authMethods: [],
    };
  }

  newSession({ cwd }) {
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) {
      throw new RpcError(ErrorCodes.INVALID_PARAMS, 'session/new requires an absolute cwd');
    }
    const id = `sess_${randomUUID()}`;
    this.sessions.set(id, { id, cwd, turns: 0, busy: false, cancelled: false, child: null });
    return { sessionId: id };
  }

  #session(sessionId) {
    const s = this.sessions.get(sessionId);
    if (!s) throw new RpcError(ErrorCodes.INVALID_PARAMS, `Unknown session ${sessionId}`);
    return s;
  }

  update(s, update) {
    this.conn.notify('session/update', { sessionId: s.id, update });
  }

  say(s, text, kind = 'agent_message_chunk') {
    if (text) this.update(s, { sessionUpdate: kind, content: { type: 'text', text } });
  }

  async prompt({ sessionId, prompt }) {
    const s = this.#session(sessionId);
    if (s.busy) throw new RpcError(ErrorCodes.INVALID_REQUEST, 'A prompt is already running in this session');
    s.busy = true;
    s.cancelled = false;
    try {
      const text = promptToText(prompt, s.cwd);
      if (!text) {
        this.say(s, 'Empty prompt, nothing to do.');
        return { stopReason: 'end_turn' };
      }
      const opts = { isIgnored: this.isIgnored, maxBytes: this.config.maxBytes };
      const before = await takeSnapshot(s.cwd, opts);
      this.log(`turn ${s.turns + 1}: snapshot of ${before.size} files`);
      await this.runAgent(s, text);
      const changes = await diffSnapshot(s.cwd, before, opts);
      this.log(`turn ${s.turns + 1}: ${changes.length} changed file(s)`);
      await this.reportChanges(s, changes);
      s.turns++;
      return { stopReason: s.cancelled ? 'cancelled' : 'end_turn' };
    } finally {
      s.busy = false;
      s.child = null;
    }
  }

  cancel({ sessionId }) {
    const s = this.sessions.get(sessionId);
    if (!s?.busy) return;
    s.cancelled = true;
    this.killChild(s);
  }

  killChild(s) {
    const child = s.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const send = (sig) => {
      try {
        if (process.platform === 'win32') child.kill(sig);
        else process.kill(-child.pid, sig); // whole process group
      } catch {
        /* already gone */
      }
    };
    send('SIGTERM');
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) send('SIGKILL');
    }, 3000).unref();
  }

  runAgent(s, promptText) {
    const { command, nextTurnArgs, output } = this.config;
    const argv = buildArgv(command, nextTurnArgs, s.turns, promptText);
    const viaStdin = !command.some((a) => a.includes(PROMPT_PLACEHOLDER));
    const runId = `run_${++this.callSeq}`;
    this.update(s, {
      sessionUpdate: 'tool_call',
      toolCallId: runId,
      title: `Run ${path.basename(argv[0])}`,
      kind: 'execute',
      status: 'in_progress',
      rawInput: { command: argv[0], args: argv.slice(1), cwd: s.cwd },
    });

    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(argv[0], argv.slice(1), {
          cwd: s.cwd,
          env: process.env,
          stdio: [viaStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
          detached: process.platform !== 'win32',
        });
      } catch (err) {
        return finish(null, null, err);
      }
      s.child = child;
      if (s.cancelled) this.killChild(s);

      let opened = false;
      const out = new StringDecoder('utf8');
      const errDec = new StringDecoder('utf8');
      const emitOut = (raw) => {
        const text = stripAnsi(raw);
        if (!text) return;
        if (output === 'code' && !opened) {
          opened = true;
          this.say(s, '```\n');
        }
        this.say(s, text);
      };
      child.stdout.on('data', (d) => emitOut(out.write(d)));
      child.stderr.on('data', (d) => this.say(s, stripAnsi(errDec.write(d)), 'agent_thought_chunk'));
      if (viaStdin) {
        child.stdin.on('error', () => {}); // agent may exit without reading stdin
        child.stdin.end(promptText);
      }

      let done = false;
      child.on('error', (err) => finish(null, null, err));
      child.on('close', (code, signal) => {
        emitOut(out.end());
        this.say(s, stripAnsi(errDec.end()), 'agent_thought_chunk');
        finish(code, signal);
      });

      const self = this;
      function finish(code, signal, err) {
        if (done) return;
        done = true;
        if (opened) self.say(s, '\n```\n');
        if (err) {
          self.say(s, `\n\n**acp-review-bridge:** could not start \`${argv[0]}\`: ${err.message}\n`);
        } else if (code !== 0 && !s.cancelled) {
          self.say(s, `\n\n_${path.basename(argv[0])} exited with ${signal ? `signal ${signal}` : `code ${code}`}._\n`);
        }
        self.update(s, {
          sessionUpdate: 'tool_call_update',
          toolCallId: runId,
          status: !err && code === 0 ? 'completed' : 'failed',
          rawOutput: { exitCode: code, signal, error: err?.message },
        });
        resolve({ code, signal, error: err });
      }
    });
  }

  async reportChanges(s, changes) {
    const fsCaps = this.clientCapabilities.fs ?? {};
    const canWrite = this.config.review && fsCaps.writeTextFile === true;
    const canRead = fsCaps.readTextFile === true;
    for (const change of changes) {
      try {
        await this.reviewChange(s, change, canWrite, canRead);
      } catch (err) {
        this.log(`failed to report ${change.rel}:`, err);
      }
    }
    const direct = changes.filter((c) => !c.reviewable);
    if (direct.length) {
      this.say(
        s,
        `\n\n${direct.length} change(s) could not be reviewed inline and were applied directly: ` +
          direct.map((c) => `\`${c.rel}\` (${c.reason})`).join(', ') +
          '.\n',
      );
    }
  }

  async reviewChange(s, c, canWrite, canRead) {
    const abs = path.join(s.cwd, c.rel);
    const toolCallId = `edit_${++this.callSeq}`;
    const title = { created: `Create ${c.rel}`, modified: `Edit ${c.rel}`, deleted: `Delete ${c.rel}` }[c.type];
    const base = { toolCallId, title, kind: c.type === 'deleted' ? 'delete' : 'edit', locations: [{ path: abs }] };
    const textContent = (text) => [{ type: 'content', content: { type: 'text', text } }];

    if (!c.reviewable) {
      let note = `Applied directly (${c.reason}).`;
      if (c.type === 'deleted') {
        const saved = await this.backup(s, c);
        note = saved ? `File deleted. Previous contents saved to ${saved}` : 'File deleted (no backup: file was too large).';
      }
      this.update(s, { sessionUpdate: 'tool_call', ...base, status: 'completed', content: textContent(note) });
      return;
    }

    const diff = { type: 'diff', path: abs, oldText: c.type === 'created' ? null : c.beforeText, newText: c.afterText };
    if (!canWrite) {
      this.update(s, { sessionUpdate: 'tool_call', ...base, status: 'completed', content: [diff] });
      return;
    }

    this.update(s, { sessionUpdate: 'tool_call', ...base, status: 'in_progress', content: [diff] });
    try {
      // 1. Put the original back on disk, so the editor's baseline is the pre-agent version.
      if (c.type === 'created') await fs.rm(abs, { force: true });
      else await fs.writeFile(abs, c.before);
      // 2. Wait until the editor has reloaded the original (open buffers reload asynchronously).
      if (c.type === 'modified' && canRead) await this.waitForBuffer(s, abs, c.beforeText);
      // 3. Re-apply the agent's version through the editor: this is what makes it reviewable.
      await this.conn.request('fs/write_text_file', { sessionId: s.id, path: abs, content: c.afterText });
      this.update(s, { sessionUpdate: 'tool_call_update', toolCallId, status: 'completed' });
    } catch (err) {
      // Never lose the agent's work: put its version back on disk directly.
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, c.after);
      this.update(s, {
        sessionUpdate: 'tool_call_update',
        toolCallId,
        status: 'failed',
        content: [diff, ...textContent(`Could not route through the editor (${err.message}); change left on disk.`)],
      });
    }
  }

  async waitForBuffer(s, abs, expected) {
    const want = normalize(expected);
    const deadline = Date.now() + this.config.syncTimeoutMs;
    for (;;) {
      try {
        const { content } = await this.conn.request('fs/read_text_file', { sessionId: s.id, path: abs });
        if (typeof content === 'string' && normalize(content) === want) return true;
      } catch (err) {
        this.log(`read ${abs} failed:`, err.message);
      }
      if (Date.now() >= deadline) {
        this.log(`editor did not reload ${abs} within ${this.config.syncTimeoutMs} ms; writing anyway`);
        return false;
      }
      await sleep(100);
    }
  }

  async backup(s, c) {
    if (!c.before) return null;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(this.config.backupDir, stamp, path.basename(s.cwd), c.rel);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, c.before);
    return dest;
  }

  shutdown() {
    for (const s of this.sessions.values()) this.killChild(s);
  }
}
