/**
 * cortex CLI — the tool surface, in facts.
 *
 * ## The rule
 *
 * **A kernel can call things, and some of those calls nobody ever said
 * whether they can be undone.**
 *
 * `cortex audit` has always answered that: it boots a kernel, lists every
 * registered driver, and prints each tool with the reversibility tag the
 * kernel would enforce. Since an MCP server cannot declare reversibility at
 * all (docs/ABI.md §5, §7.2), its tools are *defaulted* to `irreversible` —
 * safe, but a silent one: an untagged tool refuses to run inside a
 * `forkable()` region, and the operator finds that out as a puzzling
 * `EREVERSIBLE` days later.
 *
 * The answer lived inside the command's own printing code, so **nothing else
 * could say it**. The dashboard — the window an operator actually looks at —
 * had no way to ask what this kernel can call, and no way to see which of
 * those calls were never declared.
 *
 * So the answer moves here, as **facts**, and two views read them:
 *
 * - the terminal's `cortex audit`, and
 * - the dashboard's tool surface (`GET /api/drivers`).
 *
 * ## What it deliberately does not say
 *
 * **Anything about the arguments a tool takes.** The surface is a list of
 * *names* — what can be called, and whether it can be undone. The schema of
 * every tool is already in the driver's descriptor, and what an agent passes
 * to a tool is the agent's business, not the operator's.
 *
 * ## The declaration is three-valued
 *
 * `declared` has three states, and the middle one is the whole point:
 *
 * - `true` — somebody said so. The driver author wrote the tag in the
 *   descriptor, or the operator configured it for MCP.
 * - `false` — nobody said so. The tag exists (the kernel enforces it) but it
 *   was **defaulted**, and a defaulted tag is exactly what the operator needs
 *   to be told about.
 * - `null` — the registry cannot resolve the tool, so nobody can say anything
 *   about it. That is **not** `false`: "we do not know" is not "nobody
 *   declared it". Such a tool is tagged `?`, never `irreversible`.
 *
 * The same rule the rest of the project follows: a thing nobody reported is
 * not a zero, and not a permission.
 *
 * @module cli/audit_view
 */

import { isMcpToolDriver } from '../drivers/tool/mcp.js';
import type { DriverManifest } from '../kernel/driver_registry.js';
import type { IToolDriver, ToolDescriptor } from '../kernel/types.js';

/**
 * The tag a tool carries when the registry cannot say what it is.
 *
 * `?` and never `irreversible`: an unknown tag is not a conservative one, and
 * claiming a tool is irreversible when nobody said so would make the kernel
 * look stricter than it is — and the operator look reckless.
 */
export const UNKNOWN_REVERSIBILITY = '?';

/**
 * The marker a tool carries when nobody ever declared its reversibility.
 *
 * One word, printed by both views, because it is one fact: the tag the
 * kernel enforces was *invented*, not *stated*.
 */
export const UNDECLARED_MARKER = 'not-declared';

/**
 * How a tool's declaration is spelled.
 *
 * `declared` — somebody said so. `not-declared` — nobody did, so the tag was
 * defaulted. `?` — the registry cannot resolve the tool, so nobody can say.
 */
export function formatDeclaration(declared: boolean | null): string {
  if (declared === true) return 'declared';
  if (declared === false) return UNDECLARED_MARKER;
  return '?';
}

/** One tool, as the surface sees it. */
export interface ToolFact {
  /** The name the kernel resolves — the *exposed* name, namespace included. */
  readonly name: string;
  /**
   * The tag the kernel would enforce, or `?` when it cannot say.
   *
   * This is the **enforced** tag, not the declared one: an MCP tool nobody
   * declared reads as `irreversible` here, and `declared` is what says where
   * that came from.
   */
  readonly reversibility: string;
  /**
   * Whether anybody declared the tag: `true` declared, `false` defaulted,
   * `null` unknown (the registry cannot resolve the tool).
   */
  readonly declared: boolean | null;
  /** The driver's own one-line description, when it gave one. */
  readonly description: string;
}

/** One tool driver, and the tools it exposes. */
export interface ToolDriverFact {
  readonly name: string;
  readonly version: string;
  readonly abiCompat: string;
  /** May a cognitive fork carry this driver across? (docs/STATE.md §8.6) */
  readonly forkable: boolean;
  /** Does the driver stage and commit — two-phase, so it can be aborted? */
  readonly twoPhase: boolean;
  readonly tools: readonly ToolFact[];
}

/** One LLM driver, and the models it speaks to. */
export interface LLMDriverFact {
  readonly name: string;
  readonly version: string;
  readonly abiCompat: string;
  readonly isDefault: boolean;
  readonly supportedModels: readonly string[];
  readonly streams: boolean;
  readonly countsTokens: boolean;
}

/** One memory driver. */
export interface MemoryDriverFact {
  readonly name: string;
  readonly version: string;
  readonly abiCompat: string;
  readonly isDefault: boolean;
}

