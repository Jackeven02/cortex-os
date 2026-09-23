/**
 * cortex CLI — `cortex example`
 *
 * Runs one of the agent modules bundled with the package.
 *
 * ## Why this command exists
 *
 * The READMEs used to tell npm users to run
 * `cortex spawn --role planner --module ./examples/supervision-tree.ts`.
 * That was never true after `npm i -g`: `--module` is resolved against the
 * **current working directory**, and an installed package does not drop an
 * `examples/` folder there. Worse, Node refuses to type-strip `.ts` files
 * under `node_modules` ("Stripping types is currently unsupported for files
 * under node_modules"), so even pointing at the packaged `.ts` sources
 * failed with `code 127: agent load failed`.
 *
 * So this command resolves the **compiled** `dist/examples/*.js` relative to
 * the package itself and forwards to `spawn`. One command, no paths, no
 * Node-version caveats:
 *
 *   cortex example hello
 *   cortex example supervision-tree
 *
 * @module cli/commands/example
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { cmdSpawn } from './spawn.js';

/**
 * A bundled example. `name` is the module file stem (`<name>.js`); `aliases`
 * are the shorter things a human actually types.
 */
interface BundledExample {
  readonly name: string;
  readonly aliases: readonly string[];
  readonly role: string;
  readonly blurb: string;
}

/**
 * The catalogue. Kept explicit rather than globbed: the role is part of the
 * demo (a "planner" that spawns "coder" children reads wrong as "demo"), and
 * a hand-written blurb is what makes `cortex example` with no args useful.
 */
const EXAMPLES: readonly BundledExample[] = [
  { name: 'hello-agent', aliases: ['hello'], role: 'hello', blurb: 'the smallest agent: one LLM call, one memory write' },
  { name: 'supervision-tree', aliases: ['supervisor', 'demo-a'], role: 'planner', blurb: 'Demo A — a planner supervises 3 children, kills the one that hangs' },
  { name: 'checkpoint-agent', aliases: ['checkpoint', 'demo-b'], role: 'inbox-watcher', blurb: 'Demo B — pause mid-run, survive a reboot, resume on a new PID' },
  { name: 'fork-compare-agent', aliases: ['fork', 'demo-c'], role: 'demo', blurb: 'Demo C — fork two strategies, then `cortex diff` them' },
  { name: 'capabilities-agent', aliases: ['caps'], role: 'demo', blurb: 'least privilege: same module, three different capability sets' },
  { name: 'mcp-agent', aliases: ['mcp'], role: 'agent', blurb: 'drive a real MCP server; needs CORTEX_MCP_COMMAND (see below)' },
];

/**
 * Resolve the directory holding the runnable examples.
 *
 * Two layouts, because the CLI runs both from source (`tsx src/cli/index.ts`)
 * and from the published build (`dist/cli/index.js`):
 *
 *   dist/cli/commands/example.js  ->  <pkg>/dist/examples   (compiled .js)
 *   src/cli/commands/example.ts   ->  <repo>/examples       (.ts, via tsx)
 *
 * The compiled directory wins when both exist — it is what ships, and it is
 * what works on every Node in `engines`, without type stripping.
 */
function examplesDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, '..', '..', 'examples'), // dist/cli/commands -> dist/examples
    join(here, '..', '..', '..', 'examples'), // src/cli/commands  -> examples
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  // Nothing found: still return the published-layout path so the error the
  // user sees names the file we expected, not a null.
  return candidates[0]!;
}

/** Find an example by its module name or any alias. */
function findExample(name: string): BundledExample | undefined {
  return EXAMPLES.find((e) => e.name === name || e.aliases.includes(name));
}

/** True if the user already supplied `--role`, so we must not prepend ours. */
function hasRoleArg(args: readonly string[]): boolean {
  return args.some((a) => a === '--role' || a.startsWith('--role='));
}

export async function cmdExample(args: string[]): Promise<number> {
  // `cortex example` / `cortex example --help` / `-h`: list them.
  const first = args[0];
  if (first === undefined || first === '--help' || first === '-h' || first === 'list') {
    printExampleHelp();
    return 0;
  }

  const ex = findExample(first);
  if (ex === undefined) {
    console.error(`cortex example: unknown example '${first}'`);
    console.error(`run \`cortex example\` to list the bundled examples.`);
    return 1;
  }

  const dir = examplesDir();
  const modulePath = join(dir, `${ex.name}.js`);
  if (!existsSync(modulePath)) {
    console.error(`cortex example: '${ex.name}' is not installed at ${modulePath}`);
    console.error('(a published package ships dist/examples/*.js; did you build with `npm run build`?)');
    return 1;
  }

  // Forward to spawn, defaulting the role and pinning the module path.
  // Everything the user passes after the name is a spawn flag, so
  // `--cap tool:dangerous`, `-t 60000` and `--memory '{...}'` all work.
  const rest = args.slice(1);
  const spawnArgs = [
    ...(hasRoleArg(rest) ? [] : ['--role', ex.role]),
    '--module',
    modulePath,
    ...rest,
  ];
  return await cmdSpawn(spawnArgs);
}

function printExampleHelp(): void {
  console.log(`cortex example — run an agent module bundled with cortex

USAGE
  cortex example <name> [spawn options]

EXAMPLES`);
  for (const e of EXAMPLES) {
    const keys = [e.name, ...e.aliases].join(', ');
    console.log(`  ${keys.padEnd(30)}  ${e.blurb}`);
  }
  console.log(`
NOTES
  Each name carries a default --role; pass your own to override it.
  Everything after the name is forwarded to \`cortex spawn\`, so
  --cap, --grantable, --memory, --timeout and friends all apply.

  cortex example hello
  cortex example supervision-tree
  cortex example capabilities-agent --cap tool:dangerous --grantable spawn
  cortex example fork-compare-agent            # then: cortex diff <pidA> <pidB>
  cortex example checkpoint-agent              # then: cortex restore --tag inbox-watcher

  mcp-agent needs a server mounted first:
    CORTEX_MCP_COMMAND=node CORTEX_MCP_ARGS="./.demo/echo-server.js" \\
      cortex example mcp-agent

  State is written to $CORTEX_HOME (default ./.cortex), so the follow-up
  commands above work in later invocations.
`);
}
