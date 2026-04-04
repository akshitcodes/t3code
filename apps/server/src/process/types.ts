import type { Effect } from "effect";

import type { TerminalProcessInspectionError, WebPortInspectionError } from "./Errors";

export type TerminalSubprocessChecker = (
  terminalPid: number,
) => Effect.Effect<boolean, TerminalProcessInspectionError>;

export type TerminalWebPortInspector = (
  port: number,
) => Effect.Effect<boolean, WebPortInspectionError>;

export interface TerminalSubprocessActivity {
  hasRunningSubprocess: boolean;
  runningPorts: number[];
}

export type TerminalSubprocessInspector = (
  terminalPid: number,
) => Effect.Effect<TerminalSubprocessActivity, TerminalProcessInspectionError>;
