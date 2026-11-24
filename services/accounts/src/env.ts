import type { AccountDO } from "./account-do";
import type { KeysDO } from "./keys";

export interface Env {
  /** One object per account: its devices. */
  ACCOUNTS: DurableObjectNamespace<AccountDO>;
  /** The local profile's signing keys, in memory (keys.ts). */
  KEYS: DurableObjectNamespace<KeysDO>;
  /** Per client address, before the sign-in is checked: each check is a call to the Supabase project. */
  ADDRESS_RATE: RateLimit;
  /** Per account. */
  API_RATE: RateLimit;

  /** The `iss` of the tokens minted here: this service's public URL, its path prefix included. */
  ISSUER: string;
  /** Where this Worker's paths start: "" on a host of its own, "/auth" under https://waifucave.com/auth. */
  PATH_PREFIX?: string;
  /** Waifucave's Supabase project, whose sessions are the sign-in, and its public (anon) key. */
  AUTH_URL: string;
  AUTH_ANON_KEY: string;
  /** The audiences tokens may be minted for, comma-separated: the hooks forwarder, push and the handshake. */
  AUDIENCES: string;
  /** Seconds a token lives, at most 300 (the default). */
  TOKEN_TTL?: string;

  /** Secret: {"keys":[private JWK with kid, ...]}; the first signs, every key is published. */
  SIGNING_JWKS?: string;
  /** The local profile only: "1" makes signing keys in memory when SIGNING_JWKS is unset. */
  EPHEMERAL_KEYS?: string;
  /** The local profile only: "1" opens POST /dev/token, a mint without a sign-in, for emulator tests. */
  DEV_MINT?: string;

  // The account's deletion (deletion.ts): where it tells the other services to forget the account, through a service
  // binding when there is one (production: a Worker can't fetch another Worker's route on its own zone), else the URL.
  // A service with neither stays pending in the deletion's answer and is retried.
  HOOKS_URL?: string;
  PUSH_URL?: string;
  HANDSHAKE_URL?: string;
  HOOKS_SERVICE?: Fetcher;
  PUSH_SERVICE?: Fetcher;
  HANDSHAKE_SERVICE?: Fetcher;
  /** Secret: the Supabase project's service-role key, for the one call that deletes the person's sign-in
   *  (`DELETE <AUTH_URL>/auth/v1/admin/users/<id>`). Unset, a deletion is refused (503) before anything is deleted. */
  AUTH_SERVICE_ROLE_KEY?: string;
}
