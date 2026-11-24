// The settings window's props: the values it shows and one door back for every change. A change to the
// core's settings goes straight to the host; anything sensitive (a computer's level, removing a device)
// becomes a sealed card there (spec §5.5). The window closes Settings while a card it draws waits, so
// asking from here closes it and the card shows in its place. A change still waiting on a card drawn
// elsewhere (asked from another device) shows here as asked for, beside the level that holds.
// Its sections are MOSS's own (spec §5.8, §12); a page with nothing to set yet says so.

import type { ReactNode } from "react";

/** MOSS's own sections. Usage is the usage plugin's, which fills `settings.section` (the controller's R3). */
export type SettingsSection = "account" | "devices" | "appearance" | "notifications" | "plugins" | "tools" | "levels";

export type ToolPermission = "allow" | "ask" | "deny";
/** Whether a model is offered a tool at all (spec §6.7): off, behind Glossary (or an agent's own tool search), or preloaded. */
export type ToolAvailability = "off" | "on-demand" | "always";
/** The Tools tab's data (`tool.permissions`), the bots named for their cards' rules. `availability` and `declared` come from an
 *  engine that serves the tool setting: `declared` is what the plugin says, the default. */
export interface ToolsView {
  plugins: { pluginId: string; name: string; server: string; tools: { name: string; title?: string; permission: ToolPermission; availability?: ToolAvailability; declared?: "preload" | "on-demand"; isNew?: boolean; cardRules: { bot: string; botName: string; computers: string[] }[] }[] }[];
}

/** A plugin's state (lane B's `PLUGIN_STATES`, spec §5.1): found and waiting for the user's OK, refused, invalid, off,
 *  waiting for a point another plugin declares, running, or stopped after crashes. */
export type PluginState = "found" | "refused" | "invalid" | "off" | "waiting" | "running" | "stopped";

export interface SettingsPlugin {
  id: string;
  name: string;
  /** Where it came from: bundled, the plugin index, a folder. */
  source: string;
  state: PluginState;
  /** Switched on: the toggle. A plugin can be on and still waiting or stopped. */
  enabled: boolean;
  /** Why it is in that state: "waiting for `island.tab`", what stopped it. */
  reason?: string;
  /** MOSS's own plugin this build can't run yet: its reason is the one line, with no switch, Open or Logs. */
  notYet?: true;
  /** What it may do, each an OK the user gave it, in plain words. */
  /** What its OK lets it do, in plain words: shown when known (the Plugins page shows it for one plugin opened). */
  oks?: string[];
}

export interface SettingsDevice {
  id: string;
  name: string;
  kind: "computer" | "phone" | "web";
  /** This device. */
  here?: boolean;
  main?: boolean;
  /** Reached over its link now. */
  online?: boolean;
  /** When it was last seen over its link, in ms (shown when it is not online now). */
  lastSeen?: number;
}

/** One computer's level (spec §9.1: levels are per computer). */
export interface SettingsComputerLevel {
  computer: string;
  /** This device. */
  here?: boolean;
  level: string;
  /** A change asked for, its card still waiting (one drawn on another device). */
  requested?: string;
}

export interface SettingsValues {
  account: { name: string; main: string };
  appearance: { theme: "light" | "dark" | "system"; textSize: "small" | "default" | "large" };
  language: { id: string; name: string };
  notifications: { needsYou: boolean; agentDone: boolean; routineFailed: boolean; sounds: boolean };
  plugins: SettingsPlugin[];
  /** The installed themes (spec §5.5: a theme is a plugin). */
  themes: { id: string; name: string }[];
  theme: string;
  levels: SettingsComputerLevel[];
  /** MOSS's levels, from the most careful. */
  levelOptions: { id: string; label: string }[];
  devices: SettingsDevice[];
  /** The bots, for the Bots page: each opens in the bot editor. */
  bots?: { id: string; name: string }[];
}

/** A section a plugin adds (`settings.section`): its title, and what its page draws. */
export interface ExtraSection {
  id: string;
  title: string;
  render: () => ReactNode;
}

/** A point that takes one filler at a time (spec §5.4 "One at a time"), as `point.active.list` gives it: Settings
 *  draws a picker for it, titled by its own title, when it has two or more fillers. */
export interface OneAtATimeView {
  point: string;
  title: string;
  fillers: { pluginId: string; entryId: string; name: string }[];
  active?: { pluginId: string; entryId: string };
  chosen?: { pluginId: string; entryId: string };
}

