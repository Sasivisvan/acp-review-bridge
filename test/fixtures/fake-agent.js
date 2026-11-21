#!/usr/bin/env node
// A stand-in for a real CLI coding agent, used by the end-to-end tests.
// The prompt is the last non-flag argument, or stdin if there is none.
import fs from 'node:fs';

const args = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith('--'));
const positional = args.filter((a) => !a.startsWith('--'));
const prompt = positional.length ? positional[positional.length - 1] : fs.readFileSync(0, 'utf8');

process.stdout.write(`\x1b[32mWorking on:\x1b[0m ${prompt}\nflags: ${JSON.stringify(flags)}\n`);
process.stderr.write('thinking...\n');

if (prompt.includes('sleep')) {
  process.on('SIGTERM', () => {
    fs.writeFileSync('partial.txt', 'written before cancel\n');
    process.exit(143);
  });
  setTimeout(() => {}, 30_000);
} else if (prompt.includes('edit')) {
  fs.writeFileSync('edit.txt', fs.readFileSync('edit.txt', 'utf8').replace('two', 'TWO'));
  fs.mkdirSync('src', { recursive: true });
  fs.writeFileSync('src/new.js', 'export const answer = 42;\n');
  fs.rmSync('gone.txt');
  fs.writeFileSync('image.bin', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
} else if (prompt.includes('fail')) {
  process.exit(3);
}
