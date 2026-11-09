/**
 * What `cortex doctor` says about a driver's fork claim.
 *
 * A driver may say `forkable: true`. The kernel trusts that when it forks.
 * Doctor asks a narrower question: did the driver also offer a way to show
 * its state. It does not run that way. Running it would change the driver.
 */

export interface ForkClaim {
  readonly name: string;
  readonly forkable: boolean;
  readonly canSerialize: boolean;
  readonly canRestore: boolean;
}

export type ForkVerdict = 'closed-on-fork' | 'round-trip-declared' | 'unprovable';

export function judgeForkClaim(claim: ForkClaim): { readonly verdict: ForkVerdict; readonly note: string } {
  if (!claim.forkable) {
    return { verdict: 'closed-on-fork', note: 'fork closes this driver\'s state' };
  }
  if (claim.canSerialize && claim.canRestore) {
    return {
      verdict: 'round-trip-declared',
      note: 'serialize and restore exist; doctor does not run them',
    };
  }
  return {
    verdict: 'unprovable',
    note: 'forkable is set, but serialize and restore are not both there',
  };
}
