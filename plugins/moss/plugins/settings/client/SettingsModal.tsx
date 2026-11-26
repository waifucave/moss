// The settings window: a dialog over the app, with a searchable list of sections on the left and the
// chosen section's page of settings on the right. The sections are MOSS's own (spec §5.8, §12): the
// account and devices, appearance and notifications, plugins with their states, OKs and logs, and each
// computer's level. Pages with nothing to set yet say so. It fills the shell's `settings.section` spot
// with its own sections; a plugin adds one there.
import { createContext, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { IconClose, IconPlugin, IconSearch, SECTION_ICONS } from "./icons";
import { qrEncode, qrPath } from "./qr";
import { S } from "./strings";
import type { OneAtATimeView, RelayChoice, SettingsDevice, SettingsModalProps, SettingsSection, ToolAvailability, ToolPermission, ToolsView } from "./types";

export const SECTIONS: readonly SettingsSection[] = ["account", "devices", "appearance", "notifications", "plugins", "tools", "levels"];

/** Where the section list breaks into groups, as the dividers show. */
const GROUP_ENDS: ReadonlySet<SettingsSection> = new Set(["devices", "notifications", "levels"]);

/** The settings each page holds, for the search box. */
const INDEX: Record<SettingsSection, string[]> = {
  account: [S.name, S.main, S.setupGuide],
  devices: [S.devices],
  appearance: [S.theme, S.themePlugin, S.textSize, S.language],
  notifications: [S.notifyNeedsYou, S.notifyAgentDone, S.notifyRoutineFailed, S.notifySounds],
  plugins: [S.plugins, S.pluginManager, S.pluginLogs],
  tools: [S.toolsTitle, S.toolAllow, S.toolDeny],
  levels: [S.levels],
};

export function sectionsMatching(query: string): SettingsSection[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return [...SECTIONS];
  return SECTIONS.filter((s) => S.section[s].toLowerCase().includes(q) || INDEX[s].some((label) => label.toLowerCase().includes(q)));
}

/** What marks the row a place opened Settings at. */
const marks = (item: string | undefined, id: string) =>
  ({ "data-item": id, ...(item === id ? { "data-marked": true, "aria-current": true } : {}) }) as const;

function Row({ label, detail, mark, children }: { label: string; detail?: string; mark?: ReturnType<typeof marks>; children: ReactNode }) {
  const id = useId();
  return (
    <div className="cl-settings__row" role="group" aria-labelledby={id} {...mark}>
      <div className="cl-settings__text">
        <span className="cl-settings__label" id={id}>
          {label}
        </span>
        {detail && <span className="cl-settings__detail">{detail}</span>}
      </div>
      <div className="cl-settings__control">{children}</div>
    </div>
  );
}

const TOOL_VALUES = ["allow", "ask", "deny"] as const;
const TOOL_LABEL: Record<ToolPermission, string> = { allow: S.toolAllow, ask: S.toolAsk, deny: S.toolDeny };

/** The three-way control: one radio group, the value that holds pressed. */
function ThreeWay({ label, value, mixed, onPick }: { label: string; value: ToolPermission | undefined; mixed?: boolean; onPick?: (v: ToolPermission) => void }) {
  return (
    <div className="cl-settings__three" role="radiogroup" aria-label={label} data-mixed={mixed ? "" : undefined}>
      {TOOL_VALUES.map((v) => (
        <button key={v} type="button" role="radio" aria-checked={value === v} data-value={v} className="cl-settings__three-option" disabled={!onPick} onClick={() => onPick?.(v)}>
          {TOOL_LABEL[v]}
        </button>
      ))}
    </div>
  );
}

const AVAILABILITIES = ["off", "on-demand", "always"] as const;
const AVAILABILITY_LABEL: Record<ToolAvailability, string> = { off: S.toolOff, "on-demand": S.toolOnDemand, always: S.toolAlways };
/** What a plugin's declaration gives with nothing chosen (spec §6.7): a preloaded tool is always on, the rest on demand. */
const declaredAvailability = (declared: "preload" | "on-demand" | undefined): ToolAvailability | undefined => (declared === undefined ? undefined : declared === "preload" ? "always" : "on-demand");

/** The tool setting's control: off, on demand or always on, the plugin's own default marked. Its own words, apart from the
 *  permission's: "Off" hides a tool, "Always block" refuses a call to one that is offered. */
function Availability({ label, value, mixed, fallback, onPick }: { label: string; value: ToolAvailability | undefined; mixed?: boolean; fallback?: ToolAvailability | undefined; onPick?: (v: ToolAvailability) => void }) {
  return (
    <div className="cl-settings__three" role="radiogroup" aria-label={label} data-mixed={mixed ? "" : undefined}>
      {AVAILABILITIES.map((v) => (
        <button key={v} type="button" role="radio" aria-checked={value === v} data-value={v} {...(fallback === v ? { "data-default": "", title: S.toolDefaultMark } : {})} className="cl-settings__three-option" disabled={!onPick} onClick={() => onPick?.(v)}>
          {AVAILABILITY_LABEL[v]}{fallback === v ? S.toolDefaultSuffix : ""}
        </button>
      ))}
    </div>
  );
}

const sameRef = (a: { pluginId: string; entryId: string } | undefined, b: { pluginId: string; entryId: string }) => a !== undefined && a.pluginId === b.pluginId && a.entryId === b.entryId;

/** One picker per point that takes one filler at a time and has two or more (spec §5.4 "One at a time"), titled by the
 *  point's own title: one radio group, the active filler pressed. Only the user's press here picks it. */
function ActivePickers({ points, onPick }: { points: OneAtATimeView[] | undefined; onPick: SettingsModalProps["onPickActive"] }) {
  const shown = (points ?? []).filter((p) => p.fillers.length >= 2);
  if (shown.length === 0) return null;
  return (
    <>
      {shown.map((p) => {
        const standIn = p.chosen !== undefined && !p.fillers.some((f) => sameRef(p.chosen, f)) ? p.fillers.find((f) => sameRef(p.active, f)) : undefined;
        return (
          <section key={p.point} className="cl-settings__one" aria-label={p.title} data-point={p.point}>
            <Row label={p.title} detail={standIn !== undefined ? S.oneStandIn(standIn.name) : S.oneDetail}>
              <div className="cl-settings__three cl-settings__one-options" role="radiogroup" aria-label={p.title}>
                {p.fillers.map((f) => (
                  <button key={`${f.pluginId}/${f.entryId}`} type="button" role="radio" aria-checked={sameRef(p.active, f)} data-plugin={f.pluginId} data-entry={f.entryId}
                    className="cl-settings__three-option" disabled={!onPick} onClick={() => onPick?.(p.point, { pluginId: f.pluginId, entryId: f.entryId })}>
                    {f.name}
                  </button>
                ))}
              </div>
            </Row>
          </section>
        );
      })}
    </>
  );
}

function ToolsPage({ tools, onSet, onSetAvailability, onTakeBack, item }: { tools: ToolsView | undefined; onSet: SettingsModalProps["onSetTool"]; onSetAvailability: SettingsModalProps["onSetAvailability"]; onTakeBack: SettingsModalProps["onTakeBackRule"]; item: string | undefined }) {
  if (tools === undefined) return <p className="cl-settings__note">{S.toolsLoading}</p>;
  return (
    <>
      <h3 className="cl-settings__subhead">{S.toolsTitle}</h3>
      <p className="cl-settings__note">{S.toolsDetail}</p>
      {tools.plugins.some((p) => p.tools.some((t) => t.availability !== undefined)) && <p className="cl-settings__note">{S.toolsOfferedDetail}</p>}
      {tools.plugins.length === 0 && <p className="cl-settings__note">{S.toolsNone}</p>}
      {tools.plugins.map((p) => {
        const every = p.tools.every((t) => t.permission === p.tools[0]!.permission) ? p.tools[0]!.permission : undefined;
        const offered = p.tools.every((t) => t.availability !== undefined);
        const everyOffered = offered && p.tools.every((t) => t.availability === p.tools[0]!.availability) ? p.tools[0]!.availability : undefined;
        return (
          <section key={p.server} className="cl-settings__tool-group" aria-label={p.name} data-item={p.pluginId} {...(item === p.pluginId ? { "data-marked": true } : {})}>
            <Row label={p.name} detail={S.toolsAll}>
              <ThreeWay label={S.toolsAllFor(p.name)} value={every} mixed={every === undefined} {...(onSet ? { onPick: (v: ToolPermission) => onSet(p.server, undefined, v) } : {})} />
            </Row>
            {offered && (
              <Row label={S.toolOffered} detail={S.toolsAll}>
                <Availability label={S.toolsAllOfferedFor(p.name)} value={everyOffered} mixed={everyOffered === undefined} {...(onSetAvailability ? { onPick: (v: ToolAvailability) => onSetAvailability(p.server, undefined, v) } : {})} />
              </Row>
            )}
            {p.tools.map((t) => (
              <Row key={t.name} label={t.title ?? t.name} detail={t.isNew ? S.toolsNew : t.availability === "on-demand" ? S.toolOnDemandRunning : undefined}>
                {t.availability !== undefined && (
                  <Availability label={S.toolOfferedFor(t.name)} value={t.availability} fallback={declaredAvailability(t.declared)} {...(onSetAvailability ? { onPick: (v: ToolAvailability) => onSetAvailability(p.server, t.name, v) } : {})} />
                )}
                <ThreeWay label={S.toolFor(t.name)} value={t.permission} {...(onSet ? { onPick: (v: ToolPermission) => onSet(p.server, t.name, v) } : {})} />
                {t.cardRules.map((r) => (
                  <span key={r.bot} className="cl-settings__tool-rule">
                    {S.toolRule(r.botName, r.computers)}
                    {onTakeBack && (
                      <button type="button" className="cl-settings__button" aria-label={S.toolTakeBackFor(r.botName, t.name)} onClick={() => onTakeBack(p.server, t.name, r.bot)}>
                        {S.toolTakeBack}
                      </button>
                    )}
                  </span>
                ))}
              </Row>
            ))}
          </section>
        );
      })}
    </>
  );
}

/** Which controls are saving and which failed to save (SettingsModalProps.saves). */
const Saves = createContext<{ busy: ReadonlySet<string>; failed: ReadonlySet<string> }>({ busy: new Set(), failed: new Set() });

/** A control's save: while it is under way the control takes no second press; when it failed, one plain line beside it
 *  says so (read out at once) and the control is back on its stored value. */
function useSave(path: string | undefined): { busy: boolean; failed: boolean } {
  const s = useContext(Saves);
  return { busy: path !== undefined && s.busy.has(path), failed: path !== undefined && s.failed.has(path) };
}

function SaveFailed({ label }: { label: string }) {
  return <span className="cl-settings__save-failed" role="alert">{S.choiceFailed(label)}</span>;
}

function Toggle({ label, on, onChange, path }: { label: string; on: boolean; onChange: (on: boolean) => void; path?: string }) {
  const save = useSave(path);
  return (
    <span className="cl-settings__control">
      {save.failed && <SaveFailed label={label} />}
      <button type="button" role="switch" aria-checked={on} aria-label={label} aria-busy={save.busy || undefined} className="cl-settings__switch" onClick={() => { if (!save.busy) onChange(!on); }}>
        <span className="cl-settings__knob" />
      </button>
    </span>
  );
}

function Choice<T extends string>({ label, value, options, labels, onChange, path }: { label: string; value: T; options: readonly T[]; labels: Record<T, string>; onChange: (value: T) => void; path?: string }) {
  const save = useSave(path);
  return (
    <span className="cl-settings__control">
      {save.failed && <SaveFailed label={label} />}
      <div className="cl-settings__segmented" role="radiogroup" aria-label={label} aria-busy={save.busy || undefined}>
        {options.map((o) => (
          <button key={o} type="button" role="radio" aria-checked={o === value} className="cl-settings__segment" onClick={() => { if (!save.busy) onChange(o); }}>
            {labels[o]}
          </button>
        ))}
      </div>
    </span>
  );
}

/** The picture of a pairing's text a phone can scan (drawn here from the text; nothing leaves the page). */
function QrPicture({ text, label }: { text: string; label: string }) {
  let drawn: { viewBox: string; d: string } | undefined;
  try {
    drawn = qrPath(qrEncode(text), 2);
  } catch {
    drawn = undefined;
  }
  if (!drawn) return null;
  return (
    <svg className="cl-settings__qr" role="img" aria-label={label} viewBox={drawn.viewBox} shapeRendering="crispEdges">
      <rect width="100%" height="100%" fill="#fff" />
      <path d={drawn.d} fill="#000" />
    </svg>
  );
}

const clock = (ms: number): string => new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

/** Pairing a device without an account (§8.1): show a code here (and a picture of it for a phone), or enter the other device's. The
 *  four words are never on this page: once another device is in, the engine raises a sealed card that draws them, and the person
 *  compares them with the other screen and presses it there. */
function Pairing({ props }: { props: SettingsModalProps }) {
  const [code, setCode] = useState("");
  const p = props.pairing;
  // The code's own clock: it stops working at its expiry whether or not the engine has said so.
  const [now, setNow] = useState(() => Date.now());
  const ticking = p !== undefined && p.ended === undefined && p.checking !== true && p.expiresAt !== undefined && p.expiresAt > 0;
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [ticking, p?.expiresAt]);
  const lapsed = ticking && p!.expiresAt! <= now;
  return (
    <section className="cl-settings__pairing" aria-label={S.pairTitle}>
      <h3 className="cl-settings__subhead">{S.pairTitle}</h3>
      {!p ? (
        <>
          <p className="cl-settings__note">{S.pairDetail}</p>
          <div className="cl-settings__control cl-settings__pair-row">
            {props.onPairBegin && (
              <button type="button" className="cl-settings__button" onClick={props.onPairBegin}>
                {S.pairBegin}
              </button>
            )}
            {props.onPairJoin && (
              <form
                className="cl-settings__control"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (code.trim()) props.onPairJoin?.(code.trim());
                }}
              >
                <input className="cl-settings__input" aria-label={S.pairJoinLabel} placeholder={S.pairJoinLabel} value={code} onChange={(e) => setCode(e.target.value)} />
                <button type="submit" className="cl-settings__button" disabled={code.trim() === ""}>
                  {S.pairJoin}
                </button>
              </form>
            )}
          </div>
        </>
      ) : (
        <div className="cl-settings__pair" role="status">
          {p.ended !== undefined ? (
            <p className="cl-settings__note">{p.ended}</p>
          ) : p.checking ? (
            <p className="cl-settings__note" data-pairing-step="card">{S.pairWaitingCard(p.peerName)}</p>
          ) : lapsed ? (
            <p className="cl-settings__note" data-pairing-step="lapsed">{S.pairLapsed}</p>
          ) : (
            (p.code || p.qr) && (
              <div data-pairing-step="code">
                {p.note && <p className="cl-settings__note" role="alert" data-pairing-note>{p.note}</p>}
                {p.code && (
                  <>
                    <p className="cl-settings__note">{S.pairCodeNote}</p>
                    <p className="cl-settings__pair-code">{p.code}</p>
                  </>
                )}
                {p.qr && (
                  <>
                    <p className="cl-settings__note">{S.pairQrNote}</p>
                    <QrPicture text={p.qr} label={S.pairQrNote} />
                    <details className="cl-settings__pair-text">
                      <summary>{S.pairTextNote}</summary>
                      <p className="cl-settings__pair-qrtext">{p.qr}</p>
                    </details>
                  </>
                )}
                {p.expiresAt !== undefined && p.expiresAt > 0 && <p className="cl-settings__note" data-pairing-expiry>{S.pairExpires(clock(p.expiresAt))}</p>}
              </div>
            )
          )}
          <div className="cl-settings__control">
            <button type="button" className="cl-settings__button" onClick={props.onPairCancel}>
              {p.ended !== undefined || lapsed ? S.pairClose : S.pairCancel}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

const last = (d: SettingsDevice): string => (d.online || d.here ? S.online : d.lastSeen !== undefined ? S.lastSeen(new Date(d.lastSeen).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })) : S.neverSeen);

