// Watch mode: review changes made by ANY process (an agent in a terminal, a script, ...)
// while a "watch" prompt turn is running in the editor.
//
// The baseline for every file is its content when watching started ("before the AI's edit").
// Whenever a file settles in a state that differs from both its baseline and the state we
// last handled, the change is routed through the editor for inline Keep / Reject review.
//
// Writes made by the editor itself are recognised without guessing who wrote them:
//   - our own fs/write_text_file -> we record the resulting disk state as handled
//   - Reject (all hunks)         -> file is back at baseline        -> nothing to review
//   - partial Reject             -> re-routing it against the same baseline is idempotent:
//                                   the editor ends up with the same diff it already showed

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { listFiles, makeChange, readEntry, takeSnapshot } from './snapshot.js';

const signature = (st) => (st ? `${st.size}:${st.mtimeMs}` : 'missing');
const normalize = (s) => s.replace(/^\ufeff/, '').replace(/\r\n/g, '\n');

function contentKey(entry) {
  if (!entry) return 'missing';
  if (!entry.content) return `large:${entry.size}:${entry.mtimeMs}`;
  return createHash('sha1').update(entry.content).digest('hex');
}

async function statFile(abs) {
  try {
    const st = await fs.lstat(abs);
    return st.isFile() || st.isSymbolicLink() ? st : null;
  } catch {
    return null;
  }
}

/** Run a watch turn for session `s` until it is cancelled. */
export async function watchSession(bridge, s) {
  const { maxBytes, intervalMs } = bridge.config;
  const opts = { isIgnored: bridge.isIgnored, maxBytes };
  const fsCaps = bridge.clientCapabilities.fs ?? {};
  const canWrite = bridge.config.review && fsCaps.writeTextFile === true;
  const canRead = fsCaps.readTextFile === true;

  const baseline = await takeSnapshot(s.cwd, opts);
  const lastSeen = new Map(); // rel -> stat signature already processed
  for (const [rel, e] of baseline) lastSeen.set(rel, signature(e));
  const pending = new Map(); // rel -> signature seen on the previous tick (waiting to settle)
  const handled = new Map(); // rel -> content key of the state we last reviewed / reported
  const warnedDirty = new Set();

  bridge.say(
    s,
    `Watching \`${s.cwd}\` (${baseline.size} files) for changes.\n\n` +
      'Edit files with any agent or tool. Each change shows up here and in the editor with Keep / Reject. ' +
      'Press **Stop** to end watching.\n',
  );
  bridge.log(`watch: baseline of ${baseline.size} files, polling every ${intervalMs} ms`);

  const processFile = async (rel) => {
    const abs = path.join(s.cwd, rel);
    const base = baseline.get(rel) ?? null;
    const cur = await readEntry(s.cwd, rel, maxBytes);
    const key = contentKey(cur);

    if (handled.get(rel) === key) return true;
    if (key === contentKey(base)) {
      // Back to baseline: rejected in the editor, or the agent undid its change.
      handled.set(rel, key);
      return true;
    }
    if (!base && !cur) return true;

    const type = !cur ? 'deleted' : !base ? 'created' : 'modified';
    const change = makeChange(rel, type, base, cur, maxBytes);

    // Never touch a file that has unsaved edits in the editor: wait until it is saved.
    if (change.reviewable && canWrite && canRead) {
      try {
        const { content } = await bridge.conn.request('fs/read_text_file', { sessionId: s.id, path: abs });
        if (typeof content === 'string' && normalize(content) !== normalize(change.afterText)) {
          if (!warnedDirty.has(rel)) {
            warnedDirty.add(rel);
            bridge.log(`watch: ${rel} differs from the editor buffer (unsaved edits?), waiting`);
          }
          return false;
        }
      } catch {
        /* not openable in the editor: fall through */
      }
    }
    warnedDirty.delete(rel);

    await bridge.reviewChange(s, change, canWrite, canRead);
    // Record the disk state after routing (the editor may have formatted on save).
    handled.set(rel, contentKey(await readEntry(s.cwd, rel, maxBytes)));
    return true;
  };

  const tick = async () => {
    const files = await listFiles(s.cwd, bridge.isIgnored);
    const candidates = new Set([...files, ...baseline.keys(), ...handled.keys()]);
    for (const rel of candidates) {
      if (s.cancelled) return;
      const sig = signature(await statFile(path.join(s.cwd, rel)));
      if (lastSeen.get(rel) === sig) {
        pending.delete(rel);
        continue;
      }
      if (lastSeen.get(rel) === undefined && sig === 'missing') continue;
      // Wait until the file has stopped changing for one full interval.
      if (pending.get(rel) !== sig) {
        pending.set(rel, sig);
        continue;
      }
      pending.delete(rel);
      try {
        if (await processFile(rel)) lastSeen.set(rel, sig);
      } catch (err) {
        bridge.log(`watch: failed to process ${rel}:`, err);
        lastSeen.set(rel, sig);
      }
    }
  };

  while (!s.cancelled) {
    try {
      await tick();
    } catch (err) {
      bridge.log('watch: tick failed:', err);
    }
    if (s.cancelled) break;
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, intervalMs);
      s.wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    s.wake = null;
  }
  bridge.say(s, '\nStopped watching.\n');
}
