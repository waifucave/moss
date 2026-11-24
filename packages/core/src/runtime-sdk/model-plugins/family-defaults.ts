// Each model family's ONE default: a model (by the catalog's canonical id) and an effort (the owner, 2026-11-20: "default
// pick a default per model family, claude would be opus 5.5 at medium. gpt would be gpt 6.2 sol at medium."). A provider's
// recommended model is its family's default as that provider serves it (`default-model.ts`); the effort is written with it.
//
// Kept here, beside the code that reads the catalog, because the families are declared in the agent SDK's catalog package
// (`@waifucave/clover-provider-catalog`), which this repo installs and cannot change without a release of it. One line
// per family; Claude and GPT are the owner's, the rest are the lane's picks (each family's balanced tier at medium where
// its rows take an effort), his to change. A family not listed (`o-series`, `other`) recommends nothing.
//
// A WEAK model is never a default (the catalog's hand-set `strength`, the class the file tools' read-before-edit rule
// reads: `weak` is a model that must have read what it edits; the owner's ruling of 2026-11-12 sets it by hand per model).
// A default must be `strong` or `medium` on every vendor row that serves it; `recommended()` also skips a weak row, so a
// row the catalog reclasses later stops being recommended without an edit here. A family whose vendors serve only weak
// models (Gemma, Llama in agent SDK 0.0.84) declares no default: its vendors recommend nothing there and the person picks.
// The 2026-11-24 catalog audit (lane CT) moved: gemini 3.7 Flash -> 3.8 Flash (Google routes 3.7 Flash to 3.8 Flash and
// no longer lists it, https://aistudio.google.com/docs/deprecations); mistral Medium 3.5 -> Large 3 (`mistral-large-2512`:
// Medium 3.5 is deprecated, retiring 2027-03-05, https://docs.mistral.ai/models; its named successor, Large 4, is in no
// published catalog yet); gemma and llama dropped (weak); grok 4.6 -> 4.7.
// With agent SDK 0.0.85 (2026-11-24): gemini -> gemini-4-hydrogen at medium (Google's everyday tier; 3.8 Flash is
// "previous-generation" and its price rises to Hydrogen's on 2027-01-01; no Vertex row yet, so Vertex recommends nothing for
// Gemini until one is published); mistral -> mistral-large-4 (GA since 2026-10-05; Large 3 deprecated 2026-10-31, retiring
// 2027-04-30, https://docs.mistral.ai/models); hunyuan -> hy4, light hy4-flash (Hy4 Preview goes offline 2026-12-07); muse
// light -> muse-ember-1.0.
//
// THE EFFORT STATES WHAT IS SENT (2026-11-24): `recommended()` drops a declared effort the row does not list, so a
// declaration the rows cannot take was a promise nobody got. Where every vendor row's vocabulary is low/high/max
// (DeepSeek V4 Pro, Kimi K3.1 Pro, GLM-5.3) the default is `high`: the nearest level to the medium every other family
// declares (low is the light jobs' effort). Before, nothing was written and the row's own default ran: high on DeepSeek
// and the Kimi Code plans, MAX on Moonshot's own API and on GLM, so those two now run one step lighter by default. Where
// the vendors' rows take no effort at all (Mistral Large 3, MiniMax M3, Command A, MiMo V2.6 Pro, Nova Pro, Nemotron 3
// Super, ERNIE 5.1) the default names none. Qwen 3.7 Plus, Hy4 Preview and Muse Spark keep medium: some of their vendors'
// rows take it, the rest take no effort.
export interface FamilyDefault {
  /** The catalog's canonical model id (`row.canonicalModelId`). */
  model: string;
  /** The effort written with it; dropped for a row whose effort list doesn't hold it. */
  effort?: string;
}

export const FAMILY_DEFAULTS: Readonly<Record<string, FamilyDefault>> = {
  claude: { model: "claude-opus-5.5", effort: "medium" }, // the owner's
  gpt: { model: "gpt-6.2-sol", effort: "medium" }, // the owner's
  gemini: { model: "gemini-4-hydrogen", effort: "medium" }, // Gemini 4's everyday tier (agent SDK 0.0.85); not on Vertex yet
  grok: { model: "grok-4.7", effort: "medium" }, // xAI's current model (https://docs.x.ai/docs/release-notes.md, September 2026), same price as 4.6
  deepseek: { model: "deepseek-v4-pro", effort: "high" }, // rows take low, high, max: no medium
  kimi: { model: "kimi-k3.1-pro", effort: "high" }, // rows take low, high, max: no medium
  qwen: { model: "qwen3.7-plus", effort: "medium" },
  mistral: { model: "mistral-large-4" }, // its row takes no effort (agent SDK 0.0.85)
  glm: { model: "glm-5.3", effort: "high" }, // rows take low, high, max: no medium
  minimax: { model: "minimax-m3" }, // its vendors' rows take no effort
  command: { model: "command-a-03-2025" }, // its vendors' rows take no effort
  mimo: { model: "mimo-v2.6-pro" }, // its vendors' rows take no effort
  nova: { model: "amazon.nova-pro" }, // its row takes no effort
  nemotron: { model: "nemotron-3-super-120b-a12b" }, // its vendors' rows take no effort
  ernie: { model: "ernie-5.1" }, // its vendors' rows take no effort
  hunyuan: { model: "hy4", effort: "medium" }, // Hy4 Preview goes offline 2026-12-07 (agent SDK 0.0.85)
  muse: { model: "muse-spark-1.3", effort: "medium" },
  "gpt-oss": { model: "gpt-oss-120b", effort: "medium" },
};

