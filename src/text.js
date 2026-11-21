import path from 'node:path';
import { fileURLToPath } from 'node:url';

// CSI sequences, OSC sequences (BEL or ST terminated), DCS/PM/APC strings and lone ESC codes.
const ANSI_RE =
  // eslint-disable-next-line no-control-regex
  /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[PX^_][^\x1b]*\x1b\\|\x1b[@-Z\\-_]/g;

/** Remove terminal colour / cursor escape codes and carriage-return redraws. */
export function stripAnsi(text) {
  return text.replace(ANSI_RE, '').replace(/\r\n/g, '\n').replace(/\r/g, '');
}

function uriToDisplayPath(uri, cwd) {
  if (!uri.startsWith('file://')) return uri;
  try {
    const abs = fileURLToPath(uri);
    const rel = path.relative(cwd, abs);
    return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : abs;
  } catch {
    return uri;
  }
}

/**
 * Flatten an ACP prompt (array of content blocks) into a plain-text prompt for a CLI agent.
 * Mentioned files become `@relative/path`; embedded text resources are inlined in fences.
 */
export function promptToText(blocks, cwd) {
  const parts = [];
  for (const block of blocks ?? []) {
    switch (block?.type) {
      case 'text':
        parts.push(block.text);
        break;
      case 'resource_link':
        parts.push(`@${uriToDisplayPath(block.uri, cwd)}`);
        break;
      case 'resource': {
        const r = block.resource ?? {};
        const where = uriToDisplayPath(r.uri ?? 'resource', cwd);
        if (typeof r.text === 'string') parts.push(`\n${where}:\n\`\`\`\n${r.text}\n\`\`\`\n`);
        else parts.push(`@${where}`);
        break;
      }
      default:
        // image / audio are not advertised, so a compliant client never sends them.
        break;
    }
  }
  return parts.join(' ').replace(/ +\n/g, '\n').trim();
}
