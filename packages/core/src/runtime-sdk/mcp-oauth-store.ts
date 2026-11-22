import { createKeychainMcpOAuthStore, type McpOAuthStore } from "@waifucave/clover-agent-runtime/mcp-auth";
import { defaultSecretsBackend, MIGRATION_SHADOW_SUFFIX } from "../auth/secret-store";
import { underTest } from "../auth/test-isolation";

// WS-25: the daemon's ONE MCP OAuth token/registration store per keychain service. `refreshMcpOAuthToken`'s
// single-flight is keyed on the store OBJECT, so every caller (the refresh handler, credential_resolve, the
// status probe, the login/logout RPCs) must share this instance -- never construct a second one.
const stores = new Map<string, McpOAuthStore>();

export function daemonMcpOAuthStore(keychainService: string, home?: string): McpOAuthStore {
  let store = stores.get(keychainService);
  if (store === undefined) {
    store = withShadowRemoval(process.platform === "darwin" || underTest() ? createKeychainMcpOAuthStore(keychainService) : backendStore(keychainService, home));
    stores.set(keychainService, store);
  }
  return store;
}

/** WS-27: a removed sign-in item takes its migration shadow (`<account>.migrating`, `auth/credential-acl.ts`)
 *  with it, so the next boot's shadow recovery can never bring the removed sign-in back. */
export function withShadowRemoval(base: McpOAuthStore): McpOAuthStore {
  return {
    read: (account) => base.read(account),
    write: (account, value) => base.write(account, value),
    async remove(account) {
      // The shadow FIRST, so a crash between the two never leaves a shadow beside a missing original.
      if (!account.endsWith(MIGRATION_SHADOW_SUFFIX)) {
        try { await base.remove(`${account}${MIGRATION_SHADOW_SUFFIX}`); } catch { /* none, or not ours */ }
      }
      await base.remove(account);
    },
  };
}

/** The sign-ins on Windows and Linux (spec §9.1): the SDK's own keychain store reads `Bun.secrets` itself, which there is
 *  the OS store; these go through the secrets file like every other item (`defaultSecretsBackend`). A process under a test
 *  keeps the SDK's store, which reads the isolated `Bun.secrets` (`auth/test-isolation.ts`). */
function backendStore(service: string, home?: string): McpOAuthStore {
  const backend = () => defaultSecretsBackend({ service, ...(home !== undefined ? { home } : {}) });
  return {
    read: async (account) => (await backend().get({ service, name: account })) ?? null,
    write: async (account, value) => { await backend().set({ service, name: account, value }); },
    remove: async (account) => { await backend().delete({ service, name: account }); },
  };
}
