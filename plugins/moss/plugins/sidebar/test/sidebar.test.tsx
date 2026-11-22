import { afterEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { Sidebar } from "../client/Sidebar";
import type { SidebarProps } from "../client/types";
import { ACCOUNT, APPS, PROJECTS } from "../gallery/fixtures";

afterEach(cleanup);

/** The document goes with no unmount (a reload runs no cleanup): the window's session storage as it was. */
const reload = (again: () => void) => {
  const atReload = Object.fromEntries(Array.from({ length: sessionStorage.length }, (_, i) => sessionStorage.key(i)!).map((k) => [k, sessionStorage.getItem(k)!]));
  cleanup();
  for (const [k, v] of Object.entries(atReload)) sessionStorage.setItem(k, v);
  again();
};

function setup(props: Partial<SidebarProps> = {}) {
  const handlers = {
    onNavigate: mock((_r: unknown) => undefined),
    onOpenSettings: mock(() => undefined),
    onNew: mock(() => undefined),
    onSearch: mock(() => undefined),
    onOutputs: mock(() => undefined),
    onPlugins: mock(() => undefined),
    onMore: mock(() => undefined),
    onNewSession: mock((_p: string) => undefined),
    onCloseAgent: mock((_id: string) => undefined),
  };
  const result = render(
    <Sidebar route={{ kind: "agent", agentId: "session-panels" }} projects={PROJECTS} apps={APPS} account={ACCOUNT} {...handlers} {...props} />,
  );
  return { ...result, ...handlers };
}

describe("the actions (no bots in MOSS Code's window)", () => {
  test("no switch to a bots side and no bot anywhere; each action reaches the host, New starts a session", () => {
    const h = setup();
    expect(screen.queryByRole("radio")).toBeNull();
    expect(screen.queryByText("Bots")).toBeNull();
    expect(document.querySelector(".cl-sidebar__bot, .cl-sidebar__portrait")).toBeNull();
    for (const [name, fn] of [
      ["New session", h.onNew],
      ["Search", h.onSearch],
      ["Outputs", h.onOutputs],
      ["Plugins", h.onPlugins],
      ["More", h.onMore],
    ] as const) {
      fireEvent.click(screen.getByRole("button", { name }));
      expect(fn).toHaveBeenCalledTimes(1);
    }
  });

  test("the account and the gear at the bottom open settings", () => {
    const h = setup();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Account: Sam" }));
    expect(h.onOpenSettings).toHaveBeenCalledTimes(2);
  });
});

describe("the code side", () => {
  test("sessions sit under their project folder, with their branch and change count", () => {
    const h = setup({ route: { kind: "agent", agentId: "session-panels" } });
    const row = screen.getByRole("button", { name: /The panels as plugins/ });
    expect(row.getAttribute("aria-current")).toBe("page");
    // The row names its session by id (what never changes as its title lands), for whatever finds it.
    expect(row.getAttribute("data-session")).toBe("session-panels");
    expect(within(row).getByLabelText("On lane/f-m1, 14 files changed").textContent).toBe("14");
    fireEvent.click(screen.getByRole("button", { name: "New session in moss" }));
    expect(h.onNewSession).toHaveBeenCalledWith("moss");
    expect(screen.getByText("No sessions here yet")).toBeTruthy();
  });

  test("a project folds and unfolds", () => {
    setup({ initialFoldedProjects: ["tarot"] });
    expect(screen.queryByText("Three-card spread layout")).toBeNull();
    const toggle = screen.getByRole("button", { name: "Unfold tarot-panel" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(screen.getByText("Three-card spread layout")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Fold moss" }));
    expect(screen.queryByText("The panels as plugins")).toBeNull();
  });
});

describe("banners and the rail", () => {
  test("safe mode, the pause switch and the link each say so, with their action", () => {
    const onResume = mock(() => undefined);
    const onOpenPluginManager = mock(() => undefined);
    setup({ safeMode: true, paused: true, onResume, onOpenPluginManager, link: { state: "unreachable", main: "Studio" } });
    expect(screen.getByText("Safe mode: only MOSS's own plugins are running.")).toBeTruthy();
    expect(screen.getByText("Can't reach your main computer, Studio. Your bots wait for it.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    fireEvent.click(screen.getByRole("button", { name: "Open the plugin manager" }));
    expect(onResume).toHaveBeenCalledTimes(1);
    expect(onOpenPluginManager).toHaveBeenCalledTimes(1);
  });

  test("collapsed, every row and banner keeps an accessible name, and the projects stay", () => {
    const onResume = mock(() => undefined);
    setup({ collapsed: true, paused: true, onResume, link: { state: "offline" } });
    fireEvent.click(screen.getByRole("button", { name: "Every bot and routine is paused." }));
    expect(onResume).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Offline: other devices can't be reached." })).toBeTruthy();
    expect(screen.getByRole("button", { name: "moss: 3" })).toBeTruthy();
  });
});

describe("the room for the window's controls, and ids", () => {
  test("the first row leaves the window's controls their room, and the window drags by it", () => {
    const { container } = setup({ onToggleCollapsed: () => undefined });
    const top = container.querySelector<HTMLElement>(".cl-sidebar__top")!;
    expect(top.firstElementChild?.className).toBe("cl-sidebar__controls");
    expect(top.firstElementChild?.getAttribute("aria-hidden")).toBe("true");
    expect(screen.getByRole("button", { name: "Hide the sidebar" }).parentElement).toBe(top);
  });

  test("a project's list gets an id from React, so a project id with a space never breaks aria-controls", () => {
    const projects = [{ id: "my project", name: "my project", path: "home/Studio/my project", sessions: [{ id: "s1", title: "One", status: "idle" as const }] }];
    setup({ projects });
    const toggle = screen.getByRole("button", { name: "Fold my project" });
    const controls = toggle.getAttribute("aria-controls")!;
    expect(controls).not.toContain(" ");
    expect(document.getElementById(controls)?.textContent).toContain("One");
  });

  test("running never shares a mark with needs-you or stalled", () => {
    const { container } = setup({ projects: [...PROJECTS, { id: "stuck", name: "stuck", path: "home/Studio/stuck", sessions: [{ id: "st", title: "Stuck", status: "stalled" as const }] }] });
    expect(container.querySelector('.cl-sidebar__dot[data-status="running"]')).toBeTruthy();
    expect(container.querySelector('.cl-sidebar__dot[data-status="stalled"]')).toBeTruthy();
    const css = readFileSync(join(import.meta.dir, "../client/styles.css"), "utf8");
    const rule = (sel: string) => css.slice(css.indexOf(sel), css.indexOf("}", css.indexOf(sel)));
    expect(rule('.cl-sidebar__dot[data-status="running"]')).toContain("--moss-color-accent");
    expect(rule('.cl-sidebar__dot[data-status="stalled"]')).toContain("--moss-color-danger");
    expect(rule('.cl-sidebar__dot[data-status="needs-you"]')).toContain("--moss-color-attention");
  });
});

describe("the sidebar across a reload of the window's document (a plugin with its own layer installed)", () => {
  test("a folded project stays folded, and the list's scroll comes back once the rows are tall enough", () => {
    sessionStorage.clear();
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Fold moss" }));
    expect(screen.queryByText("The panels as plugins")).toBeNull();
    reload(() => void setup());
    expect(screen.getByRole("button", { name: "Unfold moss" }).getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("The panels as plugins")).toBeNull();
  });

  test("the scroll position is written after a scroll and put back in a document loaded again", async () => {
    sessionStorage.clear();
    // happy-dom lays nothing out: the list is 2000 tall in a 500 window.
    const proto = HTMLElement.prototype;
    Object.defineProperty(proto, "scrollHeight", { configurable: true, get: () => 2000 });
    Object.defineProperty(proto, "clientHeight", { configurable: true, get: () => 500 });
    try {
      setup();
      const scroller = document.querySelector<HTMLElement>(".cl-sidebar__scroll")!;
      scroller.scrollTop = 640;
      fireEvent.scroll(scroller);
      await new Promise((done) => setTimeout(done, 250));
      reload(() => void setup());
      expect(document.querySelector<HTMLElement>(".cl-sidebar__scroll")!.scrollTop).toBe(640);
    } finally {
      delete (proto as { scrollHeight?: number }).scrollHeight;
      delete (proto as { clientHeight?: number }).clientHeight;
    }
  });
});
