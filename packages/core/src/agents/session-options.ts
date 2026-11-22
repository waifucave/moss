// The options a session's agent lets the person choose from (lane MS): its ACP config options other than the model, the
// effort and the approval level's mode, which MOSS has controls and rules of its own for. General, for any ACP agent: an
// option counts when it has a fixed list of at least two values; the name shown is the agent's own, else the composer's
// plain fallback. `models.list {session}` carries the list; `session.setConfig` sets one (the person's app and CLI only).

/** An option as a picker shows it. */
export interface SessionOption {
  id: string;
  name?: string;
  current?: string;
  values: { value: string; name?: string }[];
}

/** What a session reports of its options (an `AgentSession`'s optional methods). */
export interface ReportsOptions {
  configOptions?(): readonly { id: string; category?: string; currentValue?: string; values: readonly string[] }[];
  optionLabels?(): ReadonlyMap<string, { name?: string; values: ReadonlyMap<string, string> }>;
}

/** The backend's own options: which ids are its model, effort and read-only mode. */
export interface OwnedOptions {
  modelOption: string | null;
  effortOption: string | null;
  /** The option MOSS's approval level drives (the backend's `readOnlyMode.option`). */
  readOnlyOption?: string;
}

/** Whether MOSS has a control of its own for this option, so the person never sets it as "an option". */
export function ownedByMoss(option: { id: string; category?: string }, owned: OwnedOptions): boolean {
  return option.id === owned.modelOption || option.id === owned.effortOption || option.id === owned.readOnlyOption
    || option.category === "model" || option.category === "thought_level" || option.category === "mode";
}

/** The options the person may choose from now, in the agent's order, at most 32. */
export function selectableOptions(session: ReportsOptions | undefined, owned: OwnedOptions): SessionOption[] {
  const labels = session?.optionLabels?.();
  const out: SessionOption[] = [];
  for (const o of session?.configOptions?.() ?? []) {
    if (out.length >= 32) break;
    if (ownedByMoss(o, owned) || o.values.length < 2) continue;
    const l = labels?.get(o.id);
    out.push({
      id: o.id,
      ...(l?.name !== undefined ? { name: l.name } : {}),
      ...(o.currentValue !== undefined ? { current: o.currentValue } : {}),
      values: o.values.slice(0, 200).map((value) => ({ value, ...(l?.values.get(value) !== undefined ? { name: l.values.get(value)! } : {}) })),
    });
  }
  return out;
}
