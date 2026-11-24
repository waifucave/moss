import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register();
// A kept value (`useKept`) outlives an unmount, as it must across a document's reload: each test starts with the window's storage empty.
import { afterEach } from "bun:test";
afterEach(() => { try { sessionStorage.clear(); } catch { /* none */ } });
