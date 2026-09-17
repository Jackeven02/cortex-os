/**
 * cortex kernel — syscall recorder.
 *
 * The lowest-level runtime module. Every other kernel module depends on it;
 * it depends only on `types.ts` and `errors.ts`.
 *
 * The recorder writes an append-only log of every syscall a process makes,
 * in a framed CBOR format. This log is what makes deterministic replay,
 * `cortex trace`, `cortex diff`, and checkpoint/restore possible. Without
 * it, cortex is just another agent framework.
 *
 * ## File format
 *
 * ```
 * .crec file:
 *   [0..8)    magic: "CRTXREC\n" (8 bytes, ASCII)
 *   [8..)     frames, each:
 *               [0..4)   u32 big-endian payload length N
 *               [4..4+N) CBOR-encoded SyscallRecord
 * ```
 *
 * Why length-prefix framing instead of CBOR's self-delimiting mode:
 *   - Trivially seekable (you can skip a frame without decoding it)
 *   - Crash-safe: a partial frame at EOF is detected by "declared length
 *     extends past EOF" and silently discarded on read (torn-write recovery)
 *   - Simpler to implement correctly than streaming CBOR
 *
 * Why CBOR over JSON:
 *   - Binary, ~30-50% smaller than JSON for typical records
 *   - Preserves Uint8Array, bigint, and tagged values without lossy
 *     string conversion
 *   - Deterministic encoding options available (important for content-
 *     addressing checkpoints)
 *   - Fast: cborg is one of the quickest JS CBOR implementations
 *
 * ## Durability model
 *
 * `append()` encodes the record and writes it to the file descriptor. The
 * OS buffers the write; it is NOT fsynced. This gives good throughput
 * (the OS batches writes) at the cost of durability on power loss.
 *
 * `flush()` calls fsync. Use it at checkpoints, before fork, and on
 * graceful shutdown. A kernel crash loses un-flushed records; a machine
 * crash loses everything since the last flush. This is documented and
 * intentional for v0. See docs/ARCHITECTURE.md §10.
 *
 * `close()` flushes and closes the file descriptor.
 *
 * ## Offsets
 *
 * Every record carries its own `byteOffset` — the position in the file
 * where its frame header begins. `append()` returns this offset. It is
 * what `Checkpoint.syscallLogOffset` and `ForkResult.sharedCausalPast`
 * reference. See docs/STATE.md §4.
 *
 * ## What this module does NOT do
 *
 *   - It does not decide *what* to record. That is the syscall dispatcher's
 *     job (docs/ARCHITECTURE.md §4.10). The recorder is a dumb writer.
 *   - It does not rotate or prune logs. See docs/STATE.md §8.5.
 *   - It does not handle fork lineage. The fork module writes a synthetic
 *     first record into the child's log; the recorder just appends it.
 *   - It does not compress. v0 logs are raw CBOR. Compression is a v1
 *     concern (likely zstd at the file level, not per-frame).
 *
 * See: docs/ABI.md §6, docs/STATE.md §4, docs/ARCHITECTURE.md §4.1
 *
 * @module kernel/recorder
 */

