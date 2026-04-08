import type {
  ClaudeModelOptions,
  CodexModelOptions,
  CopilotModelOptions,
  ModelSelection,
  ProviderKind,
  ProviderModelOptions,
} from "@t3tools/contracts";

export const ORDERED_PROVIDER_KINDS = ["codex", "claudeAgent", "copilot"] as const satisfies
  ReadonlyArray<ProviderKind>;

export function buildModelSelection(
  provider: ProviderKind,
  model: string,
  options?: ProviderModelOptions[ProviderKind],
): ModelSelection {
  switch (provider) {
    case "codex":
      return {
        provider,
        model,
        ...(options ? { options: options as CodexModelOptions } : {}),
      };
    case "claudeAgent":
      return {
        provider,
        model,
        ...(options ? { options: options as ClaudeModelOptions } : {}),
      };
    case "copilot":
      return {
        provider,
        model,
        ...(options ? { options: options as CopilotModelOptions } : {}),
      };
  }
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
