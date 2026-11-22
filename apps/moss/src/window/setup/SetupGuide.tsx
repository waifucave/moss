// The setup guide (the owner, 2026-11-20: "we should have a setup guide as soon the user opens the app"): what gets a
// person to a first working reply, in three steps: add a model provider (its terms first, then a key or a sign-in),
// the default model (already chosen when one provider was added, with the picker a click away; a picker when several),
// and done, which lands in the default bot's conversation ready to type. Skippable at every step. The engine holds what is
// set up and whether the guide was skipped (`setup.state`), so finishing or skipping it here holds for MOSS Code too.
// MOSS's plain look: neutral greys, the primary action black (light) or near-white (dark), no tint.
import { useEffect, useMemo, useRef, useState } from "react";
import { orderProviders, SEARCH_FROM } from "@waifucave/moss-protocol/provider-order";
import { bridge } from "../bridge";
import { SignInRow } from "../settings/SettingsPage";
import type { ModelRow, ProviderRow, RelayRow, SetupRow } from "../../shared/view";

export type SetupStep = "providers" | "model" | "done" | "relay";

/** A model as the guide names it: "Claude Opus 5.5 · medium" when it has an effort. */
function withEffort(name: string, effort: string | undefined): string {
  return effort === undefined || effort === "" ? name : `${name} · ${effort}`;
}

/** A model named as the model step names it: "Claude Opus 5.5 · medium · Anthropic". */
function named(name: string, effort: string | undefined, provider: string | undefined): string {
  const m = withEffort(name, effort);
  return provider === undefined || provider === "" ? m : `${m} · ${provider}`;
}

function providerOf(tag: string | undefined): string | undefined {
  return tag === undefined || !tag.includes("/") ? undefined : tag.slice(0, tag.indexOf("/"));
}

/** The guide's words (MOSS ships English; its other text is written in place the same way). */
const WORDS = {
  step: (n: number) => `Step ${n} of 3`,
  skip: "Skip for now",
  next: "Next",
  back: "Back",
  welcome: "Welcome to MOSS",
  intro: "MOSS needs a model to talk to. Add a provider: sign in to a subscription you have, or paste an API key.",
  noClaude: "Claude subscriptions can't be used here; an Anthropic Console sign-in (billed to your API account) can.",
  search: "Search providers",
  loading: "Looking for model providers…",
  none: "No model provider is installed. Add a model plugin from Plugins, then come back here.",
  noMatch: "No provider matches that.",
  added: "Added",
  terms: (name: string) => `Read ${name}'s terms`,
  accept: (name: string) => `I accept ${name}'s terms`,
  needOne: "Add one provider to go on.",
  ready: (n: number) => (n === 1 ? "1 provider is added." : `${n} providers are added.`),
  modelTitle: "Your default model",
  modelIntro: "Your bots use this model unless you pick another for one of them in its settings.",
  chosen: "MOSS will use",
  change: "Change",
  pick: "You added more than one provider: pick the model MOSS uses by default.",
  noModels: "None of your providers has a model MOSS can use yet. Go back and add another provider.",
  modelLabel: "Default model",
  doneTitle: "You're set up",
  doneIntro: (model: string, bot: string) => `${model} answers ${bot}'s first message. You can change it, or add providers, in Settings at any time.`,
  talk: (bot: string) => `Talk to ${bot}`,
  failed: "That didn't work. Try again.",
  signedOut: (model: string, provider: string) => `Your default model, ${model}, needs you signed in to ${provider}.`,
  signIn: "Sign in",
  devices: "Connect your other devices",
  relayTitle: "Connecting your devices",
  relayIntro: "Your computers and phone connect to each other directly. When two of them can't (behind strict routers, on a mobile network), a relay carries their traffic between them.",
  relayPrivacy: "Everything stays end-to-end encrypted, so a relay never sees what your devices say. It does see which of your devices are online and how much they send.",
  relayN0: "n0's public relays",
  relayN0Detail: "On by default. Run by n0, free to use.",
  relayCustom: "A server of your own",
  relayCustomDetail: "Your own relay server's address.",
  relayCustomLabel: "Relay server's address",
  relayCloud: "Your cloud computer",
  relayCloudDetail: "Available once you have a cloud computer.",
  relayCloudflare: "Your own Cloudflare account",
  relayCloudflareDetail: "Not available in this build yet.",
  relayOff: "No relay",
  relayOffDetail: "Devices that can't reach each other directly won't connect at all. A small share of pairs are like that.",
  relaySave: "Save",
  relaySaved: "Saved.",
  relayLabel: "How your devices connect",
};

