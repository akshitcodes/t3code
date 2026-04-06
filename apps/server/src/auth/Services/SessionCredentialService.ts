import type { ServerAuthSessionMethod } from "@t3tools/contracts";
import { Data, DateTime, Duration, ServiceMap } from "effect";
import type { Effect } from "effect";

export interface IssuedSession {
  readonly token: string;
  readonly method: ServerAuthSessionMethod;
  readonly expiresAt: DateTime.DateTime;
}

export interface VerifiedSession {
  readonly token: string;
  readonly method: ServerAuthSessionMethod;
  readonly expiresAt?: DateTime.DateTime;
  readonly subject: string;
}

export class SessionCredentialError extends Data.TaggedError("SessionCredentialError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface SessionCredentialServiceShape {
  readonly cookieName: string;
  readonly issue: (input?: {
    readonly ttl?: Duration.Duration;
    readonly subject?: string;
    readonly method?: ServerAuthSessionMethod;
  }) => Effect.Effect<IssuedSession, never>;
  readonly verify: (token: string) => Effect.Effect<VerifiedSession, SessionCredentialError>;
}

export class SessionCredentialService extends ServiceMap.Service<
  SessionCredentialService,
  SessionCredentialServiceShape
>()("t3/auth/Services/SessionCredentialService") {}
