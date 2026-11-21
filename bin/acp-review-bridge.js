#!/usr/bin/env node
// CLI entry point. Zed (or any ACP client) launches this over stdio.
// Stdout is reserved for ACP messages: all logging goes to stderr.

import { readFileSync } from 'node:fs';
import { Bridge, defaultBackupDir } from '../src/bridge.js';

console.log = console.error; // guard: a stray console.log must never corrupt the protocol stream

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const USAGE = `acp-review-bridge ${pkg.version}

Run a CLI coding agent as an ACP agent so every file it changes is reviewed
in the editor with inline Keep / Reject diffs.

Usage:
  acp-review-bridge [options] -- <agent command> [agent args...]

The literal argument {prompt} is replaced with the user's prompt. If it is
absent, the prompt is written to the agent's stdin instead.

Options:
  --name <title>           Display name shown in the editor (default: "<command> (reviewed)")
  --next-turn-arg <arg>    Extra argument for the 2nd+ prompt of a session, inserted
                           before {prompt} (repeatable), e.g. --next-turn-arg --continue
  --ignore <pattern>       Extra ignore pattern: "dir/", "*.ext" or "path/glob" (repeatable)
  --max-file-size <KB>     Larger files are applied directly, not reviewed (default: 1024)
  --output <markdown|code> Render agent stdout as markdown or as a code block (default: markdown)
  --sync-timeout <ms>      Wait for the editor to reload a reverted file (default: 2000)
  --backup-dir <dir>       Where deleted files are backed up (default: ${defaultBackupDir()})
  --no-review              Only show diffs in the thread; leave edits on disk untouched
  --verbose                Log diagnostics to stderr
  -h, --help               Show this help
  -v, --version            Show version

Example (Zed settings.json):
  "agent_servers": {
    "Aider (reviewed)": {
      "type": "custom",
      "command": "npx",
      "args": ["-y", "github:Sasivisvan/acp-review-bridge", "--",
               "aider", "--yes-always", "--no-auto-commits", "--no-pretty", "--message", "{prompt}"]
    }
  }
`;

function fail(msg) {
  process.stderr.write(`acp-review-bridge: ${msg}\n\nRun with --help for usage.\n`);
  process.exit(2);
}

function parse(argv) {
  const config = { nextTurnArgs: [], ignores: [], version: pkg.version };
  let verbose = false;
  let i = 0;
  const value = (flag) => {
    if (i + 1 >= argv.length) fail(`${flag} needs a value`);
    return argv[++i];
  };
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      config.command = argv.slice(i + 1);
      break;
    }
    switch (a) {
      case '-h':
      case '--help':
        process.stdout.write(USAGE);
        process.exit(0);
      // falls through (unreachable)
      case '-v':
      case '--version':
        process.stdout.write(`${pkg.version}\n`);
        process.exit(0);
      // falls through (unreachable)
      case '--name':
        config.title = value(a);
        break;
      case '--next-turn-arg':
        config.nextTurnArgs.push(value(a));
        break;
      case '--ignore':
        config.ignores.push(value(a));
        break;
      case '--max-file-size': {
        const kb = Number(value(a));
        if (!(kb > 0)) fail('--max-file-size must be a positive number of KB');
        config.maxBytes = kb * 1024;
        break;
      }
      case '--output': {
        const v = value(a);
        if (v !== 'markdown' && v !== 'code') fail('--output must be "markdown" or "code"');
        config.output = v;
        break;
      }
      case '--sync-timeout': {
        const ms = Number(value(a));
        if (!(ms >= 0)) fail('--sync-timeout must be a number of milliseconds');
        config.syncTimeoutMs = ms;
        break;
      }
      case '--backup-dir':
        config.backupDir = value(a);
        break;
      case '--no-review':
        config.review = false;
        break;
      case '--verbose':
        verbose = true;
        break;
      default:
        fail(`unknown option ${a} (put the agent command after "--")`);
    }
  }
  if (!config.command?.length) fail('missing agent command after "--"');
  config.title ??= `${config.command[0].split(/[\\/]/).pop()} (reviewed)`;
  return { config, verbose };
}

const { config, verbose } = parse(process.argv.slice(2));
const log = verbose ? (...a) => console.error('[acp-review-bridge]', ...a) : () => {};

const bridge = new Bridge({ input: process.stdin, output: process.stdout, config, log });
bridge.closed.then(() => process.exit(0));
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(sig, () => {
    bridge.shutdown();
    process.exit(0);
  });
}
