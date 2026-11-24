// MOSS Code's setup guide, the relay page (spec §8.3): reached from the done step; what a relay is for, n0's public relays on
// by default, a server of the person's own, none; the cloud computer's and Cloudflare's shown and not offered. Saved through the
// engine's relay methods (the page's calls `welcome.relay` and `welcome.setRelay`).
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, describe, expect, test } from "bun:test";
import { pageCall, PAGE_CALLS, type PageClient, type PageDeps } from "../src/main/core-pages";

GlobalRegistrator.register();
const { showWelcome } = await import("../src/core/pages");
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const wait = (ms = 20) => new Promise((r) => setTimeout(r, ms));

describe("the guide's relay page", () => {
  test("from the done step: n0's relays by default, the two relay plugins not offered, a server of your own saved, back to the done step", async () => {
    const host = document.createElement("div");
    host.id = "moss-page";
    document.body.append(host);
    let kept: { mode: string; url?: string } = { mode: "n0" };
    const sets: unknown[] = [];
    const setup = { ready: true, missing: [], providers: ["anthropic"], default: { model: "anthropic/claude-opus-5-5", source: "chosen", effort: "medium" }, dismissed: false };
    const call = async (name: string, params?: unknown): Promise<unknown> => {
      if (name === "welcome.providers") return { providers: [{ id: "moss/model-anthropic", name: "Anthropic", auth: [{ index: 0, method: "api-key", state: "signed-in" }] }] };
      if (name === "welcome.setup") return setup;
      if (name === "welcome.models") return { models: [{ id: "anthropic/claude-opus-5-5", name: "Claude Opus 5.5", provider: "anthropic", providerName: "Anthropic" }] };
      if (name === "welcome.relay") return kept;
      if (name === "welcome.setRelay") {
        sets.push(params);
        const p = params as { mode: string; url?: string };
        if (p.mode === "custom" && !String(p.url).startsWith("https://")) throw new Error("a relay server's address is an https:// address");
        kept = p;
        return kept;
      }
      return {};
    };
    const t = (key: string) => key;
    await showWelcome(host, t as never, call as never, () => {});
    await wait();
    (host.querySelector("[data-moss-welcome=next]") as HTMLButtonElement).click();
    await wait();
    (host.querySelector("[data-moss-welcome=next]") as HTMLButtonElement).click();
    await wait();
    expect(host.querySelector("[data-moss-welcome-step=done]")).not.toBeNull();
    (host.querySelector("[data-moss-welcome=relay]") as HTMLButtonElement).click();
    await wait();
    expect(host.querySelector("[data-moss-welcome-step=relay]")).not.toBeNull();
    const radio = (v: string) => host.querySelector(`[data-moss-relay=${v}] input`) as HTMLInputElement;
    const save = () => host.querySelector("[data-moss-welcome=relay-save]") as HTMLButtonElement;
    expect(radio("n0").checked).toBe(true);
    expect(save().disabled).toBe(true);
    expect(radio("cloud").disabled).toBe(true);
    expect(radio("cloudflare").disabled).toBe(true);
    // Your own server: refused without https, kept with it.
    radio("custom").click();
    const url = host.querySelector("[data-moss-relay-url]") as HTMLInputElement;
    expect(url.hidden).toBe(false);
    expect(save().disabled).toBe(true);
    url.value = "http://nope.example.test";
    url.dispatchEvent(new Event("input"));
    save().click();
    await wait();
    expect(host.querySelector(".moss-page__status")?.textContent).toContain("welcome.failed");
    url.value = "https://relay.example.test";
    url.dispatchEvent(new Event("input"));
    save().click();
    await wait();
    expect(sets.at(-1)).toEqual({ mode: "custom", url: "https://relay.example.test" });
    expect(host.querySelector(".moss-page__status")?.textContent).toBe("welcome.relay-saved");
    // No relay, then Back to the done step.
    radio("off").click();
    save().click();
    await wait();
    expect(kept).toEqual({ mode: "off" });
    (host.querySelector("[data-moss-welcome=back]") as HTMLButtonElement).click();
    await wait();
    expect(host.querySelector("[data-moss-welcome-step=done]")).not.toBeNull();
  });

  test("the page's calls reach the engine's relay methods, and only with a known mode", async () => {
    expect(PAGE_CALLS).toContain("welcome.relay");
    expect(PAGE_CALLS).toContain("welcome.setRelay");
    const seen: [string, unknown][] = [];
    const client = { request: async (m: string, p: unknown) => { seen.push([m, p]); return { mode: "n0" }; } } as unknown as PageClient;
    const deps = { client: () => client, lang: () => "en" } as unknown as PageDeps;
    await pageCall("welcome.relay", {}, deps);
    await pageCall("welcome.setRelay", { mode: "custom", url: "https://r.example.test" }, deps);
    await expect(pageCall("welcome.setRelay", { mode: "bogus" }, deps)).rejects.toThrow();
    expect(seen).toEqual([["device.relay.get", {}], ["device.relay.set", { mode: "custom", url: "https://r.example.test" }]]);
  });
});
