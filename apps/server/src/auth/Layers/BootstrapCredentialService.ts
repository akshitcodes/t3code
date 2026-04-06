import { Effect, Layer, Ref, DateTime, Duration } from "effect";

import { ServerConfig } from "../../config.ts";
import {
  BootstrapCredentialError,
  BootstrapCredentialService,
  type BootstrapCredentialServiceShape,
  type BootstrapGrant,
} from "../Services/BootstrapCredentialService.ts";

interface StoredBootstrapGrant extends BootstrapGrant {
  readonly remainingUses: number | "unbounded";
}

const DEFAULT_ONE_TIME_TOKEN_TTL_MINUTES = Duration.minutes(5);

export const makeBootstrapCredentialService = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const grantsRef = yield* Ref.make(new Map<string, StoredBootstrapGrant>());

  const seedGrant = (credential: string, grant: StoredBootstrapGrant) =>
    Ref.update(grantsRef, (current) => {
      const next = new Map(current);
      next.set(credential, grant);
      return next;
    });

  if (config.desktopBootstrapToken) {
    const now = yield* DateTime.now;
    yield* seedGrant(config.desktopBootstrapToken, {
      method: "desktop-bootstrap",
      expiresAt: DateTime.add(now, {
        milliseconds: Duration.toMillis(DEFAULT_ONE_TIME_TOKEN_TTL_MINUTES),
      }),
      remainingUses: 1,
    });
  }

  const issueOneTimeToken: BootstrapCredentialServiceShape["issueOneTimeToken"] = (input) =>
    Effect.gen(function* () {
      const credential = crypto.randomUUID();
      const ttl = input?.ttl ?? DEFAULT_ONE_TIME_TOKEN_TTL_MINUTES;
      const now = yield* DateTime.now;
      yield* seedGrant(credential, {
        method: "one-time-token",
        expiresAt: DateTime.add(now, { milliseconds: Duration.toMillis(ttl) }),
        remainingUses: 1,
      });
      return credential;
    });

  const consume: BootstrapCredentialServiceShape["consume"] = (credential) =>
    Effect.gen(function* () {
      const current = yield* Ref.get(grantsRef);
      const grant = current.get(credential);
      if (!grant) {
        return yield* new BootstrapCredentialError({
          message: "Unknown bootstrap credential.",
        });
      }

      if (DateTime.isGreaterThanOrEqualTo(yield* DateTime.now, grant.expiresAt)) {
        yield* Ref.update(grantsRef, (state) => {
          const next = new Map(state);
          next.delete(credential);
          return next;
        });
        return yield* new BootstrapCredentialError({
          message: "Bootstrap credential expired.",
        });
      }

      const remainingUses = grant.remainingUses;
      if (typeof remainingUses === "number") {
        yield* Ref.update(grantsRef, (state) => {
          const next = new Map(state);
          if (remainingUses <= 1) {
            next.delete(credential);
          } else {
            next.set(credential, {
              ...grant,
              remainingUses: remainingUses - 1,
            });
          }
          return next;
        });
      }

      return {
        method: grant.method,
        expiresAt: grant.expiresAt,
      } satisfies BootstrapGrant;
    });

  return {
    issueOneTimeToken,
    consume,
  } satisfies BootstrapCredentialServiceShape;
});

export const BootstrapCredentialServiceLive = Layer.effect(
  BootstrapCredentialService,
  makeBootstrapCredentialService,
);