// Each model family's LIGHT model, beside its default and in the same shape (the owner, 2026-11-21: "a light model per
// family"): the cheap, fast tier MOSS's own background jobs (conversation titles, memory tidying) run on, so a title is
// not written by the person's strongest model. The same rule for every family, so a provider plugin's family gets one by
// declaring it here, and no code names a plugin. The lane's picks, his to change:
//   * a family whose catalog names a smaller tier takes it (Claude: Haiku 5.5, which the catalog carries beside its
//     slot list; GPT: the `luna` slot; Gemini `lite`; DeepSeek `flash`; GLM and MiMo `flash`; Mistral `small`; Qwen `small`;
//     Nova `micro`; gpt-oss `20b`);
//   * a family with no cheaper tier (one model, or tiers that differ in speed or purpose, not size) has its default as
//     its light model; the effort is what makes the job light there;
//   * a family with no default (its vendors serve only weak models: Gemma, Llama) still names a light model, so a person who picks one of
//     its models has its jobs run on it.
// A light model may be weak (the `strength` mark is about how a model edits files, not about judging a command): it is a
// deliberate choice, never a default.
// THE LIGHT MODEL IS ALSO THE COMMAND SAFETY REVIEWER (and the plugin Review), so it is "the smallest model that can still
// judge a shell command sensibly", not the vendor's tiniest. The reviewer (`agent/reviewer.ts`) sends a short instruction
// and the command and asks for a plain JSON reply ({"verdict","reason"}): no structured-output mode, no forced tool, no
// effort; any context of 128K or more fits it many times over.
// The 2026-11-24 audit (lane CT) moved, each a current tier that judges a command as well as the one it replaces:
// GLM 4.7 Flash -> GLM-5.3 Flash (newer generation, served by all four GLM vendors; 4.7 Flash is missing on
// zhipu-anthropic); Qwen 3.6 27B -> Qwen 3.8 Flash (Qwen's current Flash, 1M context; on 7 of the 11 Qwen vendors, 3.6
// 27B on 5; the four Coding Plan providers carry neither); MiniMax M3 -> MiniMax M3.1 Flash (MiniMax's current small
// tier, 1M context, on all six vendors); Llama 4 Scout -> Llama 3.3 70B (served by both Llama vendors; Scout is not on
// Together). Kept: Nemotron 3 Super, not Nemotron 3.5 Lightning 30B-A3B (3B active parameters does not clearly qualify
// to judge a command).
// The effort is the one a job that has none of its own asks for (titles; the dreamer and the cleaner keep theirs) when the
// person set none for it; a row that doesn't list it drops it.
// A family not listed (`o-series`, `other`) has no light model.
export const FAMILY_LIGHT_MODELS: Readonly<Record<string, FamilyDefault>> = {
  claude: { model: "claude-haiku-5.5", effort: "low" },
  gpt: { model: "gpt-6-luna", effort: "low" },
  gemini: { model: "gemini-3.1-flash-lite", effort: "low" },
  deepseek: { model: "deepseek-flash", effort: "low" },
  glm: { model: "glm-5.3-flash", effort: "low" },
  mimo: { model: "mimo-v2.6-flash", effort: "low" },
  mistral: { model: "mistral-small-latest", effort: "low" },
  qwen: { model: "qwen3.8-flash", effort: "low" },
  nova: { model: "amazon.nova-micro", effort: "low" },
  "gpt-oss": { model: "gpt-oss-20b", effort: "low" },
  minimax: { model: "minimax-m3.1-flash", effort: "low" },
  // One tier, or tiers that differ in speed or purpose rather than size: the default is the light model.
  grok: { model: "grok-4.7", effort: "low" },
  kimi: { model: "kimi-k3.1-pro", effort: "low" },
  command: { model: "command-a-03-2025", effort: "low" },
  ernie: { model: "ernie-5.1", effort: "low" },
  hunyuan: { model: "hy4-flash", effort: "low" },
  muse: { model: "muse-ember-1.0", effort: "low" }, // Meta's "efficient execution model" (agent SDK 0.0.85)
  nemotron: { model: "nemotron-3-super-120b-a12b", effort: "low" },
  // Its vendors serve only weak models, so no default; the light model is the family's own (a person who picks one gets its jobs on it).
  gemma: { model: "gemma-4-31b-it", effort: "low" },
  llama: { model: "llama-3.3-70b-instruct-turbo", effort: "low" },
};
