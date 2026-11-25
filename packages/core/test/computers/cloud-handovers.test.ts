// `leaseAuthority(lease).handovers()` (computers/cloud-point.ts): what a cloud pairing token made while this computer was
// alone is bound to. It counts a hand-over (this computer stopped holding the lease) and a new epoch of the same scope
// (another tenure, which another computer may have held in between unseen); it does NOT count the group's founding (the
// scope appearing), which is the same holder's own pairing.
import { describe, expect, test } from "bun:test";
import type { Lease, LeaseState } from "../../src/contracts/lease";
import { leaseAuthority } from "../../src/computers/cloud-point";

function stub(first: Partial<LeaseState>) {
  let state = { holder: "me", epoch: 1, ...first } as LeaseState;
  let fn: ((s: LeaseState) => void) | undefined;
  const lease = { self: "me", state: () => state, canAct: () => state.holder === "me", watch: (f: (s: LeaseState) => void) => { fn = f; return () => {}; } } as unknown as Lease;
  return { lease, set: (s: Partial<LeaseState>) => { state = { ...state, ...s } as LeaseState; fn?.(state); } };
}

describe("cloud pairing tokens and hand-overs", () => {
  test("the group's founding (the scope appearing, the epoch starting again) is no hand-over", () => {
    const { lease, set } = stub({ scope: undefined, epoch: 3 });
    const a = leaseAuthority(lease);
    set({ scope: "group-1", epoch: 1 });
    expect(a.handovers!()).toBe(0);
  });

  test("another holder in between is one; so is a new epoch of the same scope, though this computer never saw another holder", () => {
    const { lease, set } = stub({ scope: "group-1", epoch: 1 });
    const a = leaseAuthority(lease);
    set({ holder: "other", epoch: 2 });
    expect(a.handovers!()).toBe(1);
    set({ holder: "me", epoch: 3 });
    expect(a.handovers!()).toBe(1);
    // Held, then re-tenured (lapsed offline, the record moved on under it): counted though no other holder was seen.
    set({ epoch: 4 });
    expect(a.handovers!()).toBe(2);
    // A change that is neither (the same epoch again) counts nothing.
    set({ epoch: 4 });
    expect(a.handovers!()).toBe(2);
  });
});
