// The acceptance run's stand-in for the canvas plugin: the start page (the `main` entry keyed `start`), the session tab's
// corner control, and an "Open in MOSS" button. TSX importing React and the UI SDK; no react in the folder.
import { useEffect, useState } from "react";
import { AgentMark, BotFace, useCore, usePluginApi } from "@waifucave/moss-plugin-sdk/ui";

interface Backend { id: string; name: unknown; icon?: { mediaType: "image/png" | "image/svg+xml"; data: string; at: number }; color?: string; color2?: string; userStartable?: boolean }

export function CanvasStart() {
  const core = useCore();
  const api = usePluginApi();
  const [backends, setBackends] = useState<Backend[]>([]);
  const [said, setSaid] = useState("");
  const [opened, setOpened] = useState("");
  useEffect(() => {
    void core?.call("agent.backends", {}).then((r: { backends?: Backend[] }) => setBackends((r.backends ?? []).filter((b) => b.userStartable !== false)), () => undefined);
  }, [core]);
  const start = async () => {
    try {
      const options = (await core!.call("agent.options", { backend: "moss-code" })) as { models: { id: string; efforts: string[] }[]; default?: { model: string } };
      const folders = (await core!.call("ui.pick", { kind: "folder", use: "agent.start", recent: true, dialog: false })) as { recent?: { token: string }[] };
      const token = folders.recent?.[0]?.token;
      if (token === undefined) { setSaid("no recent folder"); return; }
      // A model that isn't the default, at its highest effort: what the person chose, not what was preselected.
      const model = options.models.find((m) => m.id !== options.default?.model && m.efforts.length > 0) ?? options.models[0]!;
      const effort = model.efforts[model.efforts.length - 1];
      const got = (await core!.call("agent.start", { backend: "moss-code", root: token, model: model.id, ...(effort !== undefined ? { effort } : {}), prompt: "ACCEPTANCE-CANVAS-FIRST" })) as { session: string };
      setSaid(`started ${got.session} on ${model.id} ${effort ?? ""}`);
      await api.shell!.go({ session: got.session });
    } catch (e) {
      setSaid(`refused: ${String((e as Error).message ?? e).slice(0, 160)}`);
    }
  };
  const openIn = async () => {
    try {
      const r = (await core!.call("app.openIn", { what: { kind: "bot", bot: "alpha" } })) as { opened: boolean; started?: boolean; refused?: string };
      setOpened(r.opened ? `opened${r.started ? " started" : ""}` : `refused: ${r.refused}`);
    } catch (e) {
      setOpened(`refused: ${String((e as Error).message ?? e).slice(0, 160)}`);
    }
  };
  return (
    <div data-canvas-start="">
      <h1>ACCEPT-CANVAS-START</h1>
      <div data-canvas-agents="">
        {backends.map((b) => (
          <div key={b.id} data-canvas-agent={b.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: 4 }}>
            <AgentMark backend={{ id: b.id, name: typeof b.name === "string" ? b.name : b.id, ...(b.icon ? { icon: b.icon } : {}), ...(b.color ? { color: b.color } : {}), ...(b.color2 ? { color2: b.color2 } : {}) }} size={24} />
            <span>{typeof b.name === "string" ? b.name : b.id}</span>
          </div>
        ))}
      </div>
      <div data-canvas-fallback=""><AgentMark backend={{ id: "nomark", name: "Nomark" }} size={24} /></div>
      <div data-canvas-bot-face="" style={{ display: "inline-block" }}><BotFace bot="alpha" size={48} /></div>
      <button type="button" data-canvas-go="" onClick={() => void start()}>Start</button>
      <button type="button" data-canvas-openin="" onClick={() => void openIn()}>Open in MOSS</button>
      <p data-canvas-said="">{said}</p>
      <p data-canvas-opened="">{opened}</p>
    </div>
  );
}

export function CanvasCorner({ props }: { props: { session?: string; kind?: string; navigate?: unknown } }) {
  const api = usePluginApi();
  return <button type="button" data-canvas-corner={props.session ?? ""} data-canvas-kind={props.kind ?? ""} onClick={() => void api.shell!.go({ page: "start" })}>Canvas</button>;
}
