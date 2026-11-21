// Workspace snapshots: capture every relevant file before the agent runs, then diff afterwards.
//
// File discovery uses `git ls-files` when the workspace is a git repo (so .gitignore is
// respected for free) and falls back to a directory walk otherwise. A built-in ignore list
// keeps dependency folders such as node_modules/ and venv/ out of the review either way.

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export const DEFAULT_IGNORES = [
  '.git/',
  'node_modules/',
  'venv/',
  '.venv/',
  'env/',
  '__pycache__/',
  '.mypy_cache/',
  '.pytest_cache/',
  '.ruff_cache/',
  '.tox/',
  'target/',
  '.next/',
  '.gradle/',
  '*.pyc',
  '.DS_Store',
  // Agent bookkeeping files that would only add noise to a review.
  '.aider*',
];

export const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;
const MAX_FILES = 50_000;

/** gitignore-flavoured matching: `dir/` matches a directory anywhere, `*.ext` a basename, `a/b*` a path. */
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

export function makeIgnoreMatcher(patterns) {
  const dirs = [];
  const names = [];
  const paths = [];
  for (const raw of patterns) {
    const p = raw.trim();
    if (!p || p.startsWith('#')) continue;
    if (p.endsWith('/')) dirs.push(globToRegExp(p.slice(0, -1)));
    else if (p.includes('/')) paths.push(globToRegExp(p.replace(/^\//, '')));
    else names.push(globToRegExp(p));
  }
  return (rel) => {
    const parts = rel.split('/');
    const base = parts[parts.length - 1];
    if (parts.slice(0, -1).some((seg) => dirs.some((r) => r.test(seg)))) return true;
    if (names.some((r) => r.test(base))) return true;
    return paths.some((r) => r.test(rel));
  };
}

function git(cwd, args) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, maxBuffer: 256 * 1024 * 1024, encoding: 'buffer' }, (err, stdout) =>
      err ? reject(err) : resolve(stdout),
    );
  });
}

async function walk(root, rel, isIgnored, out) {
  let entries;
  try {
    entries = await fs.readdir(path.join(root, rel), { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (out.length >= MAX_FILES) return;
    const childRel = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (!isIgnored(`${childRel}/x`)) await walk(root, childRel, isIgnored, out);
    } else if ((e.isFile() || e.isSymbolicLink()) && !isIgnored(childRel)) {
      out.push(childRel);
    }
  }
}

/** List workspace files (relative, `/`-separated) that should be watched for changes. */
export async function listFiles(root, isIgnored) {
  try {
    const out = await git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
    const files = [...new Set(out.toString('utf8').split('\0').filter(Boolean))];
    return files.filter((f) => !isIgnored(f)).slice(0, MAX_FILES);
  } catch {
    const files = [];
    await walk(root, '', isIgnored, files);
    return files;
  }
}

async function readEntry(root, rel, maxBytes) {
  const abs = path.join(root, rel);
  let st;
  try {
    st = await fs.lstat(abs);
  } catch {
    return null;
  }
  if (st.isSymbolicLink()) {
    return { size: st.size, mtimeMs: st.mtimeMs, content: Buffer.from(`symlink:${await fs.readlink(abs)}`), symlink: true };
  }
  if (!st.isFile()) return null;
  const entry = { size: st.size, mtimeMs: st.mtimeMs, content: null };
  if (st.size <= maxBytes) {
    try {
      entry.content = await fs.readFile(abs);
    } catch {
      return null;
    }
  }
  return entry;
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i]);
      }
    }),
  );
  return results;
}

/**
 * Snapshot the workspace.
 * @returns {Promise<Map<string, {size:number, mtimeMs:number, content:Buffer|null, symlink?:boolean}>>}
 */
export async function takeSnapshot(root, { isIgnored, maxBytes = DEFAULT_MAX_FILE_BYTES }) {
  const files = await listFiles(root, isIgnored);
  const entries = await mapLimit(files, 32, (rel) => readEntry(root, rel, maxBytes));
  const snap = new Map();
  files.forEach((rel, i) => entries[i] && snap.set(rel, entries[i]));
  return snap;
}

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** Decode a buffer as UTF-8 text, or return null if it looks binary. */
export function decodeText(buf) {
  if (buf === null) return null;
  if (buf.subarray(0, 8000).includes(0)) return null;
  try {
    return utf8.decode(buf);
  } catch {
    return null;
  }
}

/**
 * Compare a previous snapshot with the current workspace.
 *
 * @returns {Promise<Array<{
 *   rel: string, type: 'created'|'modified'|'deleted',
 *   before: Buffer|null, after: Buffer|null,
 *   beforeText: string|null, afterText: string|null,
 *   reviewable: boolean, reason?: string
 * }>>}
 */
export async function diffSnapshot(root, before, { isIgnored, maxBytes = DEFAULT_MAX_FILE_BYTES }) {
  const files = await listFiles(root, isIgnored);
  const seen = new Set(files);
  const changes = [];

  // Always re-read: mtime granularity can be coarse (1-2 s on some filesystems), and a
  // same-size edit inside that window would otherwise be missed.
  const afterEntries = await mapLimit(files, 32, (rel) => readEntry(root, rel, maxBytes));

  files.forEach((rel, i) => {
    const prev = before.get(rel);
    const cur = afterEntries[i];
    if (!cur) {
      if (prev) changes.push(makeChange(rel, 'deleted', prev, null, maxBytes));
      return;
    }
    if (!prev) {
      changes.push(makeChange(rel, 'created', null, cur, maxBytes));
      return;
    }
    const same =
      prev.content !== null && cur.content !== null
        ? prev.content.equals(cur.content)
        : prev.size === cur.size && prev.mtimeMs === cur.mtimeMs;
    if (!same) changes.push(makeChange(rel, 'modified', prev, cur, maxBytes));
  });

  for (const [rel, prev] of before) {
    if (!seen.has(rel)) {
      // Not listed any more: deleted, or became ignored. Only report real deletions.
      try {
        await fs.lstat(path.join(root, rel));
      } catch {
        changes.push(makeChange(rel, 'deleted', prev, null, maxBytes));
      }
    }
  }

  changes.sort((a, b) => a.rel.localeCompare(b.rel));
  return changes;
}

function makeChange(rel, type, prev, cur, maxBytes) {
  const beforeBuf = prev?.content ?? null;
  const afterBuf = cur?.content ?? null;
  const change = {
    rel,
    type,
    before: beforeBuf,
    after: afterBuf,
    beforeText: decodeText(beforeBuf),
    afterText: decodeText(afterBuf),
    reviewable: true,
  };
  if (prev?.symlink || cur?.symlink) {
    change.reviewable = false;
    change.reason = 'symbolic link';
  } else if ((prev && prev.content === null) || (cur && cur.content === null)) {
    change.reviewable = false;
    change.reason = `larger than ${Math.round(maxBytes / 1024)} KB`;
  } else if ((prev && change.beforeText === null) || (cur && change.afterText === null)) {
    change.reviewable = false;
    change.reason = 'binary file';
  } else if (type === 'deleted') {
    change.reviewable = false;
    change.reason = 'deletions cannot be routed through ACP';
  }
  return change;
}
