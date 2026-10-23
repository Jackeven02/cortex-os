/**
 * cortex CLI — the live-kernel endpoint descriptor.
 *
 * docs/ARCHITECTURE.md §12.1 asked how the CLI talks to a running kernel and
 * answered with an instinct: *"localhost TCP on a port written to
 * `.cortex/kernel.json`"*. This file is that answer, and the file it names.
 *
 * ## Why a descriptor file and not a fixed port
 *
 * A fixed port is the first thing that breaks. Two kernels on one machine
 * (docs/ARCHITECTURE.md §12.2 wants one per project directory) would fight
 * over it, and a stale port would point a CLI at somebody else's kernel. The
 * descriptor is per-kernel-directory, so the *directory* is the address and
 * the port can be ephemeral — the kernel asks the OS for a free one and
 * publishes what it got.
 *
 * ## The token
 *
 * A TCP port on 127.0.0.1 is reachable by every user on the machine, and the
 * commands behind it are not read-only: `kill` delivers a real signal and
 * `send` injects a message into a running agent. So every request carries a
 * per-kernel random token, and the server rejects anything that does not
 * match.
 *
 * The token lives in the same file as the port, in the same directory as the
 * `.crec` logs — so the guarantee it buys is "a different local user cannot
 * guess the port and drive your kernel", not "a different local user cannot
 * read your home directory". That is the honest scope: the token protects
 * the same trust boundary as the rest of `.cortex/`, and no further.
 *
 * @module cli/kernel_endpoint
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * How a client reaches a live kernel.
 *
 * Written by the kernel process when it starts serving, read by every CLI
 * invocation that wants to act on that kernel rather than on the files it
 * left behind.
 */
export interface KernelEndpoint {
  /** The interface the server bound. `127.0.0.1` — never a public one. */
  readonly host: string;
  /** The TCP port the server bound. */
  readonly port: number;
  /** The OS process id of the kernel process. */
  readonly pid: number;
  /** Per-kernel shared secret; every request must present it. */
  readonly token: string;
  /** ISO timestamp of when the kernel started serving. */
  readonly startedAt: string;
  /** The kernel ABI version the server speaks. */
  readonly abiVersion: string;
  /** The kernel's state directory (the one this file lives in). */
  readonly dir: string;
}

/** Where the endpoint descriptor lives inside a kernel directory. */
export function endpointPath(dir: string): string {
  return join(dir, 'kernel.json');
}

/**
 * Publish the endpoint descriptor.
 *
 * Written to a temporary file and renamed into place, so a client that reads
 * the descriptor concurrently sees either the old file or the new one — never
 * a half-written one. (On Windows the rename replaces the destination.)
 */
export function writeEndpoint(dir: string, endpoint: KernelEndpoint): void {
  mkdirSync(dir, { recursive: true });
  const path = endpointPath(dir);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(endpoint, null, 2)}\n`, 'utf8');
  renameSync(tmp, path);
}

/**
 * Read the endpoint descriptor, or `undefined` when there is none.
 *
 * A malformed or truncated file is treated as "no endpoint" rather than an
 * error: a corrupt descriptor must not take `cortex ps` down with it. The
 * caller re-checks liveness by connecting.
 */
export function readEndpoint(dir: string): KernelEndpoint | undefined {
  const path = endpointPath(dir);
  if (!existsSync(path)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const e = parsed as Partial<KernelEndpoint>;
  if (typeof e.host !== 'string' || e.host.length === 0) return undefined;
  if (typeof e.port !== 'number' || !Number.isInteger(e.port) || e.port <= 0) return undefined;
  if (typeof e.token !== 'string' || e.token.length === 0) return undefined;
  return {
    host: e.host,
    port: e.port,
    pid: typeof e.pid === 'number' ? e.pid : 0,
    token: e.token,
    startedAt: typeof e.startedAt === 'string' ? e.startedAt : '',
    abiVersion: typeof e.abiVersion === 'string' ? e.abiVersion : '',
    dir: typeof e.dir === 'string' ? e.dir : dir,
  };
}

/**
 * Remove the endpoint descriptor — but only if it still describes *this*
 * kernel.
 *
 * Two kernels can share a directory over time (the first one dies without
 * cleaning up, a second one starts and publishes its own descriptor). If the
 * first one's shutdown blindly unlinked the file, it would erase the second
 * one's advertisement and every client would lose the live kernel. So the
 * removal is conditional on the descriptor still naming the endpoint we
 * published.
 *
 * @returns `true` when the descriptor was removed.
 */
export function clearEndpoint(dir: string, endpoint: KernelEndpoint): boolean {
  const current = readEndpoint(dir);
  if (current === undefined) return false;
  if (current.pid !== endpoint.pid || current.port !== endpoint.port) return false;
  try {
    unlinkSync(endpointPath(dir));
    return true;
  } catch {
    return false;
  }
}
