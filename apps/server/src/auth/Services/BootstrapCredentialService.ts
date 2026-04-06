import type { ServerAuthBootstrapMethod } from "@t3tools/contracts";
import { Data, DateTime, Duration, ServiceMap } from "effect";
import type { Effect } from "effect";

export interface BootstrapGrant {
  readonly method: ServerAuthBootstrapMethod;
  readonly expiresAt: DateTime.DateTime;
}

export class BootstrapCredentialError extends Data.TaggedError("BootstrapCredentialError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface BootstrapCredentialServiceShape {
  readonly issueOneTimeToken: (input?: {
    readonly ttl?: Duration.Duration;
  }) => Effect.Effect<string, never>;
  readonly consume: (credential: string) => Effect.Effect<BootstrapGrant, BootstrapCredentialError>;
}

export class BootstrapCredentialService extends ServiceMap.Service<
  BootstrapCredentialService,
  BootstrapCredentialServiceShape
>()("t3/auth/Services/BootstrapCredentialService") {}
