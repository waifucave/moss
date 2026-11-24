// A bot's face is drawn by ONE component and one kit for MOSS's own window and for plugins (spec revision 20, §9.5): the face a
// plugin's `BotFace` draws for a bot's record, in a state, is MOSS's `Face` for the same record and state. Compared by what each
// puts in the page: the canvas's markup (its classes, the traits it was pinned) and what the kit was given to animate.
import { afterEach, describe, expect, test } from "bun:test";

// The kit draws on a canvas, which the test DOM has none of: a 2D context that draws nothing.
const noop = new Proxy({}, { get: () => () => undefined });
(HTMLCanvasElement.prototype as unknown as { getContext: () => unknown }).getContext = () => noop;
import { cleanup, render } from "@testing-library/react";
import { BotFace } from "@waifucave/moss-plugin-sdk/ui";
import { TestLayer, fakeCore, runtimeWith, settle } from "@waifucave/moss-plugin-sdk/ui/testing";
import { act } from "@testing-library/react";
import { FaceCanvas } from "@waifucave/moss-plugin-sdk/ui/faces";
import { readFileSync } from "node:fs";
import { join } from "node:path";

afterEach(cleanup);

const BOTS = [
  { id: "alpha", name: "Alpha", face: { shape: "tile", color: "coral", eyes: "round", temper: "calm" } },
  { id: "luna", name: "Luna", face: { color: "violet" } },
  { id: "tarot-panel", name: "Tarot Panel", face: null },
] as const;
const STATES = ["idle", "thinking", "working"] as const;

describe("BotFace and MOSS's own face", () => {
  // MOSS's own `Face` (apps/moss/src/window/faces/Face.tsx) is the SDK's `FaceCanvas`, as drawn below.
  test("MOSS's window draws its faces with the SDK's FaceCanvas and no canvas of its own", () => {
    const own = readFileSync(join(import.meta.dir, "..", "..", "..", "..", "..", "apps", "moss", "src", "window", "faces", "Face.tsx"), "utf8");
    expect(own).toContain('from "@waifucave/moss-plugin-sdk/ui/faces"');
    expect(own).toContain("<FaceCanvas {...props} />");
  });

  for (const bot of BOTS) {
    for (const state of STATES) {
      test(`${bot.name} (${bot.face === null ? "no pins" : Object.keys(bot.face).join("+")}), ${state}: the same canvas, from the record or from the pins`, async () => {
        const pins = bot.face === null ? undefined : (bot.face as Record<string, string>);
        const mine = render(<FaceCanvas name={bot.name} face={pins as never} mood={state} size={48} surface="page" />);
        const own = mine.container.innerHTML;
        cleanup();
        // From the bot's record (`bot.records`, a plugin's read)...
        const core = fakeCore({ "bot.records": () => ({ bots: BOTS.map((b) => ({ id: b.id, name: b.name, face: b.face })) }) });
        const viaRecord = render(<TestLayer runtime={runtimeWith({ core: () => core })}><BotFace bot={bot.id} size={48} state={state} /></TestLayer>);
        await act(() => settle(20));
        const fromRecord = viaRecord.container.querySelector("canvas")!.outerHTML;
        cleanup();
        // ...and from pins the part already has (no read at all).
        const quiet = fakeCore({});
        const viaPins = render(<TestLayer runtime={runtimeWith({ core: () => quiet })}><BotFace bot={bot.id} name={bot.name} {...(pins !== undefined ? { face: pins as never } : {})} size={48} state={state} /></TestLayer>);
        await act(() => settle(20));
        const fromPins = viaPins.container.querySelector("canvas")!.outerHTML;
        if (pins !== undefined) expect(quiet.calls.filter((c) => c.method === "bot.records")).toEqual([]);
        // The canvas's attributes, in any order (a record's pins arrive after its read).
        const attrs = (html: string) => [...html.match(/<canvas([^>]*)>/)![1]!.matchAll(/([\w-]+)="([^"]*)"/g)].map((m) => `${m[1]}=${m[2]}`).sort();
        expect(attrs(fromRecord)).toEqual(attrs(own));
        expect(attrs(fromPins)).toEqual(attrs(own));
        expect(fromPins).toContain("face face--page");
        // The state is on the canvas, so the markup that drives the animation differs by state and is the same in both.
        expect(fromPins).toContain(`data-mood="${state}"`);
      });
    }
  }
});
