import type { ServerAuthDescriptor } from "@t3tools/contracts";
import { Effect, Layer } from "effect";

import { ServerConfig } from "../../config.ts";
import { ServerAuthPolicy, type ServerAuthPolicyShape } from "../Services/ServerAuthPolicy.ts";

const SESSION_COOKIE_NAME = "t3_session";

export const makeServerAuthPolicy = Effect.gen(function* () {
  const config = yield* ServerConfig;

  const descriptor: ServerAuthDescriptor =
    config.mode === "desktop"
      ? {
          policy: "desktop-managed-local",
          bootstrapMethods: ["desktop-bootstrap"],
          sessionMethods: ["browser-session-cookie", "bearer-session-token"],
          sessionCookieName: SESSION_COOKIE_NAME,
        }
      : {
          policy: "loopback-browser",
          bootstrapMethods: ["one-time-token"],
          sessionMethods: ["browser-session-cookie", "bearer-session-token"],
          sessionCookieName: SESSION_COOKIE_NAME,
        };

  return {
    getDescriptor: () => Effect.succeed(descriptor),
  } satisfies ServerAuthPolicyShape;
});

export const ServerAuthPolicyLive = Layer.effect(ServerAuthPolicy, makeServerAuthPolicy);