/** Which relay the links use (§8.3): n0's public relays (the default), a server of the person's own, or none; saved at once by the
 *  engine. A relay plugin that is installed is listed and not offered, as the setup guide's page does. */
function Relay({ props }: { props: SettingsModalProps }) {
  const held = props.relay;
  const [mode, setMode] = useState<RelayChoice["mode"]>(held?.mode ?? "n0");
  const [url, setUrl] = useState(held?.url ?? "");
  const [saved, setSaved] = useState(false);
  // What the engine holds is what the control shows: read again, or changed from elsewhere.
  useEffect(() => {
    if (held === undefined) return;
    setMode(held.mode);
    setUrl(held.url ?? "");
  }, [held]);
  if (!props.onSetRelay) return null;
  const valid = mode !== "custom" || /^https:\/\/[^\s/@]+/i.test(url.trim());
  const choose = (m: RelayChoice["mode"]) => {
    setMode(m);
    setSaved(false);
  };
  const options: { value: RelayChoice["mode"]; title: string; detail?: string }[] = [
    { value: "n0", title: S.relayN0, detail: S.relayN0Detail },
    { value: "custom", title: S.relayCustom },
    { value: "off", title: S.relayOff, detail: S.relayOffDetail },
  ];
  return (
    <section className="cl-settings__relay" aria-label={S.relayTitle}>
      <h3 className="cl-settings__subhead">{S.relayTitle}</h3>
      <p className="cl-settings__note">{S.relayDetail}</p>
      <div className="cl-settings__three cl-settings__relay-options" role="radiogroup" aria-label={S.relayTitle}>
        {options.map((o) => (
          <button key={o.value} type="button" role="radio" aria-checked={mode === o.value} data-relay={o.value} className="cl-settings__three-option" disabled={held === undefined} onClick={() => choose(o.value)} title={o.detail}>
            {o.title}
          </button>
        ))}
      </div>
      {mode === "custom" && (
        <div className="cl-settings__control cl-settings__pair-row">
          <input className="cl-settings__input" type="url" aria-label={S.relayCustomLabel} placeholder="https://relay.example.com" value={url} onChange={(e) => { setUrl(e.target.value); setSaved(false); }} />
          {!valid && url.trim() !== "" && <span className="cl-settings__reason" role="alert">{S.relayInvalid}</span>}
        </div>
      )}
      <div className="cl-settings__control">
        <button
          type="button"
          className="cl-settings__button"
          disabled={held === undefined || !valid || (mode === "custom" && url.trim() === "") || (held.mode === mode && (mode !== "custom" || held.url === url.trim()))}
          onClick={() => { props.onSetRelay?.(mode === "custom" ? { mode, url: url.trim() } : { mode }); setSaved(true); }}
        >
          {S.relaySave}
        </button>
        {saved && held?.mode === mode && <span className="cl-settings__detail" role="status">{S.relaySaved}</span>}
      </div>
      {(props.relayPlugins ?? []).map((r) => (
        <p key={r.id} className="cl-settings__note" data-relay-plugin={r.id}>{S.relayPluginNote(r.name, r.why)}</p>
      ))}
    </section>
  );
}