/** One plain line when the default model's provider is signed out (a key removed, a sign-in that lapsed), in the model's and
 *  the provider's own names (any provider: the catalog's row for the tag, else the tag's parts). With `onSignIn`, a button that
 *  takes the person to where they sign in (the guide's provider step). */
export function SignedOutLine(props: { tag: string; onSignIn?: () => void }) {
  const [names, setNames] = useState<{ model: string; provider: string } | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void bridge().models().then((rows) => {
      const row = "waiting" in rows ? undefined : rows.find((m) => m.id === props.tag);
      if (live) setNames({ model: row?.title ?? props.tag, provider: row?.provider ?? providerOf(props.tag) ?? props.tag });
    }, () => live && setNames({ model: props.tag, provider: providerOf(props.tag) ?? props.tag }));
    return () => { live = false; };
  }, [props.tag]);
  if (names === undefined) return null;
  return (
    <p className="setup__signed-out" role="status" data-setup-signed-out={props.tag}>
      {WORDS.signedOut(names.model, names.provider)}
      {props.onSignIn !== undefined ? <> <button type="button" className="text-button" onClick={props.onSignIn} data-setup="sign-in">{WORDS.signIn}</button></> : null}
    </p>
  );
}

export function SetupGuide(props: { setup: SetupRow | undefined; botName: string; initialStep?: SetupStep; onClose: () => void; onDone: () => void }) {
  const [step, setStep] = useState<SetupStep>(props.initialStep ?? "providers");
  const [model, setModel] = useState<{ row: ModelRow; effort?: string } | undefined>(undefined);
  const [note, setNote] = useState<string | undefined>(undefined);
  useEffect(() => { if (props.initialStep !== undefined) setStep(props.initialStep); }, [props.initialStep]);
  const skip = async (): Promise<void> => {
    if (await bridge().skipSetup()) props.onClose();
    else setNote(WORDS.failed);
  };
  const n = step === "providers" ? 1 : step === "model" ? 2 : 3;
  // The relay page is the guide's optional page after the last step (Connect your other devices): no step number of its own.
  return (
    <div className="setup" role="dialog" aria-modal="true" aria-labelledby="setup-title" data-setup-step={step}>
      <section className="setup__card">
        {step === "relay" ? null : <p className="setup__step muted small">{WORDS.step(n)}</p>}
        {step === "relay" ? <Relay onBack={() => setStep("done")} />
          : step === "providers" ? <Providers setup={props.setup} onNext={() => { setNote(undefined); setStep("model"); }} onSkip={() => void skip()} />
          : step === "model" ? <Model setup={props.setup} onBack={() => setStep("providers")} onSkip={() => void skip()} onNext={(m, effort) => { setModel({ row: m, ...(effort !== undefined ? { effort } : {}) }); setNote(undefined); setStep("done"); }} />
          : <Done onRelay={() => setStep("relay")} model={named(model?.row.title ?? props.setup?.default?.model ?? "", model !== undefined ? model.effort : props.setup?.default?.effort, model?.row.provider ?? providerOf(props.setup?.default?.model))} bot={props.botName} onBack={() => setStep("model")} onDone={props.onDone} />}
        {note !== undefined ? <p className="add__note" role="status">{note}</p> : null}
      </section>
    </div>
  );
}

