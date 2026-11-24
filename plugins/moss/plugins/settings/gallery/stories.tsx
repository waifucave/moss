// Every settings state the gallery shows.
import { useState } from "react";
import { LanguageChooser } from "../client/LanguageChooser";
import { SettingsModal } from "../client/SettingsModal";
import type { SettingsPairing, SettingsSection } from "../client/types";
import { LANGUAGES, LOG_LINES, VALUES } from "./fixtures";
import type { Story } from "./story";

const noop = () => undefined;

/** Settings over the gallery's fixtures. A host that draws the cards Settings raises passes their doors. */
export function SettingsDemo({ start, onRequestLevel = noop, onRemoveDevice = noop, logs, extra, pairing }: { start: SettingsSection | string; onRequestLevel?: () => void; onRemoveDevice?: () => void; logs?: boolean; extra?: boolean; pairing?: SettingsPairing }) {
  const [section, setSection] = useState<SettingsSection | string>(start);
  const [showLogs, setShowLogs] = useState(logs === true);
  return (
    <SettingsModal
      section={section}
      onSection={(s) => {
        setShowLogs(false);
        setSection(s);
      }}
      onClose={noop}
      values={VALUES}
      onChange={noop}
      onOpenLanguage={noop}
      onOpenPluginManager={noop}
      onOpenPluginLogs={noop}
      onRequestLevel={onRequestLevel}
      onRemoveDevice={onRemoveDevice}
      onEditBot={noop}
      onMakeMain={onRequestLevel}
      onPairBegin={noop}
      onPairJoin={noop}
      onPairCancel={noop}
      {...(pairing ? { pairing } : {})}
      {...(extra ? { extraSections: [{ id: "moss-usage#settings", title: "Usage", render: () => <p className="cl-settings__note">The usage plugin draws this page: today's spend by model and by bot.</p> }] } : {})}
      {...(showLogs ? { logs: { name: "Story mode", lines: LOG_LINES, onBack: () => setShowLogs(false) } } : {})}
    />
  );
}

export const settingsStories: Story[] = [
  { id: "settings/appearance", title: "Settings: Appearance", notes: "Light or dark, the theme (themes are plugins), text size, and the language, which opens the chooser.", width: 1060, height: 820, render: () => <SettingsDemo start="appearance" /> },
  { id: "settings/plugins", title: "Settings: Plugins", notes: "Each plugin with its state, the OKs it runs with, its logs and its switch (spec §5.8).", width: 1060, height: 820, render: () => <SettingsDemo start="plugins" /> },
  { id: "settings/plugin-logs", title: "Settings: a plugin's logs", notes: "A plugin's log in place of the list, with Back (spec §5.8). Story mode stopped after an error.", width: 1060, height: 820, render: () => <SettingsDemo start="plugins" logs /> },
  { id: "settings/bots", title: "Settings: Bots", notes: "Each bot, opening in the bot editor.", width: 1060, height: 820, render: () => <SettingsDemo start="bots" /> },
  { id: "settings/levels", title: "Settings: Levels", notes: "Each computer's level (spec §9.1). A pick raises a sealed card, and Settings closes for it; Laptop's change, asked from another device, still waits for its card.", width: 1060, height: 820, render: () => <SettingsDemo start="levels" /> },
  { id: "settings/devices", title: "Settings: Devices", notes: "The paired devices; removing one asks on a card first.", width: 1060, height: 820, render: () => <SettingsDemo start="devices" /> },
  { id: "settings/usage", title: "A section a plugin adds: Usage", notes: "Usage is the usage plugin's (`settings.section`), after MOSS's own; a stand-in draws its page here.", width: 1060, height: 820, render: () => <SettingsDemo start="moss-usage#settings" extra /> },
  { id: "settings/pairing", title: "Settings: pairing a device", notes: "Another device is in: a card on this computer draws the four words, and the person compares them with the other screen. The page never has them. Make main asks on a card too.", width: 1060, height: 820, render: () => <SettingsDemo start="devices" pairing={{ checking: true, peerName: "Pixel" }} /> },
  { id: "settings/pairing-code", title: "Settings: a code to scan", notes: "The code (and its picture for a phone to scan) with the time it stops working.", width: 1060, height: 820, render: () => <SettingsDemo start="devices" pairing={{ code: "KQ7-M2P", qr: "clover-pair:1:AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyAhIiMkJSYnKCkqKywtLi8wMTIzNDU2Nzg5Ojs8PT4_QA", expiresAt: Date.now() + 9 * 60_000 }} /> },
  {
    id: "settings/languages",
    title: "The language chooser",
    notes: "Each language named in itself and in the app's language; the current one checked.",
    width: 900,
    height: 580,
    render: () => <LanguageChooser languages={LANGUAGES} current="en-US" onPick={noop} onClose={noop} />,
  },
];
