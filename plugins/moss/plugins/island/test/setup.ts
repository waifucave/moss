import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({ url: "http://localhost/", width: 1280, height: 800 });

const { afterEach } = await import("bun:test");
const { cleanup } = await import("@testing-library/react");
// A kept value (`useKept`) outlives an unmount, as it must across a document's reload: each test starts with the window's storage empty.
afterEach(() => { cleanup(); try { sessionStorage.clear(); } catch { /* none */ } });
