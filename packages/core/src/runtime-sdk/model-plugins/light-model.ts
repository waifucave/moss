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

/** The family's light model as this provider serves it (an aggregator's own row counts: it is that provider's offering): a row of that provider with the family's canonical id that isn't
 *  blocked or deprecated. Where the provider doesn't serve the light model but does serve the family's DEFAULT (2026-11-24, the
 *  controller's ask: Cerebras serves gpt-oss-120b and not 20b, https://inference-docs.cerebras.ai/models/overview; the Qwen Coding
 *  Plan serves qwen3.7-plus and no Flash, "Models not listed above are not supported", https://www.alibabacloud.com/help/en/model-studio/coding-plan),
 *  the jobs run on that default there rather than not at all; the light effort still goes with it. Absent where it serves neither. */
export function lightModelOn(catalog: CatalogView, providerId: string, familyId: string): LightChoice | undefined {
  const light = FAMILY_LIGHT_MODELS[familyId];
  if (light === undefined) return undefined;
  const usable = (m: { providerId: string; status: string }) => m.providerId === providerId && m.status !== "blocked" && m.status !== "deprecated";
  const row = catalog.models.find((m) => usable(m) && m.canonicalModelId === light.model)
    ?? (FAMILY_DEFAULTS[familyId] !== undefined ? catalog.models.find((m) => usable(m) && m.canonicalModelId === FAMILY_DEFAULTS[familyId]!.model) : undefined);
  if (row === undefined) return undefined;
  return { tag: row.key, family: familyId, ...(light.effort !== undefined ? { effort: light.effort } : {}) };
}
