import type {
  NativeApi,
  StateBootstrapResult,
  StateCatchUpInput,
  StateCatchUpResult,
  StateEvent,
} from "@t3tools/contracts";

export type StateSourceMode = "legacy-api" | "livestore-read-pilot";

export interface StateSource {
  mode: StateSourceMode;
  bootstrap(): Promise<StateBootstrapResult>;
  catchUp(input: StateCatchUpInput): Promise<StateCatchUpResult>;
  onEvent(listener: (event: StateEvent) => void): () => void;
}

export function resolveStateSourceMode(rawMode: string | undefined): StateSourceMode {
  if (rawMode === "livestore-read-pilot") {
    return "livestore-read-pilot";
  }
  return "legacy-api";
}

export function createStateSource(
  api: NativeApi,
  options: {
    mode?: StateSourceMode;
  } = {},
): StateSource {
  const mode = options.mode ?? "legacy-api";
  return {
    mode,
    bootstrap: () => api.state.bootstrap(),
    catchUp: (input) => api.state.catchUp(input),
    onEvent: (listener) => api.state.onEvent(listener),
  };
}