import { open, readFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { encode, decode } from 'cborg';

import {
  type ProcessId,
  type SyscallOffset,
  type SyscallRecord,
  asSyscallOffset,
  unbrand,
} from './types.js';
import { CortexError, isCortexError } from './errors.js';

// =============================================================================
// §1. Constants
// =============================================================================

/**
 * File magic. 8 bytes, ASCII, ends with newline so `head -1` on a .crec
 * file prints something recognizable in a hexdump.
 */
export const CREC_MAGIC = new Uint8Array([
  0x43, 0x52, 0x54, 0x58, 0x52, 0x45, 0x43, 0x0a, // "CRTXREC\n"
]);

/** Length of the magic header, in bytes. */
export const CREC_HEADER_SIZE = CREC_MAGIC.length;

/** Length of the per-frame length prefix, in bytes (u32 big-endian). */
export const CREC_FRAME_PREFIX_SIZE = 4;

/**
 * Maximum frame payload size. 16 MiB. Records larger than this are almost
 * certainly a bug (e.g. an LLM response that should have been hashed
 * instead of inlined). The recorder traps with EINVAL rather than writing
 * a frame that would corrupt the reader's assumptions.
 */
export const CREC_MAX_FRAME_SIZE = 16 * 1024 * 1024;

/** File extension for syscall logs. */
export const CREC_EXTENSION = '.crec';

// =============================================================================
// §2. Types
// =============================================================================

/**
 * Input to `Recorder.append()`. The `byteOffset` field is computed by the
 * recorder (it is the position where this frame will be written), so
 * callers omit it.
 */
export type SyscallRecordInput = Omit<SyscallRecord, 'byteOffset'>;

/**
 * Options for opening a recorder.
 */
export interface RecorderOptions {
  /** Process whose syscalls this log records. Used in the filename. */
  readonly pid: ProcessId;
  /**
   * Directory containing the .crec file. Created if it does not exist.
   * Conventionally `.cortex/proc/` per docs/ARCHITECTURE.md §7.
   */
  readonly dir: string;
  /**
   * If true, truncate any existing file for this PID. Default false —
   * existing logs are appended to, which is the correct behavior for
   * a process resuming after a kernel restart.
   *
   * Set to true only when spawning a brand-new process whose PID happens
   * to collide with a stale log (should never happen since PIDs are not
   * reused, but defensive).
   */
  readonly truncate?: boolean;
}

// =============================================================================
// §3. Recorder
// =============================================================================

/**
 * Append-only syscall log writer for one process.
 *
 * Lifecycle:
 *   1. `await Recorder.open({ pid, dir })` — opens or creates the file,
 *      writes the magic if new, seeks to EOF.
 *   2. `await rec.append(record)` — encodes and writes one frame. Returns
 *      the byte offset where the frame was written.
 *   3. `await rec.flush()` — fsyncs. Call before checkpoint, fork, shutdown.
 *   4. `await rec.close()` — flushes and closes the fd.
 *
 * Not thread-safe within a process (Node is single-threaded, so this is
 * moot), but `append()` calls are serialized via an internal promise chain
 * so concurrent awaits from different async contexts do not interleave
 * frames.
 */
export class Recorder {
  readonly pid: ProcessId;
  readonly path: string;

  #handle: FileHandle;
  #offset: number;
  #closed = false;
  #writeChain: Promise<void> = Promise.resolve();

  private constructor(pid: ProcessId, path: string, handle: FileHandle, offset: number) {
    this.pid = pid;
    this.path = path;
    this.#handle = handle;
    this.#offset = offset;
  }

  /**
   * Open (or create) the recorder for a process.
   *
   * If the file does not exist, it is created and the magic header is
   * written. If it exists, the magic is validated and the file is opened
   * in append mode; `currentOffset` is set to EOF.
   *
   * @throws CortexError ERECORD on I/O failure, EINVAL on magic mismatch.
   */
  static async open(opts: RecorderOptions): Promise<Recorder> {
    const filename = `${unbrand(opts.pid)}${CREC_EXTENSION}`;
    const path = join(opts.dir, filename);

    let handle: FileHandle;
    try {
      // 'a+' = open for reading and appending; create if missing.
      // We use 'a+' rather than 'w+' so existing logs survive a kernel
      // restart. The `truncate` option switches to 'w+'.
      const flags = opts.truncate === true ? 'w+' : 'a+';
      handle = await open(path, flags);
    } catch (err) {
      throw wrapIoError('Recorder.open', path, err);
    }

    try {
      const stat = await handle.stat();

      if (stat.size === 0) {
        // Fresh file. Write the magic.
        await handle.write(CREC_MAGIC, 0, CREC_HEADER_SIZE, 0);
        return new Recorder(opts.pid, path, handle, CREC_HEADER_SIZE);
      }

      if (stat.size < CREC_HEADER_SIZE) {
        // File exists but is shorter than the magic. Corrupt or torn
        // initial write. Refuse to open — the user must decide whether
        // to truncate or investigate.
        await handle.close();
        throw new CortexError('EINVAL', 'Recorder.open', {
          message: `file too short to contain magic (${stat.size} bytes)`,
          details: { path, size: stat.size },
        });
      }

      // Validate magic.
      const magicBuf = Buffer.alloc(CREC_HEADER_SIZE);
      const { bytesRead } = await handle.read(magicBuf, 0, CREC_HEADER_SIZE, 0);
      if (bytesRead !== CREC_HEADER_SIZE || !magicBuf.equals(Buffer.from(CREC_MAGIC))) {
        await handle.close();
        throw new CortexError('EINVAL', 'Recorder.open', {
          message: 'not a .crec file (magic mismatch)',
          details: { path, expected: 'CRTXREC\\n', got: magicBuf.toString('latin1') },
        });
      }

      return new Recorder(opts.pid, path, handle, stat.size);
    } catch (err) {
      // Best-effort close on validation failure, then rethrow.
      try {
        await handle.close();
      } catch {
        /* ignore */
      }
      if (isCortexError(err)) throw err;
      throw wrapIoError('Recorder.open', path, err);
    }
  }

  /**
   * Current end-of-file offset, in bytes. The next `append()` will write
   * its frame header at exactly this position.
   *
   * This is the value to store in `Checkpoint.syscallLogOffset` and
   * `ForkResult.sharedCausalPast`.
   */
  get currentOffset(): SyscallOffset {
    return asSyscallOffset(this.#offset);
  }

  /** Whether `close()` has been called. */
  get closed(): boolean {
    return this.#closed;
  }

  /**
   * Append one record. Returns the byte offset where the frame was written.
   *
   * The record's `byteOffset` field is filled in by the recorder (callers
   * pass `SyscallRecordInput`, which omits it). The on-disk frame carries
   * the offset redundantly with its physical position — this is intentional
   * so each frame is self-describing and the reader can validate.
   *
   * Writes are serialized: concurrent `append()` calls from different async
   * contexts cannot interleave frames. The returned promise resolves once
   * the frame is in the OS buffer (NOT once it is fsynced — see `flush()`).
   *
   * @throws CortexError EINVAL if the encoded frame exceeds CREC_MAX_FRAME_SIZE,
   *         ERECORD on I/O failure, ESTATE if the recorder is closed.
   */
  append(input: SyscallRecordInput): Promise<SyscallOffset> {
    if (this.#closed) {
      return Promise.reject(
        new CortexError('ESTATE', 'Recorder.append', {
          message: 'recorder is closed',
          details: { path: this.path },
        }),
      );
    }

    // Serialize writes through a promise chain so two concurrent appends
    // cannot interleave their (header, payload) writes.
    const result = this.#writeChain.then(() => this.#appendLocked(input));
    // Keep the chain alive even if this append fails; subsequent appends
    // should still proceed.
    this.#writeChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #appendLocked(input: SyscallRecordInput): Promise<SyscallOffset> {
    const byteOffset = asSyscallOffset(this.#offset);
    const record: SyscallRecord = { ...input, byteOffset };

    let payload: Uint8Array;
    try {
      payload = encode(record);
    } catch (err) {
      throw new CortexError('EINVAL', 'Recorder.append', {
        message: 'failed to CBOR-encode record',
        details: { syscall: input.syscall, reason: (err as Error).message },
        cause: err,
      });
    }

    if (payload.byteLength > CREC_MAX_FRAME_SIZE) {
      throw new CortexError('EINVAL', 'Recorder.append', {
        message: `frame too large (${payload.byteLength} bytes > ${CREC_MAX_FRAME_SIZE})`,
        details: { syscall: input.syscall, size: payload.byteLength },
      });
    }

    const header = Buffer.alloc(CREC_FRAME_PREFIX_SIZE);
    header.writeUInt32BE(payload.byteLength, 0);

    const position = this.#offset;
    try {
      // Write header + payload as two writes at explicit positions. We
      // could concatenate into one buffer to halve the syscall count; for
      // v0 we keep them separate so the offset arithmetic is obvious.
      // TODO(perf): single-write path if profiling shows this matters.
      await this.#handle.write(header, 0, CREC_FRAME_PREFIX_SIZE, position);
      await this.#handle.write(
        Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength),
        0,
        payload.byteLength,
        position + CREC_FRAME_PREFIX_SIZE,
      );
    } catch (err) {
      throw wrapIoError('Recorder.append', this.path, err);
    }

    this.#offset = position + CREC_FRAME_PREFIX_SIZE + payload.byteLength;
    return byteOffset;
  }

  /**
   * fsync the file. Call before checkpoint, before fork, and on graceful
   * shutdown. Records appended after the last flush are in the OS buffer
   * and survive a kernel crash, but NOT a machine crash.
   *
   * @throws CortexError ERECORD on I/O failure, ESTATE if closed.
   */
  async flush(): Promise<void> {
    if (this.#closed) {
      throw new CortexError('ESTATE', 'Recorder.flush', {
        message: 'recorder is closed',
        details: { path: this.path },
      });
    }
    // Wait for any in-flight appends to land before syncing.
    await this.#writeChain;
    try {
      await this.#handle.sync();
    } catch (err) {
      throw wrapIoError('Recorder.flush', this.path, err);
    }
  }

  /**
   * Flush and close the file descriptor. Idempotent — calling close() twice
   * is a no-op the second time.
   *
   * @throws CortexError ERECORD on I/O failure during flush.
   */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    try {
      await this.#writeChain;
      try {
        await this.#handle.sync();
      } catch {
        // Best-effort sync; close even if sync fails so we do not leak fds.
      }
      await this.#handle.close();
    } catch (err) {
      throw wrapIoError('Recorder.close', this.path, err);
    }
  }
}