function Actions(props: { onBack?: () => void; onSkip?: () => void; next: { label: string; disabled?: boolean; run: () => void; data: string } }) {
  return (
    <footer className="setup__actions">
      {props.onBack !== undefined ? <button type="button" className="text-button" onClick={props.onBack} data-setup="back">{WORDS.back}</button> : null}
      <span className="setup__gap" />
      {props.onSkip !== undefined ? <button type="button" className="text-button setup__skip" onClick={props.onSkip} data-setup="skip">{WORDS.skip}</button> : null}
      <button type="button" className="text-button text-button--solid" disabled={props.next.disabled === true} onClick={props.next.run} data-setup={props.next.data}>{props.next.label}</button>
    </footer>
  );
}

const added = (p: ProviderRow) => p.auth.some((a) => a.state === "signed-in" || a.state === "refreshing");

/** Step 1: the model providers the installed model plugins offer, each opened to its own way in. */
function Providers(props: { setup: SetupRow | undefined; onNext: () => void; onSkip: () => void }) {
  const [rows, setRows] = useState<ProviderRow[] | "waiting" | undefined>(undefined);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<string | undefined>(undefined);
  const load = (): void => { void bridge().setupProviders().then((r) => setRows("waiting" in r ? "waiting" : r)); };
  useEffect(load, []);
  // A key or a sign-in finished elsewhere (the browser, MOSS Code): read the rows again.
  useEffect(load, [props.setup?.providers.join(",")]);
  // The order both apps' guides share (added, sign-ins, the big API-key providers, then by name); search over all.
  const shown = useMemo(() => (rows === undefined || rows === "waiting" ? [] : orderProviders(rows.map((r) => ({ ...r, id: r.pluginId })), query)), [rows, query]);
  const count = rows === undefined || rows === "waiting" ? 0 : rows.filter(added).length;
  return (
    <>
      <h1 id="setup-title">{WORDS.welcome}</h1>
      <p>{WORDS.intro}</p>
      {props.setup?.signedOut !== undefined ? <SignedOutLine tag={props.setup.signedOut} /> : null}
      <p className="muted small">{WORDS.noClaude}</p>
      {rows === undefined ? <p className="muted">{WORDS.loading}</p> : rows === "waiting" || rows.length === 0 ? <p className="muted">{WORDS.none}</p> : (
        <>
          {rows.length >= SEARCH_FROM ? (
            <label className="search setup__search">
              <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.5" /><path d="m10.5 10.5 3 3" /></svg>
              <input type="search" placeholder={WORDS.search} aria-label={WORDS.search} value={query} onChange={(e) => setQuery(e.target.value)} data-setup-search />
            </label>
          ) : null}
          <ul className="setup__providers">
            {shown.length === 0 ? <li className="muted">{WORDS.noMatch}</li> : shown.map((p) => (
              <Provider key={p.pluginId} row={p} open={open === p.pluginId || shown.length === 1} onToggle={() => setOpen((o) => (o === p.pluginId ? undefined : p.pluginId))} onChanged={load} />
            ))}
          </ul>
        </>
      )}
      <p className="muted small" role="status" data-setup-ready={count}>{count > 0 ? WORDS.ready(count) : WORDS.needOne}</p>
      <Actions onSkip={props.onSkip} next={{ label: WORDS.next, disabled: count === 0, run: props.onNext, data: "next" }} />
    </>
  );
}

function Provider(props: { row: ProviderRow; open: boolean; onToggle: () => void; onChanged: () => void }) {
  const p = props.row;
  const [accepted, setAccepted] = useState(p.terms === undefined || added(p));
  return (
    <li className={`setup__provider${props.open ? " is-open" : ""}`} data-setup-provider={p.pluginId}>
      <button type="button" className="setup__provider-head" onClick={props.onToggle} aria-expanded={props.open}>
        <span>{p.name}</span>
        {added(p) ? <span className="chip chip--on">{WORDS.added}</span> : null}
      </button>
      {props.open ? (
        <div className="setup__provider-body">
          {p.terms !== undefined ? (
            <>
              {"link" in p.terms
                ? <button type="button" className="setup__link" onClick={() => void bridge().openTerms(p.pluginId)}>{WORDS.terms(p.name)}</button>
                : <blockquote className="setup__terms">{p.terms.text}</blockquote>}
              <label className="setup__check"><input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} data-setup-terms={p.pluginId} />{WORDS.accept(p.name)}</label>
            </>
          ) : null}
          <fieldset className="setup__ways" disabled={!accepted}>
            <ul className="kv ma2-keys">
              {p.auth.map((a) => (
                <SignInRow key={a.index} row={{ pluginId: p.pluginId, name: p.name, index: a.index, method: a.method, state: a.state, ...(a.account !== undefined ? { account: a.account } : {}) }} onChanged={props.onChanged} />
              ))}
            </ul>
            {p.auth.map((a) => (a.help !== undefined && a.state !== "signed-in" ? <p key={`h${a.index}`} className="muted small">{a.help}</p> : null))}
          </fieldset>
        </div>
      ) : null}
    </li>
  );
}

