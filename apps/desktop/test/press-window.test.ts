// The app's own fallback card is minted for no window, so its press window is bound from the sender at "received" (once), its point is
// its own window's mouse-down (never another window's), and the OS cover check (R12) runs for that window.
import { describe, expect, test } from "bun:test";
import { pressCover, type OsWindow } from "../src/main/overlap";
import { PressPoints, pressDownFor } from "../src/main/press-point";
import { SealedFrames, type SealedCard } from "../src/main/sealed";

const CARD: SealedCard = {
  id: "card_fb000001", kind: "tool", computer: "Studio", origin: "user", issuedAt: 0, expiresAt: null, hash: "b".repeat(64),
  fields: { title: { type: "text", text: "Run a command?" } },
  options: [{ id: "allow_once", kind: "approve", label: "Allow" }, { id: "deny", kind: "deny", label: "Deny" }],
};
const frame = { main: { processId: 1, routingId: 2 } };

describe("the press window of a card minted for no window", () => {
  test("bound once from the sender; windowOf (where the card is held) stays unset; a token that isn't a channel binds nothing", () => {
    const store = new SealedFrames();
    store.fromCore(CARD);
    const token = store.mint(CARD.id, "own", frame)!.token;
    expect(store.windowOf(token)).toBeUndefined();
    expect(store.pressWindowOf(token)).toBeUndefined();
    store.bindPressWindow(token, 7);
    store.bindPressWindow(token, 9);
    expect(store.pressWindowOf(token)).toBe(7);
    expect(store.windowOf(token)).toBeUndefined();
    store.bindPressWindow("not-a-token", 3);
    expect(store.pressWindowOf("not-a-token")).toBeUndefined();
  });

  test("a card minted for a window keeps that window: a later bind from the page can't move it", () => {
    const store = new SealedFrames();
    store.fromCore(CARD);
    const token = store.mint(CARD.id, "button:allow_once", frame, 4)!.token;
    store.bindPressWindow(token, 8);
    expect(store.windowOf(token)).toBe(4);
    expect(store.pressWindowOf(token)).toBe(4);
  });
});

describe("the fallback card's press point", () => {
  const downs = new Map([[5, { x: 40, y: 50, at: 1000 }], [6, { x: 300, y: 300, at: 1001 }]]);

  test("a mouse-down in another window doesn't count: its own window's down is the point, and none there is no point", () => {
    expect(pressDownFor(5, downs)).toEqual({ x: 40, y: 50, at: 1000 });
    expect(pressDownFor(7, downs)).toBeUndefined();
    expect(pressDownFor(undefined, downs)).toBeUndefined();
    const points = new PressPoints();
    points.save("t", { load: "L", n: 1, kind: "pointer" }, pressDownFor(7, downs), 1100);
    // A pointer press whose own window has no mouse-down is refused (never taken for a key press), whatever other windows saw.
    expect(points.lacksPoint("t", { load: "L", n: 1, kind: "pointer" })).toBe(true);
    points.save("u", { load: "L", n: 1, kind: "pointer" }, pressDownFor(5, downs), 1100);
    expect(points.pointOf("u", { load: "L", n: 1, kind: "pointer" })).toEqual({ x: 40, y: 50 });
  });

  test("a window over the card's button, at the press's point in its own window, covers it; one over another place doesn't", () => {
    const point = { x: 100 + 40, y: 100 + 50 };
    const over: OsWindow = { id: 2, x: 120, y: 120, width: 100, height: 100, layer: 0, alpha: 1, pid: 999, name: "Other", title: "" } as OsWindow;
    const elsewhere: OsWindow = { ...over, id: 3, x: 900, y: 900 };
    expect(pressCover({ point, above: [over], ours: () => true })?.id).toBe(2);
    expect(pressCover({ point, above: [elsewhere], ours: () => true })).toBeUndefined();
  });
});
