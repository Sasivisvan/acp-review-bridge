# acp-review-bridge

[![CI](https://github.com/Sasivisvan/acp-review-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/Sasivisvan/acp-review-bridge/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**Run any CLI coding agent inside [Zed](https://zed.dev) and review every file it changes with inline Keep / Reject diffs, the same experience as Zed's built-in agent, Cursor or Antigravity.**

Many good coding agents (Aider, home-grown scripts, local-model tools, ...) only run in a terminal. When they edit your files you get no review step: the changes are just there. `acp-review-bridge` wraps such an agent in the [Agent Client Protocol](https://agentclientprotocol.com) (ACP) so Zed can drive it from the Agent Panel, and it hands every edit to Zed as a reviewable change:

```
 You type a prompt in Zed's Agent Panel
          │
          ▼
 acp-review-bridge ── snapshot ──▶ runs your CLI agent ──▶ agent edits files
          │
          ▼
 for each changed file: restore original ─▶ re-apply via Zed (fs/write_text_file)
          │
          ▼
 Zed highlights the change (green = added, red = removed) → Keep or Reject
```

It has two modes:

| Mode | You... | Good for |
| --- | --- | --- |
| **Watch** (`--watch`) | keep using your agent in the terminal, as usual | Claude Code on a subscription, Aider, any agent or script, even ones Zed can't launch |
| **Run** (`-- <command>`) | type prompts in Zed's Agent Panel; the bridge runs the agent | One-shot CLI agents you want to drive from inside Zed |

- ✅ **Watch mode:** any change made in the project by any process pops open in Zed with inline Keep / Reject
- ✅ Works with **any** CLI agent that edits files: the prompt goes in as an argument or on stdin
- ✅ Native Zed review: inline diffs, Keep / Reject, per-file and per-hunk
- ✅ The baseline is the file **as it was right before the agent's turn**
- ✅ Ignores `node_modules/`, `venv/`, `.git/`, `__pycache__/` and everything in `.gitignore`
- ✅ Agent output streams into the panel; cancelling the turn stops the agent
- ✅ Deleted files are backed up before you lose them
- ✅ Zero dependencies: a single Node.js package

> **Already using Claude Code, Gemini CLI or Codex?** Those have native ACP integrations in Zed with their own review flow. Use them directly. This bridge is for agents **without** ACP support, or when you want snapshot-based review of *everything* an agent touches.

## Requirements

- Node.js 22 or newer
- Zed with external-agent (ACP) support
- Linux or macOS (Windows is untested)

## Quick start: watch mode (agent in your terminal)

Use this when your agent runs in a terminal. For example, Claude Code on a Pro/Max subscription, where Zed would otherwise ask for an API key.

**1.** Add this to Zed's settings (`zed: open settings`):

```jsonc
{
  "agent_servers": {
    "Watch changes": {
      "type": "custom",
      "command": "npx",
      "args": ["-y", "github:Sasivisvan/acp-review-bridge", "--watch"]
    }
  }
}
```

**2.** In Zed, open your project. In the Agent Panel, start a new thread with **Watch changes** and send any message (e.g. `go`). The bridge snapshots the project and starts watching.

**3.** Work with your agent in a terminal as usual. Every file it changes **opens in Zed automatically** with the change highlighted (green = added, red = removed) and **Keep / Reject** buttons. You can review while the agent keeps working. Press **Stop** in the Agent Panel to end watching, and send another message to start a fresh round.

Watch mode can't tell *who* changed a file, so your own edits saved from Zed are also shown for review: just Keep them. Files with unsaved edits in Zed are never touched.

## Quick start: run mode

**1. Get the bridge.** There's no install step: Zed can launch it straight from GitHub with `npx`. Or clone it:

```sh
git clone https://github.com/Sasivisvan/acp-review-bridge.git
cd acp-review-bridge && npm test   # optional: run the test suite
```

**2. Add an agent to Zed.** Open Zed's settings (`zed: open settings`) and add an entry under `agent_servers`. This example wraps [Aider](https://aider.chat):

```jsonc
{
  "agent_servers": {
    "Aider (reviewed)": {
      "type": "custom",
      "command": "npx",
      "args": [
        "-y", "github:Sasivisvan/acp-review-bridge",
        "--next-turn-arg", "--restore-chat-history",
        "--",
        "aider", "--yes-always", "--no-auto-commits", "--no-pretty", "--no-stream",
        "--message", "{prompt}"
      ]
    }
  }
}
```

If you cloned the repo, use `"command": "node"` and put the path to `bin/acp-review-bridge.js` first in `args`.

**3. Use it.** Open the Agent Panel, start a new thread with **Aider (reviewed)**, and ask for a change. When the agent finishes, every edited file shows up as a reviewable agent change: accept with **Keep** or undo with **Reject**.

More agent recipes (Claude Code, Codex, plain scripts, ...) are in [docs/agents.md](docs/agents.md).

## How the command is built

Everything after `--` is the agent's command line:

| You write | What runs on each prompt |
| --- | --- |
| `-- mytool --message {prompt}` | `mytool --message "<prompt text>"` |
| `-- mytool` (no `{prompt}`) | `mytool`, with the prompt written to **stdin** |
| `--next-turn-arg --continue -- mytool {prompt}` | 1st prompt: `mytool "<text>"`, later prompts: `mytool --continue "<text>"` |

Each prompt runs the agent once, non-interactively, in the project root. Files you `@mention` in Zed are passed as `@relative/path`.

## Options

| Option | Default | Description |
| --- | --- | --- |
| `--watch` |  | Watch mode: review changes made by any process (no agent command) |
| `--interval <ms>` | `700` | Watch mode polling interval |
| `--open-with <command>` | `zeditor` or `zed` if on PATH | Open each changed file with `<command> <path>:<line>` |
| `--no-open` |  | Don't open changed files automatically |
| `--name <title>` | `<command> (reviewed)` | Name shown in Zed |
| `--next-turn-arg <arg>` |  | Extra arg for the 2nd+ prompt of a thread, inserted before `{prompt}` (repeatable) |
| `--ignore <pattern>` |  | Extra ignore pattern: `dir/`, `*.ext` or `path/glob` (repeatable) |
| `--max-file-size <KB>` | `1024` | Larger files are applied directly instead of reviewed |
| `--output <markdown\|code>` | `markdown` | Render agent output as markdown or as a code block |
| `--sync-timeout <ms>` | `2000` | How long to wait for Zed to reload a restored file |
| `--backup-dir <dir>` | `~/.local/state/acp-review-bridge/backups` | Where deleted files are backed up |
| `--no-review` |  | Show diffs in the thread only; leave edits on disk |
| `--verbose` |  | Diagnostics on stderr (visible in Zed's ACP logs) |

## What gets reviewed

| Change | Result |
| --- | --- |
| Text file modified | Inline review in Zed (Keep / Reject) |
| Text file created | Inline review; Reject removes the file |
| File deleted | Applied directly, contents backed up, reported in the thread |
| Binary, symlink or file over `--max-file-size` | Applied directly and reported in the thread |
| Anything ignored (`.gitignore`, `node_modules/`, `venv/`, ...) | Not tracked |

ACP has no "delete file" operation, which is why deletions can't be reviewed inline.

## How it works

See [docs/how-it-works.md](docs/how-it-works.md) for the full design. In short, Zed only offers Keep / Reject for edits that an agent makes *through Zed*, using ACP's `fs/write_text_file`. A CLI agent writes straight to disk, so after it exits the bridge:

1. diffs the workspace against the snapshot it took before the turn,
2. puts each changed file back to its original content,
3. waits until Zed's buffer shows the original again (it polls `fs/read_text_file`),
4. writes the agent's version back through `fs/write_text_file`.

Zed now records the change as an agent edit, against the pre-agent baseline. If any step fails, the agent's version is written straight back to disk, so work is never lost.

## Limitations

- **Watch mode:** if a file is reviewed, you **Keep** it, and the agent then edits the same file again, the earlier kept hunks show up again as well. The baseline is the snapshot taken when watching started. Stop and restart watching to reset the baseline.
- **Watch mode:** edits you save from Zed itself are indistinguishable from an agent's and are shown for review too.
- **Run mode:** the agent runs **once per prompt**, non-interactively. Interactive prompts inside the agent (y/n questions) aren't forwarded, so use the agent's "yes to all" or non-interactive flags.
- Conversation memory between prompts depends on the agent (see `--next-turn-arg`).
- Review happens **after** the agent finishes its turn, not edit by edit.
- If you edit a file in Zed *while* the agent is working on the same file, your unsaved changes and the agent's can conflict.
- MCP servers configured in Zed are not forwarded to the wrapped agent.

## Development

```sh
npm test              # unit + end-to-end tests (Node's built-in test runner)
node bin/acp-review-bridge.js --help
```

The end-to-end tests launch the real CLI and drive it with a simulated ACP client that behaves like an editor. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
