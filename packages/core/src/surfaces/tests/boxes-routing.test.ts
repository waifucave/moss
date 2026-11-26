// A card with boxes (`children`) is never placed on the island: only the app's own card draws the boxes, so the person never meets an Approve
// that only refuses. With no window in front it waits elsewhere (and every paired device shows it); a plain card still goes to the island.
import { describe, expect, test } from "bun:test";
import { MossApprovalBroker } from "../../approvals/broker";
import type { ApprovalRequest } from "../../contracts/approval-broker";
import { FakeClock } from "../../contracts/fakes/clock";
import { EngineCardRouter } from "../card-router";
import { routeBrokerCards } from "../routing";

describe("a card with boxes and the router", () => {
  test("the broker's card with children is placed elsewhere, a plain one on the island, while a window in front takes both", async () => {
    const clock = new FakeClock();
    const broker = new MossApprovalBroker({ clock, levels: () => "ask", verify: async () => false, localComputer: "Studio" });
    const router = new EngineCardRouter({ clock, hostLive: true });
    routeBrokerCards(broker, router);
    const raise = async (children?: { id: string; label: string; checked: boolean }[]): Promise<string> => {
      const req: ApprovalRequest = {
        kind: "change", origin: "user", computers: ["Studio"], effect: "other", change: "device-add",
        fields: { title: { type: "text", text: "Start a new group?" } }, ...(children === undefined ? {} : { children }),
      };
      return new Promise<string>((resolve) => { void broker.request(req, { onCard: resolve }); });
    };
    const boxed = await raise([{ id: "c1", label: "Server", checked: true }]);
    const plain = await raise();
    expect(router.placementOf(boxed)).toEqual({ kind: "elsewhere" });
    expect(router.placementOf(plain)).toEqual({ kind: "island" });
    // A window comes to the front: both are in it.
    router.report({ connId: 1, program: "code" }, { windows: [{ window: "main", focused: true, visible: true, showing: null }] });
    expect(router.placementOf(boxed)).toMatchObject({ kind: "strip", program: "code" });
    expect(router.placementOf(plain)).toMatchObject({ kind: "strip", program: "code" });
    // And behind again: the boxed one is elsewhere, never the island's.
    router.dropped(1);
    expect(router.placementOf(boxed)).toEqual({ kind: "elsewhere" });
    expect(router.placementOf(plain)).toEqual({ kind: "island" });
  });
});
