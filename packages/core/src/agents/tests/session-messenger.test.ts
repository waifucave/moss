// The engine's SessionMessenger (lane CM): the contract's conformance suite on the real class, the property that the
// listing equals the rule and the send delivers exactly there, and what a guess at a session learns.
import { describe, expect, test } from "bun:test";
import { LIST_SESSIONS_MAX, SESSION_SEND_LIMIT, SESSION_SEND_WINDOW_MS, reachRefusal, type SessionKind, type SessionView } from "@waifucave/moss-protocol";
import { runSessionMessengerConformance } from "../../contracts/conformance/session-reach";
import type { DeliveredInput } from "../../contracts/session-host";
import { EngineSessionMessenger, type EngineMessengerWorld } from "../bridge/messenger";

runSessionMessengerConformance((world) => new EngineSessionMessenger(world));
