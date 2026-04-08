/**
 * CopilotAdapter - GitHub Copilot implementation of the generic provider adapter contract.
 *
 * Owns Copilot SDK session lifecycle and canonical runtime event projection.
 *
 * @module CopilotAdapter
 */
import { ServiceMap } from "effect";

import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

export interface CopilotAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {
  readonly provider: "copilot";
}

export class CopilotAdapter extends ServiceMap.Service<CopilotAdapter, CopilotAdapterShape>()(
  "t3/provider/Services/CopilotAdapter",
) {}
