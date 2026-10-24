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

import { mkdir, open, readFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { existsSync } from 'node:fs';
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
  /** Process whose syscalls this log records. */
  readonly pid: ProcessId;
  /**
   * The process's own directory — the log is written as `<dir>/log.crec`.
   * Created if it does not exist. Conventionally
   * `.cortex/processes/<pid>/` per docs/ARCHITECTURE.md §7.
   *
   * Up to `0.2.0` this was the shared `processes/` root and the file was named
   * `<pid>.crec`; passing a shared directory now would make every process
   * write to the same `log.crec`.
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
  #onRecord: ((record: SyscallRecord) => void) | undefined;

  private constructor(pid: ProcessId, path: string, handle: FileHandle, offset: number) {
    this.pid = pid;
    this.path = path;
    this.#handle = handle;
    this.#offset = offset;
  }

  /**
   * Attach a listener that is told about every frame as it is written.
   *
   * The listener receives the **complete** record — including the
   * `byteOffset` this recorder assigned — so a watcher sees exactly the
   * frame that is now on disk, at the offset `cortex trace` would report for
   * it. It fires after the write, in file order.
   *
   * Why the recorder and not the dispatcher: **seven** modules write records
   * directly through `append()` — the dispatcher, the scheduler, the signal
   * manager, the process table, `fork`, `init` and `checkpoint` — because
   * they predate the dispatcher or own a record of their own. The recorder
   * is the one place every frame passes through, so it is the only place
   * where a live watcher can be told the truth: a subscriber's view of the
   * log and the log itself cannot disagree.
   *
   * The listener is best-effort: one that throws is ignored. A watcher is a
   * guest; it cannot be allowed to change what gets recorded.
   */
  setOnRecord(listener: ((record: SyscallRecord) => void) | undefined): void {
    this.#onRecord = listener;
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
    // `dir` is the process's OWN directory, so the log is always `log.crec`
    // (docs/ARCHITECTURE.md §7: `processes/<pid>/log.crec`). Up to `0.2.0` the
    // caller passed the shared `processes/` root and the file was named for the
    // pid; the pid is now carried by the directory, which is what lets one
    // `rm -rf` remove a process's whole footprint.
    const path = join(opts.dir, `log${CREC_EXTENSION}`);

    // The directory may not exist yet — a process's own subdirectory is
    // created the first time its log is opened (docs/ARCHITECTURE.md §7).
    try {
      await mkdir(opts.dir, { recursive: true });
    } catch (err) {
      throw wrapIoError('Recorder.open', opts.dir, err);
    }

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

    // Tell the watcher, now that the frame is on disk. The listener is a
    // guest: it must not be able to change what was recorded.
    if (this.#onRecord !== undefined) {
      try {
        this.#onRecord(record);
      } catch {
        /* a broken watcher must not break the writer */
      }
    }
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
 * Where a frame is and what it was.
 *
 * It is what a follower checks to know that the history it is extending is
 * still the history: the frame has to still be at that offset, with that
 * length, saying the same thing.
 */
interface FrameStamp {
  /** The file offset the frame starts at. */
  readonly offset: number;
  /** The frame's payload length. */
  readonly length: number;
  /** The frame's call id. */
  readonly callId: string;
}

/**
 * Decode the frames in a buffer, starting at `start`.
 *
 * Yields each record as it is decoded, so a caller that stops early stops the
 * work, and a corrupt frame in the middle throws at exactly the point it
 * always did. `base` is the file offset of `buf[0]`, so the errors can point
 * at the place in the file rather than at the place in the buffer.
 *
 * Returns where the last complete frame ended, and what that frame was —
 * the last frame is what a follower checks to know that the history it is
 * extending is still the history.
 */
function* decodeFrames(
  buf: Buffer,
  start: number,
  base: number,
  op: string,
  path: string,
): Generator<SyscallRecord, { end: number; last: FrameStamp | undefined }, undefined> {
  let cursor = start;
  let last: FrameStamp | undefined;
  while (cursor < buf.byteLength) {
    // Need at least the length prefix to proceed.
    if (buf.byteLength - cursor < CREC_FRAME_PREFIX_SIZE) {
      // Torn frame header at EOF. Discard.
      break;
    }

    const declaredLength = buf.readUInt32BE(cursor);
    const frameStart = cursor;
    const payloadStart = cursor + CREC_FRAME_PREFIX_SIZE;
    const payloadEnd = payloadStart + declaredLength;

    if (payloadEnd > buf.byteLength) {
      // Torn frame payload at EOF. Discard.
      break;
    }

    const payload = buf.subarray(payloadStart, payloadEnd);
    let decoded: unknown;
    try {
      decoded = decode(payload);
    } catch (err) {
      throw new CortexError('ERECORD', op, {
        message: 'CBOR decode failed mid-file (corruption?)',
        details: { path, frameStart: base + frameStart, declaredLength },
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
      throw new CortexError('ERECORD', op, {
        message: 'decoded frame is not a SyscallRecord',
        details: { path, frameStart: base + frameStart },
      });
    }

    const record = decoded as SyscallRecord;
    yield record;
    last = {
      offset: base + frameStart,
      length: declaredLength,
      callId: typeof record.callId === 'string' ? record.callId : '',
    };
    cursor = payloadEnd;
  }
  return { end: cursor, last };
}

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

  const frames = decodeFrames(buf, CREC_HEADER_SIZE, 0, 'readRecords', path);
  let step = frames.next();
  while (!step.done) {
    yield step.value;
    step = frames.next();
  }
}

/**
 * What one read of a {@link LogTail} found.
 */
export interface TailRead {
  /** The frames written since the previous read. */
  readonly records: readonly SyscallRecord[];
  /** The byte offset just past the last complete frame. */
  readonly offset: number;
  /**
   * How many bytes were read from the file.
   *
   * It is here to be measured: "the reader does not re-read what it already
   * read" is a claim about bytes, and a claim about bytes needs bytes.
   */
  readonly bytes: number;
  /**
   * True when the file was replaced or truncated under us.
   *
   * The frames that were read are gone, so the caller has to forget them —
   * a reader that kept showing a history the disk no longer has would be
   * showing a past that did not happen.
   */
  readonly replaced: boolean;
}

/**
 * A reader that follows a `.crec` file as it grows.
 *
 * `readRecords` answers "what is in this file", and it answers it by reading
 * the whole file, every time. That is the right answer for a file that is
 * finished, and the wrong one for a file that is still being written to: a
 * watcher that asks "what is new" by re-reading everything pays for the
 * whole history on every poll — and the history of a long-lived agent is
 * exactly the thing that grows.
 *
 * This follows the file instead. It remembers how far it has read, and each
 * call returns only the frames written since the last one. The frames are
 * the frames `readRecords` would return, in the same order; the difference is
 * only how much of the file is read to get them.
 *
 * ## The awkward parts, and what it does with them
 *
 * - **A torn frame at EOF** (the writer was interrupted mid-frame) is not an
 *   error: the read stops before it, the offset points at its start, and the
 *   next call picks the frame up once the rest of it has been written.
 * - **A file that shrank** was replaced, not appended to. The frames read so
 *   far are gone, so this starts over from the beginning and reports
 *   `replaced: true` — the caller has to know, because the events it
 *   derived from those frames are no longer true.
 */
export class LogTail {
  /** The file this follows. */
  readonly path: string;

  /** The byte offset just past the last complete frame. */
  #offset = 0;

  /** Whether the magic header has been read and accepted. */
  #headerDone = false;

  /**
   * The file's identity as of the last read (`device:inode`).
   *
   * A log that was replaced by a different file of the same size would not
   * look truncated, and reading it from the old offset would splice two
   * histories together. The identity is what says "this is a different
   * file".
   */
  #identity: string | undefined;

  /**
   * The last frame that was read.
   *
   * A file that was replaced by one that is *bigger* does not look
   * truncated, and the bytes at the old offset are then the middle of a
   * frame — which reads as "the writer has not finished the frame yet", not
   * as "this is a different history". So the frame we last read is checked:
   * it has to still be at that offset, with that length, saying the same
   * thing. One frame's worth of reading to know that the rest is still the
   * rest.
   */
  #lastFrame: FrameStamp | undefined;

  constructor(path: string) {
    this.path = path;
  }

  /** The byte offset just past the last complete frame. */
  get offset(): number {
    return this.#offset;
  }

  /**
   * Read the frames written since the last call.
   *
   * @throws CortexError EINVAL when the file is not a `.crec`, ERECORD when a
   *   frame in the middle of it cannot be decoded.
   */
  async read(): Promise<TailRead> {
    let handle: FileHandle;
    try {
      handle = await open(this.path, 'r');
    } catch (err) {
      throw wrapIoError('LogTail.read', this.path, err);
    }
    try {
      const stat = await handle.stat();
      const identity = `${String(stat.dev)}:${String(stat.ino)}`;
      let replaced =
        stat.size < this.#offset ||
        (this.#identity !== undefined && this.#identity !== identity);
      if (!replaced && this.#lastFrame !== undefined && this.#offset > 0) {
        // The history we are extending has to still be there.
        replaced = !(await this.#sameHistory(handle));
      }
      if (replaced) {
        // The file was replaced or truncated: the frames we read are gone.
        this.#offset = 0;
        this.#headerDone = false;
        this.#lastFrame = undefined;
      }
      this.#identity = identity;
      const from = replaced ? 0 : this.#offset;
      try {
        const tail = await this.#readFrom(handle, from, stat.size);
        return { ...tail, replaced };
      } catch (err) {
        if (from === 0) throw err;
        // The bytes we were following are not the bytes that are there. The
        // file was replaced by one that is not an extension of it — the same
        // path, different history — so the only honest thing to do is read
        // it from the beginning and say that it was replaced.
        this.#offset = 0;
        this.#headerDone = false;
        this.#lastFrame = undefined;
        const again = await this.#readFrom(handle, 0, stat.size);
        return { ...again, replaced: true };
      }
    } finally {
      await handle.close();
    }
  }

  /**
   * Whether the frame last read is still at the place it was read from.
   *
   * It has to be there with the same length and the same call id. Anything
   * else means the file is not the file we were following.
   */
  async #sameHistory(handle: FileHandle): Promise<boolean> {
    const frame = this.#lastFrame as FrameStamp;
    const buf = Buffer.alloc(CREC_FRAME_PREFIX_SIZE + frame.length);
    const { bytesRead } = await handle.read(buf, 0, buf.length, frame.offset);
    if (bytesRead < buf.length) return false;
    if (buf.readUInt32BE(0) !== frame.length) return false;
    try {
      const decoded = decode(buf.subarray(CREC_FRAME_PREFIX_SIZE)) as { callId?: unknown };
      return decoded?.callId === frame.callId;
    } catch {
      return false;
    }
  }

  /** Read the frames between `from` and the end of the file. */
  async #readFrom(
    handle: FileHandle,
    from: number,
    size: number,
  ): Promise<Omit<TailRead, 'replaced'>> {
    const length = Math.max(0, size - from);
    const buf = Buffer.alloc(length);
    if (length > 0) await handle.read(buf, 0, length, from);

    let cursor = 0;
    if (!this.#headerDone) {
      if (buf.byteLength < CREC_HEADER_SIZE) {
        // Not even the header yet — the file is still being created.
        return { records: [], offset: from, bytes: length };
      }
      const magic = buf.subarray(0, CREC_HEADER_SIZE);
      if (!magic.equals(Buffer.from(CREC_MAGIC))) {
        throw new CortexError('EINVAL', 'LogTail.read', {
          message: 'not a .crec file (magic mismatch)',
          details: { path: this.path },
        });
      }
      this.#headerDone = true;
      cursor = CREC_HEADER_SIZE;
    }

    const frames = decodeFrames(buf, cursor, from, 'LogTail.read', this.path);
    const records: SyscallRecord[] = [];
    let result = frames.next();
    while (!result.done) {
      records.push(result.value);
      result = frames.next();
    }
    this.#offset = from + result.value.end;
    if (result.value.last !== undefined) this.#lastFrame = result.value.last;
    return { records, offset: this.#offset, bytes: length };
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
 * `.cortex/processes/<pid>/log.crec`
 *
 * One directory per process (docs/ARCHITECTURE.md §7), so `rm -rf` of a single
 * process removes everything it ever wrote — its log, its metadata index and
 * its checkpoints — with no global index left to sweep.
 *
 * Until `0.2.1` this was the flat `.cortex/processes/<pid>.crec`. Logs written
 * by older builds are still read: see `existingCrecPath`.
 */
export function crecPath(rootDir: string, pid: ProcessId): string {
  return join(rootDir, 'processes', String(unbrand(pid)), `log${CREC_EXTENSION}`);
}

/**
 * The pre-`0.2.1` layout: `.cortex/processes/<pid>.crec`. Kept so a reader can
 * fall back to a log written by an older build instead of reporting the process
 * as having no history at all.
 */
export function legacyCrecPath(rootDir: string, pid: ProcessId): string {
  return join(rootDir, 'processes', `${unbrand(pid)}${CREC_EXTENSION}`);
}

/** The directory holding everything one process ever wrote. */
export function processDir(rootDir: string, pid: ProcessId): string {
  return join(rootDir, 'processes', String(unbrand(pid)));
}

/** The directory holding one process's checkpoints. */
export function checkpointsDir(rootDir: string, pid: ProcessId): string {
  return join(processDir(rootDir, pid), 'checkpoints');
}

/**
 * Resolve a process's log for **reading**: the current layout if it is there,
 * otherwise the legacy flat file, otherwise the current path (so a caller that
 * is about to create it gets the right one).
 */
export function existingCrecPath(rootDir: string, pid: ProcessId): string {
  const current = crecPath(rootDir, pid);
  if (existsSync(current)) return current;
  const legacy = legacyCrecPath(rootDir, pid);
  if (existsSync(legacy)) return legacy;
  return current;
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
