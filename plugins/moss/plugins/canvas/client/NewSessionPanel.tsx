// The + flow (spec revision 20, §9.5): a small panel under the + button, every step preselected (preselect.ts), so
// pressing Create at once works: the agent, then its model and effort, then the folder. Creating starts the session
// (`agent.start` from the part, the person's press) and opens its tab.
import { useEffect, useRef, useState } from "react";
import { Mark } from "./Mark";
import { agentChoices, effortsFor, modelName, pickAgent, pickFolder, pickModel, startParams, type AgentChoice, type AgentOptions, type BackendRow, type FolderToken, type ModelPick, type RecentStart } from "./preselect";
import { byPerson } from "./Block";
import { S } from "./strings";

/** What the panel asks of the core. Each acting call is made inside the person's press that asks for it. */
export interface Starter {
  options(agent: string): Promise<AgentOptions | undefined>;
  /** The app's own folder dialog (`ui.pick`, use `agent.start`). */
  pickFolder(): Promise<FolderToken | undefined>;
  /** `agent.start`; the new session's id. */
  start(params: Record<string, string>): Promise<string | undefined>;
}

export type PanelStep = "model" | "folder";

export interface NewSessionPanelProps {
  rows: readonly BackendRow[] | undefined;
  here: string | undefined;
  /** The person's last start and recent folders, asked for in the + press. */
  recent: Promise<RecentStart | undefined>;
  folders: Promise<readonly FolderToken[] | undefined>;
  starter: Starter;
  onStarted(session: string): void;
  onClose(): void;
  /** A step shown open at first (the gallery's pictures). */
  initialStep?: PanelStep;
}

