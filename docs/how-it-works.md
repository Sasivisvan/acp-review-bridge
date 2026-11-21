# How it works

## The problem

AI-first editors (Zed, Cursor, Antigravity, ...) show an agent's edits as inline diffs that you **Keep** or **Reject**. In Zed, that review is tied to the agent protocol. An ACP agent that edits a file through the editor (`fs/write_text_file`) has the edit recorded against the buffer's previous contents, and Zed offers Keep / Reject for it.

A plain CLI agent edits files on disk behind the editor's back. Zed just reloads the buffer, and there is nothing to review.

## The approach

`acp-review-bridge` is an ACP agent that wraps a CLI agent. It speaks ACP to Zed over stdio, runs the CLI agent as a subprocess, and turns the agent's disk writes into editor writes.

```
Zed (ACP client)                     acp-review-bridge                    CLI agent
────────────────                     ─────────────────                    ─────────
initialize  ───────────────────────▶ advertise capabilities
session/new {cwd} ─────────────────▶ create session
session/prompt ────────────────────▶ 1. snapshot workspace
                                     2. spawn agent ────────────────────▶ edits files on disk
            ◀── session/update ───── stream stdout (message) / stderr (thought)
                                                                     ◀── exits
                                     3. diff workspace vs snapshot
            ◀── session/update ───── tool_call (kind=edit, diff content)
                                     4a. restore original file on disk
fs/read_text_file ◀──────────────── 4b. poll until the buffer shows the original
fs/write_text_file ◀─────────────── 4c. re-apply the agent's version
  (Zed records an agent edit → inline Keep / Reject)
            ◀── session/update ───── tool_call_update (completed)
            ◀── result ───────────── {stopReason: "end_turn"}
```

### 1. Snapshot

Before each prompt, the bridge records the contents of every relevant file:

- In a git repo: `git ls-files --cached --others --exclude-standard`, so `.gitignore` is respected.
- Otherwise: a recursive walk.
- In both cases, the built-in ignore list (`node_modules/`, `venv/`, `.venv/`, `__pycache__/`, `target/`, `.git/`, ...) plus any `--ignore` patterns are skipped.

Files larger than `--max-file-size` are tracked by size and mtime only.

### 2. Run the agent

The command after `--` runs in the session's working directory. `{prompt}` is substituted with the flattened prompt text. If there's no placeholder, the prompt is sent on stdin.

- **stdout** is streamed as `agent_message_chunk`, with ANSI codes stripped.
- **stderr** is streamed as `agent_thought_chunk`, which Zed shows as collapsible "thinking".
- The agent runs in its own process group. `session/cancel` sends `SIGTERM` to the whole group, then `SIGKILL` after 3 s.

### 3. Diff

After the agent exits, or after a cancel, the workspace is listed and read again and compared byte-for-byte with the snapshot. The bridge always compares contents instead of trusting mtimes, because some filesystems have 1–2 s timestamp granularity.

### 4. Route through the editor

For each reviewable change (a text file under the size limit, modified or created):

1. **Restore**: write the original bytes back (or remove a newly created file).
2. **Sync**: if Zed has the file open, its buffer reloads asynchronously. The bridge polls `fs/read_text_file` (which returns buffer contents, including unsaved ones) until it matches the original, for up to `--sync-timeout` ms. Line endings and BOM are normalised before comparing.
3. **Re-apply**: send the agent's version with `fs/write_text_file`. Zed applies it to the buffer as an agent edit, which produces the inline diff and Keep / Reject.

If anything fails, the agent's version is written straight back to disk and the tool call is marked `failed`, so no work is lost.

If the client doesn't advertise `fs.writeTextFile` (or you pass `--no-review`), the bridge only reports the diffs as tool-call content and leaves the edits on disk.

### Deletions, binaries, large files

ACP has no file-delete or binary-write method, so these changes stay as the agent left them and are reported in the thread. Deleted files are first copied to the backup directory (`$XDG_STATE_HOME/acp-review-bridge/backups/<timestamp>/<project>/<path>`).

## Watch mode

With `--watch`, there is no wrapped command. A prompt starts a long-running turn that polls the workspace (default every 700 ms):

1. **Baseline**: when watching starts, every file is snapshotted. That's the "before" for the whole round.
2. **Settle**: a file is processed only once its size and mtime have stayed the same for one full interval, so half-written files are never reviewed.
3. **Classify** the settled content:
   - equal to the baseline → nothing to review. This covers a **Reject** in the editor, or the agent undoing its own change.
   - equal to the state we last handled → nothing new. This covers our own `fs/write_text_file`, including format-on-save.
   - otherwise → route it with the same restore → sync → re-apply steps as run mode, against the **baseline**.
4. **Dirty-buffer guard**: before touching a file, the bridge reads the editor's buffer. If it differs from disk (unsaved edits), the file is left alone and retried once it's saved.
5. **Open**: each routed file is opened with `--open-with` (default `zeditor`/`zed`) at the first changed line, so it pops up in the editor.

Partial rejects are safe. The file is then neither at the baseline nor at the last handled state, so it is routed again against the same baseline. That reproduces exactly the diff the editor already shows (Zed's action log keeps conflicting "user" edits out of its baseline), so the review state doesn't change.

Watching relies on Zed keeping Keep / Reject available while a turn is running. Zed's thread view currently always enables them.

## Protocol details

- Transport: newline-delimited JSON-RPC 2.0 on stdio. Stdout carries only protocol messages, and all logging goes to stderr.
- `initialize` → `protocolVersion: 1`, `loadSession: false`, `promptCapabilities: { image: false, audio: false, embeddedContext: false }`, `authMethods: []`. Because embedded context is not advertised, Zed sends `@mentions` as `resource_link`s, which become `@relative/path` in the prompt. That keeps command lines short.
- One prompt at a time per session. A second concurrent `session/prompt` is rejected.

## Source map

| File | Role |
| --- | --- |
| `bin/acp-review-bridge.js` | CLI parsing, process lifecycle |
| `src/bridge.js` | ACP agent: sessions, running the agent, review routing, opening files |
| `src/watch.js` | Watch mode: polling, settle, classify, dirty-buffer guard |
| `src/snapshot.js` | File discovery, ignore rules, snapshot and diff |
| `src/jsonrpc.js` | JSON-RPC 2.0 peer over newline-delimited streams |
| `src/text.js` | ANSI stripping, prompt flattening |
