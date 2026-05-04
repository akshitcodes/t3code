import type {
  ModelSelection,
  ProviderOptionSelection,
  ProviderKind,
  ProviderModelOptions,
} from "@t3tools/contracts";
import { ProviderDriverKind, defaultInstanceIdForDriver } from "@t3tools/contracts";
import { createModelSelection, trimOrNull } from "@t3tools/shared/model";

export const ORDERED_PROVIDER_KINDS = ["codex", "claudeAgent", "copilot"] as const satisfies
  ReadonlyArray<ProviderKind>;

export function buildModelSelection(
  provider: ProviderKind,
  model: string,
  options?: ProviderModelOptions[ProviderKind],
): ModelSelection {
  return createModelSelection(
    defaultInstanceIdForDriver(ProviderDriverKind.make(provider)),
    model,
    toProviderOptionSelections(options),
  );
}

export function getProviderSelectionOptions(
  provider: ProviderKind,
  modelOptions: ProviderModelOptions | null | undefined,
): ProviderModelOptions[ProviderKind] | undefined {
  switch (provider) {
    case "codex":
      return modelOptions?.codex;
    case "claudeAgent":
      return modelOptions?.claudeAgent;
    case "copilot":
      return modelOptions?.copilot;
  }
}

function toProviderOptionSelections(
  options: ProviderModelOptions[ProviderKind] | undefined,
): ReadonlyArray<ProviderOptionSelection> | undefined {
  if (!options) {
    return undefined;
  }

  const selections: ProviderOptionSelection[] = [];
  for (const [id, value] of Object.entries(options)) {
    if (typeof value === "boolean") {
      selections.push({ id, value });
      continue;
    }

    const trimmed = trimOrNull(value);
    if (trimmed) {
      selections.push({ id, value: trimmed });
    }
  }

  return selections.length > 0 ? selections : undefined;
}