export interface SettingsModalProps {
  /** A change that didn't take, said at the top of the page (the control has gone back to what is real). */
  failure?: string;
  /** The controls whose change is being saved (each takes no second press until it is done), and those whose last
   *  change wasn't saved (each back on its stored value, with a line beside it saying so), by their path
   *  (`notifications.needsYou`, `plugins.<id>.enabled`). */
  saves?: { busy: ReadonlySet<string>; failed: ReadonlySet<string> };
  /** One of MOSS's own sections, or an added one's id. */
  section: SettingsSection | string;
  onSection: (section: SettingsSection | string) => void;
  /** A row to bring into view and mark: a device's id on Devices, a plugin's id on Plugins, a computer's name on
   *  Levels, a bot's id on Bots. Other sections have nothing to mark. */
  item?: string;
  onClose: () => void;
  values: SettingsValues;
  /** One door for every plain change: a dotted path into `values` (`appearance.theme`) and the new value. */
  onChange: (path: string, value: unknown) => void;
  onOpenLanguage: () => void;
  /** Opens the setup guide again (Account's "Setup guide" row); none: no row. */
  onOpenSetup?: () => void;
  onOpenPluginManager?: () => void;
  /** A plugin's logs (spec §5.8). */
  onOpenPluginLogs?: (id: string) => void;
  /** Opens one plugin on the Plugins page (what it may do, its tools, settings and log). */
  onOpenPlugin?: (id: string) => void;
  /** Ask to change a computer's level: always a sealed card (spec §5.5). */
  onRequestLevel?: (computer: string, level: string) => void;
  /** Ask to remove a device: a sealed card too. */
  onRemoveDevice?: (id: string) => void;
  /** Ask to make a computer the main one: a sealed card too (§6.4). */
  onMakeMain?: (id: string) => void;
  /** Pairing a device without an account (§8.1): the code this device shows with its expiry, then the step the engine's card is at. */
  pairing?: SettingsPairing;
  /** Which relay the links use (§8.3); undefined while it loads. */
  relay?: RelayChoice;
  /** The relay plugins installed: listed, not offered (the links take no relay plugin yet). */
  relayPlugins?: { id: string; name: string; why?: string }[];
  /** The person's own choice of relay, applied at once by the engine. */
  onSetRelay?: (choice: RelayChoice) => void;
  /** Show a code here for another device to enter. */
  onPairBegin?: () => void;
  /** Enter the code another device shows. */
  onPairJoin?: (code: string) => void;
  onPairCancel?: () => void;
  /** Sections plugins add, after MOSS's own. */
  extraSections?: ExtraSection[];
  /** A plugin's log, shown on the Plugins page in place of the list. */
  logs?: { name: string; lines: string[]; onBack: () => void };
  /** Open a bot in the bot editor. */
  onEditBot?: (id: string) => void;
  /** Tools: what each plugin tool is set to, undefined while it loads; set one tool (or, with no tool, all the plugin lists now), or take back a card's saved rule for one bot. */
  tools?: ToolsView;
  onSetTool?: (server: string, tool: string | undefined, permission: ToolPermission) => void;
  /** Off, on demand or always on for one tool (or, with no tool, every tool the plugin lists now): what models are offered. */
  onSetAvailability?: (server: string, tool: string | undefined, availability: ToolAvailability) => void;
  onTakeBackRule?: (server: string, tool: string, bot: string) => void;
  /** The one-at-a-time points (on the Plugins page), and the user's pick of the active filler of one. */
  oneAtATime?: OneAtATimeView[];
  onPickActive?: (point: string, entry: { pluginId: string; entryId: string }) => void;
}

/** A pairing under way: the code (and the picture a phone scans) to enter on the other device and when it stops working, then the
 *  engine's own card, which draws the four words. This page never has the words: it is told the step and the other device's name. */
export interface SettingsPairing {
  /** The short code to type on the other device, when the engine has one. */
  code?: string;
  /** What the QR picture holds (and what can be typed or pasted when there is no short code). */
  qr?: string;
  /** When the code stops working, in ms; absent when not known. */
  expiresAt?: number;
  /** Another device is in: the add card is up (or on its way), and the words are on it. */
  checking?: boolean;
  /** The name the other device gave itself, once it is known. */
  peerName?: string;
  /** While the code waits: a device tried to join and was turned away, in the engine's words (never the other device's own text). */
  note?: string;
  /** It ended without a device: why, in words. */
  ended?: string;
}

/** The relay the links use (§8.3, `device.relay.get`): n0's public relays, none, or a server of the person's own. */
export interface RelayChoice {
  mode: "n0" | "off" | "custom";
  url?: string;
}

export interface Language {
  id: string;
  /** Its name in itself. */
  native: string;
  /** Its name in the language the app shows now. */
  name: string;
}

export interface LanguageChooserProps {
  languages: Language[];
  current: string;
  onPick: (id: string) => void;
  onClose: () => void;
}