/** Step 2: the default model. One provider added: its model is already chosen, the picker a click away. Several: pick. */
function Model(props: { setup: SetupRow | undefined; onBack: () => void; onSkip: () => void; onNext: (m: ModelRow, effort: string | undefined) => void }) {
  const [models, setModels] = useState<ModelRow[] | undefined>(undefined);
  const [setup, setSetup] = useState<SetupRow | undefined>(props.setup);
  const [picking, setPicking] = useState(false);
  const [value, setValue] = useState("");
  const [why, setWhy] = useState<string | undefined>(undefined);
  useEffect(() => {
    void Promise.all([bridge().models(), bridge().setup()]).then(([m, s]) => {
      const ready = "waiting" in m ? [] : m.filter((x) => x.ready);
      const st = "waiting" in s ? props.setup : s;
      setModels(ready);
      setSetup(st);
      const first = st?.default?.model ?? (st?.providers ?? []).map((p) => st?.recommended?.[p]?.model).find((x) => x !== undefined && ready.some((r) => r.id === x)) ?? ready[0]?.id ?? "";
      setValue(first);
    });
  }, []);
  const current = setup?.default?.model;
  const row = (id: string | undefined) => models?.find((m) => m.id === id);
  const groups = useMemo(() => {
    const out = new Map<string, ModelRow[]>();
    for (const m of models ?? []) out.set(m.provider, [...(out.get(m.provider) ?? []), m]);
    return [...out];
  }, [models]);
  const next = async (): Promise<void> => {
    const m = row(value);
    if (m === undefined) return;
    let effort = setup?.default?.effort;
    if (value !== current) {
      const r = await bridge().setDefaultModel(value);
      if (!r.ok) { setWhy(r.why); return; }
      effort = r.setup.default?.effort;
    }
    props.onNext(m, effort);
  };
  const picker = (
    <label className="setup__field">
      <span className="muted small">{WORDS.modelLabel}</span>
      <select className="ma2-field" value={value} onChange={(e) => setValue(e.target.value)} aria-label={WORDS.modelLabel} data-setup-model-picker>
        {groups.map(([provider, ms]) => (
          <optgroup key={provider} label={provider}>
            {ms.map((m) => <option key={m.id} value={m.id}>{m.title}</option>)}
          </optgroup>
        ))}
      </select>
    </label>
  );
  return (
    <>
      <h1 id="setup-title">{WORDS.modelTitle}</h1>
      <p>{WORDS.modelIntro}</p>
      {models === undefined ? <p className="muted">{WORDS.loading}</p> : models.length === 0 ? <p className="muted">{WORDS.noModels}</p>
        : current !== undefined && !picking ? (
          <div className="setup__chosen" data-setup-default={current}>
            <span><span className="muted">{WORDS.chosen} </span><strong>{withEffort(row(current)?.title ?? current, setup?.default?.effort)}</strong><span className="muted"> · {row(current)?.provider ?? current.slice(0, current.indexOf("/"))}</span></span>
            <button type="button" className="text-button" onClick={() => setPicking(true)} data-setup="change">{WORDS.change}</button>
          </div>
        ) : (
          <>
            {current === undefined ? <p className="muted small">{WORDS.pick}</p> : null}
            {picker}
          </>
        )}
      {why !== undefined ? <p className="ma2-why small" role="status">{why}</p> : null}
      <Actions onBack={props.onBack} onSkip={props.onSkip} next={{ label: WORDS.next, disabled: models === undefined || models.length === 0 || value === "", run: () => void next(), data: "next" }} />
    </>
  );
}

