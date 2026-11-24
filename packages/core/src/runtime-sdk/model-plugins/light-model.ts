// The light model a provider serves for a model family (`FAMILY_LIGHT_MODELS`): pure, over the catalog the caller hands in.
// Nothing here reads a key, a setting or the credential store; `settings.ts` decides WHICH provider, this answers WHAT the
// provider offers.
import type { WinterCatalog } from "@waifucave/clover-provider-catalog";
import { FAMILY_DEFAULTS, FAMILY_LIGHT_MODELS } from "./family-defaults";

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

/** A row this provider serves for jobs: not blocked, not deprecated (a deprecated or blocked light row counts as not served). */
const served = (m: { providerId: string; status: string }, providerId: string): boolean => m.providerId === providerId && m.status !== "blocked" && m.status !== "deprecated";

/** The family's light model as this provider serves it (an aggregator's own row counts: it is that provider's offering): a row of that provider with the family's canonical id that isn't
 *  blocked or deprecated. Absent where the provider doesn't offer it (an OAuth sign-in's or an aggregator's catalog may not). */
export function lightModelOn(catalog: CatalogView, providerId: string, familyId: string): LightChoice | undefined {
  const light = FAMILY_LIGHT_MODELS[familyId];
  if (light === undefined) return undefined;
  const row = catalog.models.find((m) => served(m, providerId) && m.canonicalModelId === light.model);
  if (row === undefined) return undefined;
  return { tag: row.key, family: familyId, ...(light.effort !== undefined ? { effort: light.effort } : {}) };
}

/** Every family's light model this provider serves, in THE FIXED PREFERENCE ORDER: cheapest input price first (a row with no
 *  price, a plan's, last), ties by family id. */
export function lightModelsServedOn(catalog: CatalogView, providerId: string): LightChoice[] {
  const out: { choice: LightChoice; price: number }[] = [];
  for (const familyId of Object.keys(FAMILY_LIGHT_MODELS).sort()) {
    const choice = lightModelOn(catalog, providerId, familyId);
    if (choice === undefined) continue;
    const row = catalog.models.find((m) => m.key === choice.tag) as { pricing?: { value?: { inputPerMTokUsd?: number } } } | undefined;
    out.push({ choice, price: row?.pricing?.value?.inputPerMTokUsd ?? Number.POSITIVE_INFINITY });
  }
  out.sort((a, b) => a.price - b.price || (a.choice.family < b.choice.family ? -1 : a.choice.family > b.choice.family ? 1 : 0));
  return out.map((o) => o.choice);
}

/**
 * The model one of MOSS's own jobs runs on, on provider P for the default model's family F (the controller's rule,
 * 2026-11-24, replacing a same-day fallback to F's default that reached 51 provider and family pairs):
 *   1. F's light model on P, when P serves it;
 *   2. else ANOTHER family's light model that P serves, by `lightModelsServedOn`'s fixed order (cheapest input first, ties
 *      by family id): on an aggregator there is nearly always a Haiku, a Flash-Lite, a Luna or a small open model;
 *   3. else, for the COMMAND SAFETY REVIEWER ONLY (a guard must work, and asking about every command is not acceptable), F's
 *      default on P. Titles, the dreamer and the cleaner do not run there (2026-11-22: a cost-only job never falls to a
 *      default model).
 * A deprecated or blocked light row counts as not served. `family` in the answer is the family whose model it is.
 */
export function lightModelForJob(catalog: CatalogView, providerId: string, familyId: string, job: "light" | "reviewer"): LightChoice | undefined {
  const own = lightModelOn(catalog, providerId, familyId);
  if (own !== undefined) return own;
  const other = lightModelsServedOn(catalog, providerId)[0];
  if (other !== undefined) return other;
  if (job !== "reviewer") return undefined;
  const def = FAMILY_DEFAULTS[familyId];
  if (def === undefined) return undefined;
  const row = catalog.models.find((m) => served(m, providerId) && m.canonicalModelId === def.model);
  return row === undefined ? undefined : { tag: row.key, family: familyId };
}