/** The whole surface of one kernel: what it can call, and with what. */
export interface DriverSurface {
  readonly toolDrivers: readonly ToolDriverFact[];
  readonly llmDrivers: readonly LLMDriverFact[];
  readonly memoryDrivers: readonly MemoryDriverFact[];
  /** How many tools the surface holds in total. */
  readonly toolCount: number;
  /** How many of them carry a tag nobody ever declared. */
  readonly undeclaredCount: number;
}

/**
 * How a tool is resolved: the registry's own lookup.
 *
 * `undefined` means the registry does not have that tool — and then nothing
 * can be said about its tag.
 */
export type ToolResolver = (
  toolName: string,
) => { readonly driver: IToolDriver; readonly descriptor: ToolDescriptor } | undefined;

/**
 * Describe one tool.
 *
 * The `declared` question has exactly one answer per driver kind:
 *
 * - An **MCP** driver cannot be asked at all (there is no reversibility field
 *   in the protocol), so the driver invents a tag and records which names the
 *   operator configured. A name missing from that record was **defaulted** —
 *   and a defaulted `irreversible` silently forbids `forkable()` regions,
 *   which is the kind of thing that only surfaces as a puzzling `EREVERSIBLE`
 *   days later.
 * - Any **other** driver states the tag in the descriptor, and the kernel
 *   trusts the driver author (docs/ABI.md §5). So it is declared.
 */
function describeTool(toolName: string, resolve: ToolResolver): ToolFact {
  const resolved = resolve(toolName);
  if (resolved === undefined) {
    // The registry listed the tool but cannot resolve it. Nobody can say what
    // its tag is, and nobody can say whether it was declared — so this is
    // `?` and "unknown", never `irreversible` and never "not declared".
    return {
      name: toolName,
      reversibility: UNKNOWN_REVERSIBILITY,
      declared: null,
      description: '',
    };
  }
  const { driver, descriptor } = resolved;
  const declared = isMcpToolDriver(driver)
    ? driver.declaredReversibility[toolName] === true
    : true;
  return {
    name: toolName,
    reversibility: descriptor.reversibility,
    declared,
    description: descriptor.description ?? '',
  };
}

/**
 * Describe the whole surface of a kernel.
 *
 * The manifest comes from the registry (`DriverRegistry.listAll()`); the
 * resolver is the registry's own lookup. Both come from the same place, so
 * the surface can never describe a tool the kernel does not have.
 */
export function describeDriverSurface(
  manifest: DriverManifest,
  resolve: ToolResolver,
): DriverSurface {
  const toolDrivers: ToolDriverFact[] = manifest.tools.map((driver) => ({
    name: driver.name,
    version: driver.version,
    abiCompat: driver.abiCompat,
    forkable: driver.forkable,
    twoPhase: driver.twoPhase,
    tools: driver.tools.map((toolName) => describeTool(toolName, resolve)),
  }));
  const llmDrivers: LLMDriverFact[] = manifest.llm.map((driver) => ({
    name: driver.name,
    version: driver.version,
    abiCompat: driver.abiCompat,
    isDefault: driver.isDefault,
    supportedModels: [...driver.supportedModels],
    streams: driver.streams,
    countsTokens: driver.countsTokens,
  }));
  const memoryDrivers: MemoryDriverFact[] = manifest.memory.map((driver) => ({
    name: driver.name,
    version: driver.version,
    abiCompat: driver.abiCompat,
    isDefault: driver.isDefault,
  }));
  let toolCount = 0;
  let undeclaredCount = 0;
  for (const driver of toolDrivers) {
    for (const tool of driver.tools) {
      toolCount += 1;
      if (tool.declared === false) undeclaredCount += 1;
    }
  }
  return { toolDrivers, llmDrivers, memoryDrivers, toolCount, undeclaredCount };
}

/**
 * The sentence that says which tools nobody declared.
 *
 * `null` when there are none — a surface with nothing undeclared has nothing
 * to warn about, and a warning that is always printed is a warning nobody
 * reads.
 *
 * The wording lives here so the terminal and the window say the same thing
 * about the same kernel. Note what it does *not* say: declaring a tag does
 * not make a tool forkable. It makes the tool **allowed to run inside** a
 * `forkable()` region — an MCP driver is `forkable = false` whatever its
 * tools are tagged (docs/STATE.md §8.6).
 */
export function formatUndeclaredSummary(surface: DriverSurface): string | null {
  if (surface.undeclaredCount === 0) return null;
  return (
    `${surface.undeclaredCount} tool(s) never declared a reversibility tag — they are treated as ` +
    `'irreversible' and will be refused inside forkable() regions.\n` +
    `Set them explicitly (MCP: the 'reversibility' option on mcpTool(), or ` +
    `CORTEX_MCP_* env for the CLI) to let them run inside forkable() regions.`
  );
}