/** Step 3: done: the default bot's conversation, ready to type. */
function Done(props: { model: string; bot: string; onBack: () => void; onDone: () => void; onRelay: () => void }) {
  return (
    <>
      <h1 id="setup-title">{WORDS.doneTitle}</h1>
      <p data-setup-done-model={props.model}>{WORDS.doneIntro(props.model, props.bot)}</p>
      <p><button type="button" className="setup__link" onClick={props.onRelay} data-setup="relay">{WORDS.devices}</button></p>
      <Actions onBack={props.onBack} next={{ label: WORDS.talk(props.bot), run: props.onDone, data: "start" }} />
    </>
  );
}

/** The relay page (spec §8.3): what a relay is for, n0's public relays on by default, and the person's own choices. The cloud
 *  computer's relay and a Cloudflare relay are relay plugins the links don't take yet: shown, and not offered. */
function Relay(props: { onBack: () => void }) {
  const [saved, setSaved] = useState<RelayRow | undefined>(undefined);
  const [mode, setMode] = useState<RelayRow["mode"]>("n0");
  const [url, setUrl] = useState("");
  const [note, setNote] = useState<string | undefined>(undefined);
  const touched = useRef(false);
  useEffect(() => {
    // What the engine has kept, unless the person has already started choosing.
    void bridge().relay().then((r) => { if ("waiting" in r) { setNote(WORDS.failed); return; } setSaved(r); if (!touched.current) { setMode(r.mode); setUrl(r.url ?? ""); } });
  }, []);
  const save = async (): Promise<void> => {
    const r = await bridge().setRelay({ mode, ...(mode === "custom" ? { url: url.trim() } : {}) });
    if (r.ok) { setSaved(r.relay); setUrl(r.relay.url ?? ""); setNote(WORDS.relaySaved); } else setNote(r.why);
  };
  const changed = saved !== undefined && (saved.mode !== mode || (mode === "custom" && (saved.url ?? "") !== url.trim()));
  const choice = (value: RelayRow["mode"] | "cloud" | "cloudflare", title: string, detail: string, off = false) => (
    <label className="setup__check" data-setup-relay={value} aria-disabled={off || undefined}>
      <input type="radio" name="relay" value={value} disabled={off} checked={!off && mode === value} onChange={() => undefined} onClick={() => { touched.current = true; setNote(undefined); setMode(value as RelayRow["mode"]); }} />
      <span><strong>{title}</strong> <span className="muted small">{detail}</span></span>
    </label>
  );
  return (
    <>
      <h1 id="setup-title">{WORDS.relayTitle}</h1>
      <p>{WORDS.relayIntro}</p>
      <p className="muted small">{WORDS.relayPrivacy}</p>
      <fieldset className="setup__ways" aria-label={WORDS.relayLabel}>
        {choice("n0", WORDS.relayN0, WORDS.relayN0Detail)}
        {choice("custom", WORDS.relayCustom, WORDS.relayCustomDetail)}
        {mode === "custom" ? <input className="ma2-field" type="url" placeholder="https://relay.example.com" aria-label={WORDS.relayCustomLabel} value={url} onChange={(e) => { touched.current = true; setNote(undefined); setUrl(e.target.value); }} data-setup-relay-url /> : null}
        {choice("cloud", WORDS.relayCloud, WORDS.relayCloudDetail, true)}
        {choice("cloudflare", WORDS.relayCloudflare, WORDS.relayCloudflareDetail, true)}
        {choice("off", WORDS.relayOff, WORDS.relayOffDetail)}
      </fieldset>
      {note !== undefined ? <p className="muted small" role="status" data-setup-relay-note>{note}</p> : null}
      <Actions onBack={props.onBack} next={{ label: WORDS.relaySave, disabled: !changed || (mode === "custom" && url.trim() === ""), run: () => void save(), data: "relay-save" }} />
    </>
  );
}