function Page({ props }: { props: SettingsModalProps }) {
  const { section, values, onChange } = props;
  const extra = props.extraSections?.find((x) => x.id === section);
  if (extra) return <>{extra.render()}</>;
  if (section === "plugins" && props.logs) {
    const { name, lines, onBack } = props.logs;
    return (
      <>
        <div className="cl-settings__logs-head">
          <button type="button" className="cl-settings__button" onClick={onBack}>
            {S.back}
          </button>
          <h3 className="cl-settings__subhead">{S.pluginLogsFor(name)}</h3>
        </div>
        {lines.length === 0 ? (
          <p className="cl-settings__note">{S.noLogs}</p>
        ) : (
          <pre className="cl-settings__log" aria-label={S.pluginLogsFor(name)}>
            {lines.join("\n")}
          </pre>
        )}
      </>
    );
  }
  switch (section) {
    case "account":
      return (
        <>
          <Row label={S.name} detail={S.nameDetail}>
            <input className="cl-settings__input" aria-label={S.name} value={values.account.name} onChange={(e) => onChange("account.name", e.target.value)} />
          </Row>
          <Row label={S.main} detail={S.mainDetail}>
            <span className="cl-settings__value">{values.account.main}</span>
          </Row>
          {props.onOpenSetup ? (
            <Row label={S.setupGuide} detail={S.setupGuideDetail}>
              <button type="button" className="cl-settings__button" onClick={props.onOpenSetup}>
                {S.setupGuideOpen}
              </button>
            </Row>
          ) : null}
          {props.onDeleteAccount ? (
            <Row label={S.deleteAccount} detail={S.deleteAccountDetail}>
              <button type="button" className="cl-settings__button" data-delete-account onClick={props.onDeleteAccount}>
                {S.deleteAccountButton}
              </button>
            </Row>
          ) : null}
          {props.onEraseEverything ? (
            <Row label={S.eraseEverything} detail={S.eraseEverythingDetail}>
              <button type="button" className="cl-settings__button" data-erase-everything onClick={props.onEraseEverything}>
                {S.eraseEverythingButton}
              </button>
            </Row>
          ) : null}
        </>
      );
    case "appearance":
      return (
        <>
          <Row label={S.theme} detail={S.themeDetail}>
            <Choice label={S.theme} value={values.appearance.theme} options={["light", "dark", "system"] as const} labels={S.themes} onChange={(v) => onChange("appearance.theme", v)} />
          </Row>
          <Row label={S.themePlugin} detail={S.themePluginDetail}>
            <select className="cl-settings__select" aria-label={S.themePlugin} value={values.theme} onChange={(e) => onChange("theme", e.target.value)}>
              {values.themes.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </Row>
          <Row label={S.textSize}>
            <Choice label={S.textSize} value={values.appearance.textSize} options={["small", "default", "large"] as const} labels={S.textSizes} onChange={(v) => onChange("appearance.textSize", v)} path="appearance.textSize" />
          </Row>
          <Row label={S.language} detail={S.languageDetail}>
            <span className="cl-settings__value">{values.language.name}</span>
            <button type="button" className="cl-settings__button" onClick={props.onOpenLanguage}>
              {S.change}
            </button>
          </Row>
        </>
      );
    case "notifications":
      return (
        <>
          <Row label={S.notifyNeedsYou} detail={S.notifyNeedsYouDetail}>
            <Toggle label={S.notifyNeedsYou} on={values.notifications.needsYou} onChange={(v) => onChange("notifications.needsYou", v)} path="notifications.needsYou" />
          </Row>
          <Row label={S.notifyAgentDone}>
            <Toggle label={S.notifyAgentDone} on={values.notifications.agentDone} onChange={(v) => onChange("notifications.agentDone", v)} path="notifications.agentDone" />
          </Row>
          <Row label={S.notifyRoutineFailed}>
            <Toggle label={S.notifyRoutineFailed} on={values.notifications.routineFailed} onChange={(v) => onChange("notifications.routineFailed", v)} path="notifications.routineFailed" />
          </Row>
          <Row label={S.notifySounds}>
            <Toggle label={S.notifySounds} on={values.notifications.sounds} onChange={(v) => onChange("notifications.sounds", v)} path="notifications.sounds" />
          </Row>
        </>
      );
    case "plugins":
      return (
        <>
          <h3 className="cl-settings__subhead">{S.plugins}</h3>
          <p className="cl-settings__note">{S.pluginsDetail}</p>
          <ActivePickers points={props.oneAtATime} onPick={props.onPickActive} />
          {values.plugins.map((p) => (
            <div key={p.id} className="cl-settings__row cl-settings__plugin" role="group" aria-label={p.name} data-state={p.state} {...marks(props.item, p.id)}>
              <div className="cl-settings__text">
                <span className="cl-settings__label">
                  {p.name}
                  <span className="cl-settings__state" data-state={p.state}>
                    {S.pluginState[p.state]}
                  </span>
                </span>
                <span className="cl-settings__detail">{p.source}</span>
                {p.reason && <span className="cl-settings__detail cl-settings__reason">{p.reason}</span>}
                {p.oks && <span className="cl-settings__detail cl-settings__oks">{S.pluginOks(p.oks)}</span>}
              </div>
              {/* Not available in this build yet: the reason is its one line, nothing to open, read or switch. */}
              {!p.notYet && <div className="cl-settings__control">
                {props.onOpenPlugin && (
                  <button type="button" className="cl-settings__button" aria-label={S.pluginOpenFor(p.name)} onClick={() => props.onOpenPlugin?.(p.id)}>
                    {S.pluginOpen}
                  </button>
                )}
                {props.onOpenPluginLogs && (
                  <button type="button" className="cl-settings__button" aria-label={S.pluginLogsFor(p.name)} onClick={() => props.onOpenPluginLogs?.(p.id)}>
                    {S.pluginLogs}
                  </button>
                )}
                <Toggle label={p.name} on={p.enabled} onChange={(v) => onChange(`plugins.${p.id}.enabled`, v)} path={`plugins.${p.id}.enabled`} />
              </div>}
            </div>
          ))}
          {props.onOpenPluginManager && (
            <button type="button" className="cl-settings__button cl-settings__button--wide" onClick={props.onOpenPluginManager}>
              {S.pluginManager}
            </button>
          )}
        </>
      );
    case "tools":
      return <ToolsPage tools={props.tools} onSet={props.onSetTool} onSetAvailability={props.onSetAvailability} onTakeBack={props.onTakeBackRule} item={props.item} />;
    case "levels":
      return (
        <>
          <h3 className="cl-settings__subhead">{S.levels}</h3>
          <p className="cl-settings__note">{S.levelsDetail}</p>
          {values.levels.map((l) => {
            const name = (id: string) => values.levelOptions.find((o) => o.id === id)?.label ?? id;
            const asked = l.requested && l.requested !== l.level ? l.requested : undefined;
            return (
              <Row key={l.computer} label={l.computer} mark={marks(props.item, l.computer)} detail={[l.here ? S.thisDevice : "", asked ? S.levelAsked(name(asked)) : ""].filter(Boolean).join(" · ") || undefined}>
                <select
                  className="cl-settings__select"
                  aria-label={S.levelFor(l.computer)}
                  value={l.level}
                  data-requested={asked}
                  disabled={!props.onRequestLevel}
                  onChange={(e) => {
                    // A pick only asks: the select stays at the level that holds until the card is answered.
                    if (e.target.value !== l.level) props.onRequestLevel?.(l.computer, e.target.value);
                  }}
                >
                  {values.levelOptions.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </Row>
            );
          })}
        </>
      );
    case "devices":
      return (
        <>
          <h3 className="cl-settings__subhead">{S.devices}</h3>
          <p className="cl-settings__note">{S.devicesDetail}</p>
          {values.devices.map((d) => (
            <Row key={d.id} label={d.name} mark={marks(props.item, d.id)} detail={[S.kind[d.kind], d.here ? S.thisDevice : "", d.main ? S.mainDevice : "", last(d), ...(d.keys ?? []).map((k) => S.keyWords(k.program, k.words))].filter(Boolean).join(" · ")}>
              {d.kind === "computer" && !d.main && props.onMakeMain && (
                <button type="button" className="cl-settings__button" aria-label={S.makeMain(d.name)} onClick={() => props.onMakeMain?.(d.id)}>
                  {S.makeMainLabel}
                </button>
              )}
              {!d.here && props.onRemoveDevice && (
                <button type="button" className="cl-settings__button" aria-label={S.remove(d.name)} onClick={() => props.onRemoveDevice?.(d.id)}>
                  {S.removeLabel}
                </button>
              )}
            </Row>
          ))}
          {(props.onPairBegin || props.onPairJoin) && <Pairing props={props} />}
          {props.onSetRelay && <Relay props={props} />}
        </>
      );
    default:
      return (
        <div className="cl-settings__later">
          <p className="cl-settings__later-title">{S.later}</p>
          <p className="cl-settings__note">{S.laterDetail}</p>
        </div>
      );
  }
}

export function SettingsModal(props: SettingsModalProps) {
  const { section, onSection, onClose } = props;
  const [query, setQuery] = useState("");
  const search = useRef<HTMLInputElement>(null);
  const page = useRef<HTMLElement>(null);
  const titleId = useId();
  useEffect(() => search.current?.focus(), []);
  // The marked row is brought into view once per section and item; its rows may arrive after the page, so this looks
  // again on each render until the row is there.
  const shownItem = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (props.item === undefined) {
      shownItem.current = undefined;
      return;
    }
    const key = `${section}\n${props.item}`;
    if (shownItem.current === key) return;
    const row = [...(page.current?.querySelectorAll<HTMLElement>("[data-item]") ?? [])].find((el) => el.dataset.item === props.item);
    if (!row) return;
    shownItem.current = key;
    row.scrollIntoView?.({ block: "center" });
  });
  const shown = sectionsMatching(query);
  const q = query.trim().toLowerCase();
  const extras = (props.extraSections ?? []).filter((x) => q.length === 0 || x.title.toLowerCase().includes(q));
  const title = (SECTIONS as readonly string[]).includes(section) ? S.section[section as SettingsSection] : (props.extraSections?.find((x) => x.id === section)?.title ?? "");
  return (
    <div
      className="cl-settings"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <header className="cl-settings__head">
        <h2 className="cl-settings__title" id={titleId}>
          {S.title}
        </h2>
        <button type="button" className="cl-settings__close" aria-label={S.close} onClick={onClose}>
          <IconClose />
        </button>
      </header>
      <div className="cl-settings__body">
        <nav className="cl-settings__nav" aria-label={S.sections}>
          <label className="cl-settings__search">
            <IconSearch />
            <input ref={search} className="cl-settings__search-input" type="search" placeholder={S.search} aria-label={S.search} value={query} onChange={(e) => setQuery(e.target.value)} />
          </label>
          <ul className="cl-settings__sections">
            {shown.map((s) => {
              const Icon = SECTION_ICONS[s];
              return (
                <li key={s} data-group-end={(GROUP_ENDS.has(s) && query.length === 0) || undefined}>
                  <button type="button" className="cl-settings__section" aria-current={s === section ? "page" : undefined} onClick={() => onSection(s)}>
                    <Icon />
                    <span>{S.section[s]}</span>
                  </button>
                </li>
              );
            })}
            {extras.map((x) => (
              <li key={x.id}>
                <button type="button" className="cl-settings__section" aria-current={x.id === section ? "page" : undefined} onClick={() => onSection(x.id)}>
                  <IconPlugin />
                  <span>{x.title}</span>
                </button>
              </li>
            ))}
            {shown.length === 0 && extras.length === 0 && <li className="cl-settings__note">{S.noMatch}</li>}
          </ul>
        </nav>
        <section className="cl-settings__page" aria-label={title} ref={page}>
          <h3 className="cl-settings__page-title">{title}</h3>
          {props.failure !== undefined && <p role="alert" className="cl-settings__failure">{props.failure}</p>}
          <Saves.Provider value={props.saves ?? { busy: new Set(), failed: new Set() }}>
            <Page props={props} />
          </Saves.Provider>
        </section>
      </div>
    </div>
  );
}

