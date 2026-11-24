// The light model a provider serves for a model family (`FAMILY_LIGHT_MODELS`): pure, over the catalog the caller hands in.
// Nothing here reads a key, a setting or the credential store; `settings.ts` decides WHICH provider, this answers WHAT the
// provider offers.
import type { WinterCatalog } from "@waifucave/clover-provider-catalog";
import { FAMILY_DEFAULTS, FAMILY_LIGHT_MODELS, isWeak } from "./family-defaults";

type CatalogView = Pick<WinterCatalog, "families" | "models">;

export interface LightChoice {
  /** The provider-qualified catalog key of the light model on this provider. */
  tag: string;
  /** The effort the family declares for it (the caller drops it where the row doesn't list it). */
  effort?: string;
  /** The family the light model is the one of. */
  family: string;
}

/** The families whose vendors include the provider and that declare a light model, in catalog order. */
export function lightFamiliesOf(catalog: CatalogView, providerId: string): string[] {
  return (catalog.families ?? []).filter((f) => (f.vendorProviders ?? []).includes(providerId) && FAMILY_LIGHT_MODELS[f.id] !== undefined).map((f) => f.id);
}

/** The family a model of this provider belongs to: the catalog row's own `modelFamily` (the one a sonnet-5 and a sonnet-5.5
 *  share, slot or not), else the family whose slots, default or light model it is. Only a family with a light model. */
export function familyOfModel(catalog: CatalogView, providerId: string, modelKey: string): string | undefined {
  const row = catalog.models.find((m) => m.key === modelKey && m.providerId === providerId);
  if (row === undefined) return undefined;
  const own = (row as { modelFamily?: string }).modelFamily;
  if (own !== undefined && FAMILY_LIGHT_MODELS[own] !== undefined) return own;
  for (const f of catalog.families ?? []) {
    if (FAMILY_LIGHT_MODELS[f.id] === undefined) continue;
    const canonical = new Set<string>(f.slots.map((s) => s.canonicalModelId));
    const d = FAMILY_DEFAULTS[f.id];
    if (d !== undefined) canonical.add(d.model);
    canonical.add(FAMILY_LIGHT_MODELS[f.id]!.model);
    if (canonical.has(row.canonicalModelId)) return f.id;
  }
  return undefined;
}

/** The family's light model as this provider serves it (an aggregator's own row counts: it is that provider's offering): a row of that provider with the family's canonical id that isn't
 *  blocked or deprecated. Absent where the provider doesn't offer it (an OAuth sign-in's or an aggregator's catalog may not). */
export function lightModelOn(catalog: CatalogView, providerId: string, familyId: string): LightChoice | undefined {
  const light = FAMILY_LIGHT_MODELS[familyId];
  if (light === undefined) return undefined;
  const row = catalog.models.find((m) => m.providerId === providerId && m.canonicalModelId === light.model && m.status !== "blocked" && m.status !== "deprecated");
  if (row === undefined) return undefined;
  return { tag: row.key, family: familyId, ...(light.effort !== undefined ? { effort: light.effort } : {}) };
}

/**
 * The model that reviews commands (the bash safety reviewer and the plugin Review) on this provider for a family: THE
 * REVIEWER NEVER RUNS ON A WEAK MODEL (the controller's ruling, 2026-11-24: a weak model there can pass a dangerous
 * command or block safe ones). Titles and memory tidying may use a weak light model; the reviewer takes the family's
 * light model only when it is not weak, else the family's declared default as this provider serves it when that is not
 * weak. `undefined` when the family has neither here: the caller then falls to the person's own default model only if
 * that is not weak, and otherwise has no reviewer, which asks the person on a card (never allows; `agent/reviewer.ts`).
 */
export function reviewerModelOn(catalog: CatalogView, providerId: string, familyId: string): LightChoice | undefined {
  const light = lightModelOn(catalog, providerId, familyId);
  if (light !== undefined && !isWeak(catalog.models.find((m) => m.key === light.tag && m.providerId === providerId))) return light;
  const def = FAMILY_DEFAULTS[familyId];
  if (def === undefined) return undefined;
  const row = catalog.models.find((m) => m.providerId === providerId && m.canonicalModelId === def.model && m.status !== "blocked" && m.status !== "deprecated" && !isWeak(m));
  if (row === undefined) return undefined;
  const effort = FAMILY_LIGHT_MODELS[familyId]?.effort;
  return { tag: row.key, family: familyId, ...(effort !== undefined ? { effort } : {}) };
}
