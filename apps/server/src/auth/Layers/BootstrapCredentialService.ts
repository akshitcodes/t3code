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

type ConsumeResult =
  | {
      readonly _tag: "error";
      readonly error: BootstrapCredentialError;
    }
  | {
      readonly _tag: "success";
      readonly grant: BootstrapGrant;
    };

const DEFAULT_ONE_TIME_TOKEN_TTL_MINUTES = Duration.minutes(10);

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
      const now = yield* DateTime.now;
      const result: ConsumeResult = yield* Ref.modify(
        grantsRef,
        (current): readonly [ConsumeResult, Map<string, StoredBootstrapGrant>] => {
          const grant = current.get(credential);
          if (!grant) {
            return [
              {
                _tag: "error",
                error: new BootstrapCredentialError({
                  message: "Unknown bootstrap credential.",
                }),
              },
              current,
            ];
          }

          const next = new Map(current);
          if (DateTime.isGreaterThanOrEqualTo(now, grant.expiresAt)) {
            next.delete(credential);
            return [
              {
                _tag: "error",
                error: new BootstrapCredentialError({
                  message: "Bootstrap credential expired.",
                }),
              },
              next,
            ];
          }

          const remainingUses = grant.remainingUses;
          if (typeof remainingUses === "number") {
            if (remainingUses <= 1) {
              next.delete(credential);
            } else {
              next.set(credential, {
                ...grant,
                remainingUses: remainingUses - 1,
              });
            }
          }

          return [
            {
              _tag: "success",
              grant: {
                method: grant.method,
                expiresAt: grant.expiresAt,
              } satisfies BootstrapGrant,
            },
            next,
          ];
        },
      );

      if (result._tag === "error") {
        return yield* result.error;
      }

      return result.grant;
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
