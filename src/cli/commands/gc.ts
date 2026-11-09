/**
 * cortex CLI — `cortex gc`
 *
 * Delete checkpoint files a process no longer needs: every `.csnap` except
 * the newest one in that process's checkpoint directory. The newest stays,
 * so `cortex restore` of the latest snapshot still works.
 *
 * The command prints the plan and deletes nothing until `--apply`.
 * Syscall logs are left in place. A replay reads them.
 */

import { readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { defaultKernelDir } from '../index.js';
import { chooseCheckpointKeep, type GcFile } from '../gc.js';

export async function cmdGc(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      apply: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    console.log(`cortex gc — drop checkpoint files older than the newest one

USAGE
  cortex gc [--apply]

OPTIONS
  --apply      Delete the files. Without it, the command only prints them.
  -h, --help   Show this help

NOTES
  Each process keeps its newest .csnap. Older snapshots in that process's
  checkpoint directory are the ones removed. Syscall logs are not removed.
`);
    return 0;
  }

  const root = join(defaultKernelDir(), 'processes');
  let dirs: string[] = [];
  try {
    dirs = await readdir(root);
  } catch {
    console.log('nothing to collect');
    return 0;
  }

  const drops: string[] = [];
  let kept = 0;
  for (const name of dirs) {
    const dir = join(root, name, 'checkpoints');
    let names: string[] = [];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    const files: GcFile[] = [];
    for (const file of names) {
      if (!file.endsWith('.csnap')) continue;
      const path = join(dir, file);
      const info = await stat(path);
      files.push({ path, mtimeMs: info.mtimeMs });
    }
    const choice = chooseCheckpointKeep(files);
    if (choice.keep !== null) kept += 1;
    for (const file of choice.drop) drops.push(file.path);
  }

  if (drops.length === 0) {
    console.log(`nothing to collect (${kept} checkpoint${kept === 1 ? '' : 's'} kept)`);
    return 0;
  }

  for (const path of drops) console.log(values.apply ? `remove ${path}` : `would remove ${path}`);
  if (!values.apply) {
    console.log(`${drops.length} old checkpoint${drops.length === 1 ? '' : 's'}; pass --apply to delete them`);
    return 0;
  }
  for (const path of drops) await unlink(path);
  console.log(`removed ${drops.length}, kept ${kept}`);
  return 0;
}