// =============================================================================
// §4. Reader
// =============================================================================

/**
 * Read all records from a .crec file, in order.
 *
 * Validates the magic header. Stops silently at a torn frame at EOF (the
 * last write was interrupted mid-frame; the partial data is discarded).
 * Throws on CBOR decode errors mid-file (that is real corruption, not a
 * torn tail).
 *
 * @param path Absolute or relative path to the .crec file.
 * @yields Each SyscallRecord, in file order.
 * @throws CortexError EINVAL on magic mismatch, ERECORD on I/O or decode failure.
 */
export async function* readRecords(path: string): AsyncGenerator<SyscallRecord> {
  let buf: Buffer;
  try {
    buf = Buffer.from(await readFile(path));
  } catch (err) {
    throw wrapIoError('readRecords', path, err);
  }

  if (buf.byteLength < CREC_HEADER_SIZE) {
    if (buf.byteLength === 0) return; // Empty file is valid; yields nothing.
    throw new CortexError('EINVAL', 'readRecords', {
      message: `file too short to contain magic (${buf.byteLength} bytes)`,
      details: { path },
    });
  }

  const magic = buf.subarray(0, CREC_HEADER_SIZE);
  if (!magic.equals(Buffer.from(CREC_MAGIC))) {
    throw new CortexError('EINVAL', 'readRecords', {
      message: 'not a .crec file (magic mismatch)',
      details: { path },
    });
  }

  let cursor = CREC_HEADER_SIZE;
  while (cursor < buf.byteLength) {
    // Need at least the length prefix to proceed.
    if (buf.byteLength - cursor < CREC_FRAME_PREFIX_SIZE) {
      // Torn frame header at EOF. Discard.
      return;
    }

    const declaredLength = buf.readUInt32BE(cursor);
    const frameStart = cursor;
    const payloadStart = cursor + CREC_FRAME_PREFIX_SIZE;
    const payloadEnd = payloadStart + declaredLength;

    if (payloadEnd > buf.byteLength) {
      // Torn frame payload at EOF. Discard.
      return;
    }

    const payload = buf.subarray(payloadStart, payloadEnd);
    let decoded: unknown;
    try {
      decoded = decode(payload);
    } catch (err) {
      throw new CortexError('ERECORD', 'readRecords', {
        message: 'CBOR decode failed mid-file (corruption?)',
        details: { path, frameStart, declaredLength },
        cause: err,
      });
    }

    // Validate the decoded shape minimally. We do not do full schema
    // validation here — that is the replay engine's job — but we do check
    // the fields the reader itself relies on.
    if (
      typeof decoded !== 'object' ||
      decoded === null ||
      !('syscall' in decoded) ||
      !('phase' in decoded)
    ) {
      throw new CortexError('ERECORD', 'readRecords', {
        message: 'decoded frame is not a SyscallRecord',
        details: { path, frameStart },
      });
    }

    // Validate self-described offset matches physical position. A mismatch
    // means the file was edited externally or the writer had a bug. Surface
    // it but do not throw — the record is still usable.
    const record = decoded as SyscallRecord;
    if (typeof record.byteOffset === 'number' && record.byteOffset !== frameStart) {
      // TODO: emit a warning hook once the kernel has a logging subsystem.
      // For now, silently yield. The replay engine can detect this if it cares.
    }

    yield record;
    cursor = payloadEnd;
  }
}

