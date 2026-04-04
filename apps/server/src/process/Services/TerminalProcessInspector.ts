import { ServiceMap } from "effect";
import type { Effect } from "effect";

import type { TerminalProcessInspectionError } from "../Errors";
import type { TerminalSubprocessActivity } from "../types";

export interface TerminalProcessInspectorShape {
  readonly inspect: (
    terminalPid: number,
  ) => Effect.Effect<TerminalSubprocessActivity, TerminalProcessInspectionError>;
}

export class TerminalProcessInspector extends ServiceMap.Service<
  TerminalProcessInspector,
  TerminalProcessInspectorShape
>()("t3/process/Services/TerminalProcessInspector") {}