export function NewSessionPanel(p: NewSessionPanelProps) {
  const choices = p.rows === undefined ? undefined : agentChoices(p.rows, p.here);
  const [recent, setRecent] = useState<RecentStart | undefined | null>(null);
  const [folders, setFolders] = useState<readonly FolderToken[]>([]);
  const [agent, setAgent] = useState<string | undefined>();
  const [agentFrom, setAgentFrom] = useState<string>("none");
  const [options, setOptions] = useState<Record<string, AgentOptions | undefined | null>>({});
  const [pick, setPick] = useState<ModelPick | undefined>();
  const [folder, setFolder] = useState<FolderToken | undefined>();
  const [step, setStep] = useState<PanelStep | undefined>(p.initialStep);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    void p.recent.then((r) => live && setRecent(r ?? undefined), () => live && setRecent(undefined));
    void p.folders.then((f) => {
      if (!live) return;
      setFolders(f ?? []);
      setFolder((was) => was ?? pickFolder(f ?? undefined));
    }, () => undefined);
    return () => { live = false; };
  }, [p.recent, p.folders]);

  // The agent, once the list and the last start are known; never over the person's own choice.
  useEffect(() => {
    if (choices === undefined || recent === null || agent !== undefined) return;
    const got = pickAgent(choices, recent);
    if (got.agent !== undefined) {
      setAgent(got.agent);
      setAgentFrom(got.from);
    }
  }, [choices, recent, agent]);

  // Its options, then the model and effort.
  useEffect(() => {
    if (agent === undefined || options[agent] !== undefined) return;
    let live = true;
    setOptions((o) => ({ ...o, [agent]: null }));
    void p.starter.options(agent).then((o) => live && setOptions((was) => ({ ...was, [agent]: o })), () => live && setOptions((was) => ({ ...was, [agent]: undefined })));
    return () => { live = false; };
  }, [agent]); // eslint-disable-line react-hooks/exhaustive-deps

  const opts = agent === undefined ? undefined : options[agent];
  useEffect(() => {
    if (agent === undefined || opts === null) return;
    setPick(pickModel(agent, opts, recent ?? undefined));
  }, [agent, opts, recent]);


  const chosen = choices?.find((c) => c.id === agent);
  const ready = agent !== undefined && folder !== undefined && pick !== undefined && !busy;
  // Once every step is chosen, Create has the focus: Enter (or Space) creates at once.
  const createRef = useRef<HTMLButtonElement>(null);
  const focused = useRef(false);
  useEffect(() => {
    if (ready && !focused.current) {
      focused.current = true;
      createRef.current?.focus();
    }
  }, [ready]);

  const create = (e: React.MouseEvent) => {
    if (!byPerson(e) || !ready) return;
    setBusy(true);
    setError(undefined);
    // Inside the press: `agent.start` is the person's.
    void p.starter.start(startParams(agent!, folder!, pick!)).then(
      (session) => { if (session !== undefined) p.onStarted(session); },
      (err: unknown) => setError(err instanceof Error ? err.message : String(err)),
    ).finally(() => setBusy(false));
  };
  const chooseFolder = (e: React.MouseEvent) => {
    if (!byPerson(e)) return;
    setError(undefined);
    void p.starter.pickFolder().then((f) => {
      if (f === undefined) return;
      setFolders((list) => [f, ...list.filter((x) => x.token !== f.token)]);
      setFolder(f);
    }, (err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  };

  return (
    <div className="cv-panel" ref={panel} role="dialog" aria-label={S.newSession} onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); p.onClose(); } }}>
      <div className="cv-panel__head">
        <h2 className="cv-panel__title">{S.newSession}</h2>
        <button type="button" className="cv-icon" aria-label={S.close} onClick={p.onClose}>×</button>
      </div>

      <h3 className="cv-panel__label" id="cv-agent-label">
        {S.agent} <span className="cv-panel__hint">· {agentFrom === "last" ? S.agentHint : agentFrom === "moss" ? S.agentHintDefault : ""}</span>
      </h3>
      {choices === undefined ? <p className="cv-panel__note" role="status">{S.loading}</p> : choices.length === 0 ? <p className="cv-panel__note" role="status">{S.noAgents}</p> : (
        <div className="cv-chips" role="radiogroup" aria-labelledby="cv-agent-label">
          {choices.map((c) => <AgentChip key={c.id} choice={c} checked={c.id === agent} onPick={() => { setAgent(c.id); setAgentFrom("picked"); setStep(undefined); }} />)}
        </div>
      )}

      <h3 className="cv-panel__label">
        {S.modelEffort} <span className="cv-panel__hint">· {pick?.from === "last" ? S.modelHintLast : S.modelHintDefault}</span>
      </h3>
      <div className="cv-step" data-open={step === "model" || undefined}>
        <span className="cv-step__value">{modelSummary(chosen, opts ?? undefined, pick)}</span>
        {pick !== undefined && pick.from !== "unknown" && (
          <button type="button" className="cv-link" aria-expanded={step === "model"} onClick={() => setStep(step === "model" ? undefined : "model")}>{step === "model" ? S.done2 : S.change}</button>
        )}
      </div>
      {step === "model" && pick !== undefined && opts && (
        <div className="cv-step__body">
          <label className="cv-field">
            <span>{S.model}</span>
            <select value={pick.model ?? ""} onChange={(e) => { const m = e.target.value; const efforts = effortsFor(opts, m); setPick({ model: m, ...(pick.effort !== undefined && efforts.includes(pick.effort) ? { effort: pick.effort } : opts.models.find((x) => x.id === m)?.defaultEffort !== undefined ? { effort: opts.models.find((x) => x.id === m)!.defaultEffort! } : {}), from: pick.from }); }}>
              {opts.models.map((m) => <option key={m.id} value={m.id}>{modelName(opts, m.id)}</option>)}
            </select>
          </label>
          {effortsFor(opts, pick.model).length > 0 && (
            <label className="cv-field">
              <span>{S.effort}</span>
              <select value={pick.effort ?? ""} onChange={(e) => { const v = e.target.value; const { effort: _e, ...rest } = pick; setPick(v === "" ? rest : { ...rest, effort: v }); }}>
                <option value="">{S.defaultEffort}</option>
                {effortsFor(opts, pick.model).map((x) => <option key={x} value={x}>{x}</option>)}
              </select>
            </label>
          )}
        </div>
      )}

      <h3 className="cv-panel__label">
        {S.folder} <span className="cv-panel__hint">{folder !== undefined && folders[0]?.token === folder.token ? `· ${S.folderHintLast}` : ""}</span>
      </h3>
      <div className="cv-step" data-open={step === "folder" || undefined}>
        <span className="cv-step__value" data-none={folder === undefined || undefined}>{folder?.name ?? S.folderNone}</span>
        {folders.length > 0 ? (
          <button type="button" className="cv-link" aria-expanded={step === "folder"} onClick={() => setStep(step === "folder" ? undefined : "folder")}>{step === "folder" ? S.done2 : S.change}</button>
        ) : (
          <button type="button" className="cv-link" onClick={chooseFolder}>{S.chooseFirstFolder}</button>
        )}
      </div>
      {step === "folder" && (
        <div className="cv-step__body" role="radiogroup" aria-label={S.folder}>
          {folders.map((f) => (
            <button key={f.token} type="button" role="radio" aria-checked={folder?.token === f.token} className="cv-folder" onClick={() => setFolder(f)}>{f.name}</button>
          ))}
          <button type="button" className="cv-link cv-folder__other" onClick={chooseFolder}>{S.chooseFolder}</button>
        </div>
      )}

      {folder === undefined && <p className="cv-panel__note">{S.needFolder}</p>}
      <button ref={createRef} type="button" className="cv-create" disabled={!ready} onClick={create}>{busy ? S.creating : S.create}</button>
      {error !== undefined && <p className="cv-error" role="alert">{error}</p>}
    </div>
  );
}

function AgentChip({ choice, checked, onPick }: { choice: AgentChoice; checked: boolean; onPick(): void }) {
  return (
    <button type="button" role="radio" aria-checked={checked} className="cv-chip" disabled={!choice.installed} title={choice.installed ? choice.name : `${choice.name} · ${S.notInstalled}`} onClick={onPick} style={{ ...(choice.color !== undefined ? { "--brand": choice.color } : {}), ...(choice.color2 !== undefined ? { "--brand2": choice.color2 } : {}) } as React.CSSProperties}>
      <Mark look={choice} size={22} />
      <span className="cv-chip__name">{choice.name}</span>
      {!choice.installed && <span className="cv-chip__note">{S.notInstalled}</span>}
    </button>
  );
}

function modelSummary(agent: AgentChoice | undefined, options: AgentOptions | undefined, pick: ModelPick | undefined): string {
  if (agent === undefined || pick === undefined) return S.loading;
  if (pick.from === "unknown") return `${S.agentsDefault(agent.name)} · ${S.unknownUntilStarted}`;
  const name = modelName(options, pick.model) ?? pick.model ?? S.agentsDefault(agent.name);
  return pick.effort !== undefined ? `${name} · ${pick.effort}` : name;
}
