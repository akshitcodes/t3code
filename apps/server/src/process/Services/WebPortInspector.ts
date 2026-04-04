import { ServiceMap } from "effect";
import type { Effect } from "effect";

import type { WebPortInspectionError } from "../Errors";

export const DEFAULT_WEB_PORT_PROBE_TTL_MS = 10_000;

export interface WebPortInspectorShape {
  readonly inspect: (port: number) => Effect.Effect<boolean, WebPortInspectionError>;
}

export class WebPortInspector extends ServiceMap.Service<WebPortInspector, WebPortInspectorShape>()(
  "t3/process/Services/WebPortInspector",
) {}
