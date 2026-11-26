// A card's boxes at the sealed store: an approve is signed with exactly the ticked ids of boxes the card carries (each once), a deny
// with none, a card whose boxes can't be drawn whole is never approved, a part's own button never approves a card that has boxes,
// and such a card is never "in place" in a part, so the app's own card stands.
import { describe, expect, test } from "bun:test";
import { CHILDREN_OWN_CARD_ONLY, cardAnswerSigningInput } from "@waifucave/moss-protocol";
import { OWN_ELEMENT, SealedFrames, type AnswerSigner, type SealedCard } from "../src/main/sealed";

const kid = (id: string, label: string, checked = true) => ({ id, label, checked });
const CARD: SealedCard = {
  id: "card_0a1b2c3d", kind: "plugin-ok", computer: "Studio", origin: "user", issuedAt: 0, expiresAt: null, hash: "a".repeat(64),
  fields: { title: { type: "text", text: "Plugin Pack" } },
  options: [{ id: "approve", kind: "approve", label: "Approve" }, { id: "deny", kind: "deny", label: "Deny" }],
  children: [kid("pack/a", "A"), kid("pack/b", "B"), kid("pack/c", "C")],
};
const signed: Uint8Array[] = [];
const signer: AnswerSigner = { sign: (m) => (signed.push(m), new Uint8Array([9])) };
const main0 = { main: { processId: 1, routingId: 2 } };
const AT = 1_000;
function own(card: SealedCard = CARD) {
  const store = new SealedFrames();
  store.fromCore(card);
  return { store, token: store.mint(card.id, OWN_ELEMENT, main0)!.token };
}
const answer = (store: SealedFrames, token: string, option: string, children?: readonly string[]) => store.buildAnswer(token, option, children, "m:1:2", signer, "dev_a", AT);
const text = (m: Uint8Array) => new TextDecoder().decode(m);

describe("the ticks an approve is signed with", () => {
  test("exactly the ticked ids are signed and sent, as the protocol's signing input says", () => {
    const { store, token } = own();
    signed.length = 0;
    const out = answer(store, token, "approve", ["pack/a", "pack/c"]);
    expect(out).toMatchObject({ kids: ["pack/a", "pack/c"] });
    expect(text(signed[0]!)).toBe(cardAnswerSigningInput({ id: CARD.id, hash: CARD.hash, option: "approve", at: AT, children: ["pack/a", "pack/c"] }));
  });

  test("an empty list is signed as an empty list; no list at all is signed as none", () => {
    const a = own();
    expect(answer(a.store, a.token, "approve", [])).toMatchObject({ kids: [] });
    const b = own();
    const out = answer(b.store, b.token, "approve", undefined);
    expect("kids" in out).toBe(false);
  });

  test("an id the card doesn't carry, or one named twice, is never signed", () => {
    const a = own();
    expect(answer(a.store, a.token, "approve", ["pack/a", "other/z"])).toMatchObject({ error: "a ticked box isn't on this card" });
    const b = own();
    expect(answer(b.store, b.token, "approve", ["pack/a", "pack/a"])).toMatchObject({ error: "a box is ticked twice" });
  });

  test("a deny carries no ticks, whatever the page sent", () => {
    const { store, token } = own();
    const out = answer(store, token, "deny", ["pack/a"]);
    expect("kids" in out).toBe(false);
    expect(out).toMatchObject({ proof: { via: "device" } });
  });

  test("a card with no boxes takes no ticks", () => {
    const { store, token } = own({ ...CARD, children: undefined });
    expect(answer(store, token, "approve", ["pack/a"])).toMatchObject({ error: "this card has no boxes to tick" });
  });

  test("a refused answer leaves the card able to answer again with the same checks", () => {
    const { store, token } = own();
    expect(answer(store, token, "approve", ["nope"])).toMatchObject({ error: expect.any(String) });
    expect(answer(store, token, "approve", ["pack/b"])).toMatchObject({ kids: ["pack/b"] });
  });
});

describe("a card whose boxes can't be drawn whole", () => {
  const same = { ...CARD, children: [kid("a", "Same"), kid("b", "Same")] };
  test("is never approved from the own card, and can be denied", () => {
    const a = own(same);
    expect(answer(a.store, a.token, "approve", ["a"])).toMatchObject({ error: "two boxes read the same" });
    expect(answer(a.store, a.token, "approve", undefined)).toMatchObject({ error: "two boxes read the same" });
    expect(answer(a.store, a.token, "deny")).toMatchObject({ proof: { via: "device" } });
  });
});

describe("a part's own button never approves a card that has boxes", () => {
  test("the approve is refused with where to answer it; its deny answers; its channel is kept", () => {
    const store = new SealedFrames();
    store.fromCore(CARD);
    const approve = store.mint(CARD.id, "button:approve", main0)!.token;
    const deny = store.mint(CARD.id, "button:deny", main0)!.token;
    expect(answer(store, approve, "approve")).toMatchObject({ error: CHILDREN_OWN_CARD_ONLY });
    expect(answer(store, approve, "approve", ["pack/a"])).toMatchObject({ error: CHILDREN_OWN_CARD_ONLY });
    expect(answer(store, deny, "deny")).toMatchObject({ proof: { via: "device" } });
  });

  test("a card with boxes is never in place in a part (both its buttons showing there don't stand the own card down)", () => {
    const store = new SealedFrames();
    store.fromCore(CARD);
    for (const o of ["approve", "deny"]) store.markVisible(store.mint(CARD.id, `button:${o}`, main0)!.token, true);
    expect(store.buttonsVisible(CARD.id)).toBe(false);
    const plain = { ...CARD, id: "card_plain", children: undefined };
    store.fromCore(plain);
    for (const o of ["approve", "deny"]) store.markVisible(store.mint(plain.id, `button:${o}`, main0)!.token, true);
    expect(store.buttonsVisible(plain.id)).toBe(true);
  });
});

describe("a part's own approve on a card with boxes is a review", () => {
  test("needsReview: a part's approve button on a card with boxes, never its deny, the own card's, or a card with none", () => {
    const store = new SealedFrames();
    store.fromCore(CARD);
    const approve = store.mint(CARD.id, "button:approve", main0)!.token;
    const deny = store.mint(CARD.id, "button:deny", main0)!.token;
    const whole = store.mint(CARD.id, OWN_ELEMENT, main0)!.token;
    expect([store.needsReview(approve), store.needsReview(deny), store.needsReview(whole)]).toEqual([true, false, false]);
    // A card that is no longer pending is no review.
    store.resolvedOutcome(CARD.id, "denied");
    expect(store.needsReview(approve)).toBe(false);
    store.fromCore({ ...CARD, id: "card_plain", children: undefined });
    expect(store.needsReview(store.mint("card_plain", "button:approve", main0)!.token)).toBe(false);
  });
});
