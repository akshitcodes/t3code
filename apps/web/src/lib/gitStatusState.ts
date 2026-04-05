import { useAtomValue } from "@effect/atom-react";
import { type GitManagerServiceError, type GitStatusResult, WS_METHODS } from "@t3tools/contracts";
import { Cause, Option } from "effect";
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useEffect, useState } from "react";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { WsRpcAtomClient } from "../rpc/client";

export type GitStatusStreamError =
  | GitManagerServiceError
  | RpcClientError
  | Cause.NoSuchElementError;

export interface GitStatusState {
  readonly data: GitStatusResult | null;
  readonly error: GitStatusStreamError | null;
  readonly cause: Cause.Cause<GitStatusStreamError> | null;
  readonly isPending: boolean;
}

const EMPTY_GIT_STATUS_STATE = Object.freeze<GitStatusState>({
  data: null,
  error: null,
  cause: null,
  isPending: false,
});

const emptyGitStatusStateAtom = Atom.make(EMPTY_GIT_STATUS_STATE).pipe(
  Atom.keepAlive,
  Atom.withLabel("git-status-empty"),
);

const gitStatusStreamAtom = Atom.family((cwd: string) =>
  WsRpcAtomClient.query(WS_METHODS.subscribeGitStatus, { cwd }).pipe(
    Atom.withLabel(`git-status-stream:${cwd}`),
  ),
);

const gitStatusStateAtom = Atom.family((cwd: string) =>
  Atom.make((get) => deriveGitStatusState(get(gitStatusStreamAtom(cwd)))).pipe(
    Atom.withLabel(`git-status-state:${cwd}`),
  ),
);

export function deriveGitStatusState(
  result: Atom.PullResult<GitStatusResult, GitStatusStreamError>,
): GitStatusState {
  if (AsyncResult.isSuccess(result)) {
    return {
      data: getLatestGitStatusResult(result.value),
      error: null,
      cause: null,
      isPending: result.waiting,
    };
  }

  if (AsyncResult.isFailure(result)) {
    const previousSuccess = Option.getOrNull(result.previousSuccess);
    return {
      data: previousSuccess ? getLatestGitStatusResult(previousSuccess.value) : null,
      error: Option.getOrNull(Cause.findErrorOption(result.cause)),
      cause: result.cause,
      isPending: result.waiting,
    };
  }

  return {
    ...EMPTY_GIT_STATUS_STATE,
    isPending: true,
  };
}

export function refreshGitStatus(cwd: string | null): void {
  if (cwd === null) {
    return;
  }

  appAtomRegistry.refresh(gitStatusStreamAtom(cwd));
}

export function useGitStatus(cwd: string | null): GitStatusState {
  return useAtomValue(cwd === null ? emptyGitStatusStateAtom : gitStatusStateAtom(cwd));
}

export function useGitStatuses(cwds: ReadonlyArray<string>): ReadonlyMap<string, GitStatusResult> {
  const [statusByCwd, setStatusByCwd] = useState<ReadonlyMap<string, GitStatusResult>>(
    () => new Map(),
  );

  useEffect(() => {
    const cwdSet = new Set(cwds);

    setStatusByCwd((current) => {
      let pruned = false;
      for (const key of current.keys()) {
        if (!cwdSet.has(key)) {
          pruned = true;
          break;
        }
      }
      if (!pruned) return current;
      const next = new Map<string, GitStatusResult>();
      for (const [key, value] of current) {
        if (cwdSet.has(key)) next.set(key, value);
      }
      return next;
    });

    const cleanups = cwds.map((cwd) =>
      appAtomRegistry.subscribe(
        gitStatusStateAtom(cwd),
        (state) => {
          setStatusByCwd((current) => {
            const next = new Map(current);
            if (state.data) {
              next.set(cwd, state.data);
            } else {
              next.delete(cwd);
            }
            return next;
          });
        },
        { immediate: true },
      ),
    );

    return () => {
      for (const cleanup of cleanups) {
        cleanup();
      }
    };
  }, [cwds]);

  return statusByCwd;
}

function getLatestGitStatusResult(value: {
  readonly items: ReadonlyArray<GitStatusResult>;
}): GitStatusResult | null {
  return value.items.at(-1) ?? null;
}
