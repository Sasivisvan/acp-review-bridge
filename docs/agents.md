# Agent recipes

Each recipe is an entry for the `agent_servers` section of Zed's `settings.json`. The bridge part is the same every time:

```jsonc
"command": "npx",
"args": ["-y", "github:Sasivisvan/acp-review-bridge", /* bridge options */ "--", /* agent command */]
```

> CLI flags change between agent versions. If a recipe doesn't work, check the agent's `--help` for its *non-interactive / one-shot* mode and its *auto-approve* flag. The bridge needs the agent to do its work and exit without asking questions.

Prefer running from a clone? Replace the first two args with the path to the script:

```jsonc
"command": "node",
"args": ["/path/to/acp-review-bridge/bin/acp-review-bridge.js", "--", /* agent command */]
```

## Aider

[Aider](https://aider.chat) has no ACP support of its own, which makes it the main use case.

```jsonc
"Aider (reviewed)": {
  "type": "custom",
  "command": "npx",
  "args": [
    "-y", "github:Sasivisvan/acp-review-bridge",
    "--next-turn-arg", "--restore-chat-history",
    "--",
    "aider", "--yes-always", "--no-auto-commits", "--no-pretty", "--no-stream",
    "--message", "{prompt}"
  ],
  "env": { "AIDER_MODEL": "sonnet" }
}
```

- `--no-auto-commits` matters. Without it, Aider commits every change before you've had a chance to review it.
- `--restore-chat-history` on later turns gives Aider memory of the thread.
- Aider's own files (`.aider*`) are ignored automatically.
- Put API keys in your shell environment or in Aider's own config file. **Don't** paste keys into `settings.json` if you sync or share it.

## Claude Code (print mode)

Zed already supports Claude Code natively. This recipe is only useful if you specifically want snapshot-based review of everything the agent touches, including files changed by shell commands it runs.

```jsonc
"Claude (snapshot review)": {
  "type": "custom",
  "command": "npx",
  "args": [
    "-y", "github:Sasivisvan/acp-review-bridge",
    "--next-turn-arg", "--continue",
    "--",
    "claude", "-p", "--permission-mode", "acceptEdits", "{prompt}"
  ]
}
```

## Codex CLI (exec mode)

```jsonc
"Codex (snapshot review)": {
  "type": "custom",
  "command": "npx",
  "args": ["-y", "github:Sasivisvan/acp-review-bridge", "--", "codex", "exec", "--full-auto", "{prompt}"]
}
```

## Your own script

Anything that reads a prompt and edits files works. For example, `my-agent.py` reads the prompt from stdin:

```jsonc
"My agent": {
  "type": "custom",
  "command": "npx",
  "args": ["-y", "github:Sasivisvan/acp-review-bridge", "--output", "code", "--", "python3", "/path/to/my-agent.py"]
}
```

With no `{prompt}` placeholder, the prompt is written to the script's stdin. Whatever the script prints to stdout shows up in the Agent Panel, and stderr shows up as "thinking".

## Troubleshooting

- **Nothing happens / agent not found**: Zed may not inherit your shell's `PATH`. Use an absolute path for the agent command, or set `PATH` in the entry's `env`.
- **Changes appear but aren't reviewable**: check Zed's ACP logs (command palette → `dev: open acp logs`) and run the bridge with `--verbose`. If the client doesn't advertise `fs.writeTextFile`, the bridge falls back to reporting diffs only.
- **Agent hangs**: it's probably waiting for interactive input. Add its auto-approve / non-interactive flags.
