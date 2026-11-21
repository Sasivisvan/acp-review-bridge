# Contributing

Thanks for helping out! Bug reports, agent recipes and pull requests are all welcome.

## Setup

```sh
git clone https://github.com/Sasivisvan/acp-review-bridge.git
cd acp-review-bridge
npm test
```

There are no dependencies to install. The project uses only the Node.js standard library (Node 22+) and its built-in test runner.

## Ground rules

- **Stdout is the protocol.** Never write anything to stdout except ACP messages. Log with the `log` function, which goes to stderr.
- **Never lose the user's work.** Any failure while routing an edit through the editor must leave the agent's version on disk.
- **Keep it dependency-free** unless there's a very strong reason.
- Add or update tests in `test/` for every behaviour change. `test/bridge.test.js` drives the real CLI with a simulated editor client, and that's the place for end-to-end cases.

## Testing against Zed

1. Point an `agent_servers` entry at your checkout: `"command": "node", "args": ["/abs/path/bin/acp-review-bridge.js", "--verbose", "--", ...]`.
2. Open the ACP logs in Zed (`dev: open acp logs`) to see the traffic.
3. Reload the agent by starting a new thread after changing the code.

## Pull requests

- Keep PRs focused, and describe what you changed and how you tested it.
- Update `CHANGELOG.md` under **Unreleased**.
- Never commit secrets, API keys or personal config. `.gitignore` covers the usual suspects, but double-check `git diff --cached` before committing.