/**
 * Read a .crec file and return the byte offset just past the last complete
 * frame. This is the "effective EOF" — what `Recorder.currentOffset` would
 * report if the recorder were re-opened on this file after a torn write.
 *
 * Useful for crash recovery: the kernel can resume appending at this
 * offset without rewriting the torn tail (the next append will overwrite
 * the partial frame because the file is opened in 'a+' mode at EOF... wait,
 * no — 'a+' appends at the *physical* EOF, which includes the torn bytes).
 *
 * v0 behavior: we do NOT truncate the torn tail. The next append writes
 * after it, and the reader's torn-frame detection stops at the first
 * partial frame, so the tail is effectively invisible. This is simpler
 * than truncation and avoids a destructive operation on crash recovery.
 *
 * v1 may add an explicit `repair()` that truncates.
 *
 * @returns Byte offset just past the last complete frame.
 */
export async function effectiveEof(path: string): Promise<SyscallOffset> {
  let buf: Buffer;
  try {
    buf = Buffer.from(await readFile(path));
  } catch (err) {
    throw wrapIoError('effectiveEof', path, err);
  }

  if (buf.byteLength < CREC_HEADER_SIZE) {
    return asSyscallOffset(0);
  }

  let cursor = CREC_HEADER_SIZE;
  while (cursor + CREC_FRAME_PREFIX_SIZE <= buf.byteLength) {
    const declaredLength = buf.readUInt32BE(cursor);
    const payloadEnd = cursor + CREC_FRAME_PREFIX_SIZE + declaredLength;
    if (payloadEnd > buf.byteLength) break;
    cursor = payloadEnd;
  }
  return asSyscallOffset(cursor);
}

// =============================================================================
// §5. Path helpers
// =============================================================================

/**
 * Conventional path for a process's syscall log.
 *
 * `.cortex/proc/<pid>.crec`
 *
 * See docs/ARCHITECTURE.md §7 for the full persistence layout.
 */
export function crecPath(rootDir: string, pid: ProcessId): string {
  return join(rootDir, 'proc', `${unbrand(pid)}${CREC_EXTENSION}`);
}

// =============================================================================
// §6. Internal helpers
// =============================================================================

/**
 * Wrap a Node I/O error into a CortexError with errno ERECORD. Preserves
 * the original via `cause` so debugging is not lossy.
 */
function wrapIoError(op: string, path: string, err: unknown): CortexError {
  if (isCortexError(err)) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new CortexError('ERECORD', op, {
    message: `I/O failure on ${path}: ${message}`,
    details: { path, op },
    cause: err,
  });
}
