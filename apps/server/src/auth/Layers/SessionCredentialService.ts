import { DateTime, Duration, Effect, Layer, Schema } from "effect";

import { ServerSecretStore } from "../Services/ServerSecretStore.ts";
import {
  SessionCredentialError,
  SessionCredentialService,
  type IssuedSession,
  type SessionCredentialServiceShape,
  type VerifiedSession,
} from "../Services/SessionCredentialService.ts";
import {
  base64UrlDecodeUtf8,
  base64UrlEncode,
  signPayload,
  timingSafeEqualBase64Url,
} from "../tokenCodec.ts";

const SIGNING_SECRET_NAME = "server-signing-key";
const DEFAULT_SESSION_TTL = Duration.days(30);

const SessionClaims = Schema.Struct({
  v: Schema.Literal(1),
  kind: Schema.Literal("session"),
  sub: Schema.String,
  method: Schema.Literals(["browser-session-cookie", "bearer-session-token"]),
  iat: Schema.Number,
  exp: Schema.Number,
});
type SessionClaims = typeof SessionClaims.Type;

export const makeSessionCredentialService = Effect.gen(function* () {
  const secretStore = yield* ServerSecretStore;
  const signingSecret = yield* secretStore.getOrCreateRandom(SIGNING_SECRET_NAME, 32);

  const issue: SessionCredentialServiceShape["issue"] = Effect.fn("issue")(function* (input) {
    const issuedAt = yield* DateTime.now;
    const expiresAt = DateTime.add(issuedAt, {
      milliseconds: Duration.toMillis(input?.ttl ?? DEFAULT_SESSION_TTL),
    });
    const claims: SessionClaims = {
      v: 1,
      kind: "session",
      sub: input?.subject ?? "browser",
      method: input?.method ?? "browser-session-cookie",
      iat: issuedAt.epochMilliseconds,
      exp: expiresAt.epochMilliseconds,
    };
    const encodedPayload = base64UrlEncode(JSON.stringify(claims));
    const signature = signPayload(encodedPayload, signingSecret);

    return {
      token: `${encodedPayload}.${signature}`,
      method: claims.method,
      expiresAt: expiresAt,
    } satisfies IssuedSession;
  });

  const verify: SessionCredentialServiceShape["verify"] = Effect.fn("verify")(function* (token) {
    const [encodedPayload, signature] = token.split(".");
    if (!encodedPayload || !signature) {
      return yield* new SessionCredentialError({
        message: "Malformed session token.",
      });
    }

    const expectedSignature = signPayload(encodedPayload, signingSecret);
    if (!timingSafeEqualBase64Url(signature, expectedSignature)) {
      return yield* new SessionCredentialError({
        message: "Invalid session token signature.",
      });
    }

    const claims = yield* Effect.try({
      try: () =>
        Schema.decodeUnknownSync(SessionClaims)(JSON.parse(base64UrlDecodeUtf8(encodedPayload))),
      catch: (cause) =>
        new SessionCredentialError({
          message: "Invalid session token payload.",
          cause,
        }),
    });

    if (claims.exp <= Date.now()) {
      return yield* new SessionCredentialError({
        message: "Session token expired.",
      });
    }

    return {
      token,
      method: claims.method,
      expiresAt: DateTime.makeUnsafe(claims.exp),
      subject: claims.sub,
    } satisfies VerifiedSession;
  });

  return {
    cookieName: "t3_session",
    issue,
    verify,
  } satisfies SessionCredentialServiceShape;
});

export const SessionCredentialServiceLive = Layer.effect(
  SessionCredentialService,
  makeSessionCredentialService,
);
