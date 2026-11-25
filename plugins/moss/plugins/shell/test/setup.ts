import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register();
// Each test starts with the window's storage empty: a kept value (`useKept`) is the previous test's otherwise (an unmounted part leaves a note of
// its value for a document that replaces it, which on a runner whose test process loads the SDK twice reads as another document's).
import { afterEach } from "bun:test";
afterEach(() => { try { sessionStorage.clear(); } catch { /* none */ } });
