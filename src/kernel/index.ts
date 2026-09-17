/**
 * cortex kernel — public surface.
 *
 * Re-exports the type system and error model. As Phase 1 lands more modules
 * (recorder, process_table, signals, ipc, memory, checkpoint, fork,
 * scheduler, init, syscall_dispatcher, driver_registry), each will be added
 * here in dependency order.
 *
 * Internal modules (anything not re-exported from this file) are not part
 * of the public ABI and may change without notice.
 *
 * @module kernel
 */

export * from './types.js';
export * from './errors.js';
export * from './recorder.js';
export * from './process_table.js';
export * from './signals.js';
export * from './ipc.js';
export * from './memory.js';
export * from './checkpoint.js';
export * from './fork.js';
export * from './scheduler.js';
export * from './init.js';
export * from './syscall_dispatcher.js';
