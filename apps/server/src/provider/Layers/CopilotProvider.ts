import {
  CopilotSettings,
  type ModelCapabilities,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { Effect, Equal, Layer, Option, Result, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { ServerSettingsService } from "../../serverSettings.ts";
import { resolveCopilotCliPath } from "../copilotCliPath.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  buildServerProvider,
  detailFromResult,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  type ServerProviderDraft,
  type ServerProviderPresentation,
  spawnAndCollect,
} from "../providerSnapshot.ts";
import { CopilotProvider } from "../Services/CopilotProvider.ts";
import { ServerSettingsError } from "@t3tools/contracts";

const PROVIDER = ProviderDriverKind.make("copilot");
const COPILOT_VERSION_TIMEOUT_MS = 20_000;
const COPILOT_PRESENTATION = {
  displayName: "GitHub Copilot",
} as const satisfies ServerProviderPresentation;
const DEFAULT_COPILOT_INSTANCE_ID = ProviderInstanceId.make("copilot");

const BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "gpt-5.4",
    name: "GPT-5.4",
    isCustom: false,
    capabilities: {
      reasoningEffortLevels: [
        { value: "xhigh", label: "Extra High" },
        { value: "high", label: "High", isDefault: true },
        { value: "medium", label: "Medium" },
        { value: "low", label: "Low" },
      ],
      supportsFastMode: false,
      supportsThinkingToggle: false,
      contextWindowOptions: [],
      promptInjectedEffortLevels: [],
    } satisfies ModelCapabilities,
  },
  {
    slug: "gpt-5.4-mini",
    name: "GPT-5.4 Mini",
    isCustom: false,
    capabilities: {
      reasoningEffortLevels: [
        { value: "xhigh", label: "Extra High" },
        { value: "high", label: "High", isDefault: true },
        { value: "medium", label: "Medium" },
        { value: "low", label: "Low" },
      ],
      supportsFastMode: false,
      supportsThinkingToggle: false,
      contextWindowOptions: [],
      promptInjectedEffortLevels: [],
    } satisfies ModelCapabilities,
  },
  {
    slug: "gpt-5.3-codex",
    name: "GPT-5.3 Codex",
    isCustom: false,
    capabilities: {
      reasoningEffortLevels: [
        { value: "xhigh", label: "Extra High" },
        { value: "high", label: "High", isDefault: true },
        { value: "medium", label: "Medium" },
        { value: "low", label: "Low" },
      ],
      supportsFastMode: false,
      supportsThinkingToggle: false,
      contextWindowOptions: [],
      promptInjectedEffortLevels: [],
    } satisfies ModelCapabilities,
  },
];

export const makePendingCopilotProvider = (settings: CopilotSettings): ServerProviderDraft => {
  const customModelCapabilities = BUILT_IN_MODELS[0]?.capabilities ?? {
    reasoningEffortLevels: [],
    supportsFastMode: false,
    supportsThinkingToggle: false,
    contextWindowOptions: [],
    promptInjectedEffortLevels: [],
  };
  return buildServerProvider({
    presentation: COPILOT_PRESENTATION,
    enabled: settings.enabled,
    checkedAt: new Date().toISOString(),
    models: providerModelsFromSettings(
      BUILT_IN_MODELS,
      PROVIDER,
      settings.customModels,
      customModelCapabilities,
    ),
    probe: {
      installed: false,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: "Checking GitHub Copilot CLI availability...",
    },
  });
};

function stampDefaultCopilotIdentity(snapshot: ServerProviderDraft): ServerProvider {
  return {
    ...snapshot,
    instanceId: DEFAULT_COPILOT_INSTANCE_ID,
    driver: PROVIDER,
  };
}

const runCopilotCommand = Effect.fn("runCopilotCommand")(function* (
  binaryPath: string,
  args: ReadonlyArray<string>,
) {
  const sanitizedEnv = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) => key !== "COPILOT_CLI_PATH" && typeof value === "string",
    ),
  );
  const command = ChildProcess.make(binaryPath, [...args], {
    env: sanitizedEnv,
    // A resolved `.exe` launches directly; PATH lookups still use the shell on Windows.
    shell: process.platform === "win32" && !binaryPath.toLowerCase().endsWith(".exe"),
  });
  return yield* spawnAndCollect(binaryPath, command);
});

function isUnsupportedVersionCommandOutput(output: string): boolean {
  const lowerOutput = output.toLowerCase();
  return (
    lowerOutput.includes("unknown command") ||
    lowerOutput.includes("unrecognized command") ||
    lowerOutput.includes("unexpected argument") ||
    lowerOutput.includes("too many arguments")
  );
}

const probeCopilotVersion = Effect.fn("probeCopilotVersion")(function* (binaryPath: string) {
  const primaryProbe = yield* runCopilotCommand(binaryPath, ["version"]).pipe(
    Effect.timeoutOption(COPILOT_VERSION_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isSuccess(primaryProbe) && Option.isSome(primaryProbe.success)) {
    const primaryResult = primaryProbe.success.value;
    if (
      primaryResult.code !== 0 &&
      isUnsupportedVersionCommandOutput(`${primaryResult.stdout}\n${primaryResult.stderr}`)
    ) {
      return yield* runCopilotCommand(binaryPath, ["--version"]).pipe(
        Effect.timeoutOption(COPILOT_VERSION_TIMEOUT_MS),
        Effect.result,
      );
    }
  }

  return primaryProbe;
});

export const checkCopilotProviderStatus = Effect.fn("checkCopilotProviderStatus")(function* (
  settings: CopilotSettings = Schema.decodeSync(CopilotSettings)({}),
  resolveBinaryPath: () => string | undefined = resolveCopilotCliPath,
): Effect.fn.Return<
  ServerProviderDraft,
  ServerSettingsError,
  ChildProcessSpawner.ChildProcessSpawner
> {
  const checkedAt = new Date().toISOString();
  const customModelCapabilities = BUILT_IN_MODELS[0]?.capabilities ?? {
    reasoningEffortLevels: [],
    supportsFastMode: false,
    supportsThinkingToggle: false,
    contextWindowOptions: [],
    promptInjectedEffortLevels: [],
  };
  const fallbackModels = providerModelsFromSettings(
    BUILT_IN_MODELS,
    PROVIDER,
    settings.customModels,
    customModelCapabilities,
  );

  if (!settings.enabled) {
    return buildServerProvider({
      presentation: COPILOT_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "GitHub Copilot is disabled in T3 Code settings.",
      },
    });
  }

  const binaryPath = resolveBinaryPath() ?? "copilot";
  const versionProbe = yield* probeCopilotVersion(binaryPath);

  if (Result.isFailure(versionProbe)) {
    const error = versionProbe.failure;
    return buildServerProvider({
      presentation: COPILOT_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "GitHub Copilot CLI could not be found."
          : `Failed to execute GitHub Copilot CLI health check: ${error instanceof Error ? error.message : String(error)}.`,
      },
    });
  }

  if (Option.isNone(versionProbe.success)) {
    return buildServerProvider({
      presentation: COPILOT_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message:
          "GitHub Copilot CLI is installed but failed to run. Timed out while running command.",
      },
    });
  }

  const versionResult = versionProbe.success.value;
  const parsedVersion = parseGenericCliVersion(`${versionResult.stdout}\n${versionResult.stderr}`);
  if (versionResult.code !== 0) {
    const detail = detailFromResult(versionResult);
    return buildServerProvider({
      presentation: COPILOT_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: parsedVersion,
        status: "error",
        auth: { status: "unknown" },
        message: detail
          ? `GitHub Copilot CLI is installed but failed to run. ${detail}`
          : "GitHub Copilot CLI is installed but failed to run.",
      },
    });
  }

  return buildServerProvider({
    presentation: COPILOT_PRESENTATION,
    enabled: true,
    checkedAt,
    models: fallbackModels,
    probe: {
      installed: true,
      version: parsedVersion,
      // Avoid bootstrapping the full SDK here; that path was crashing the packaged backend.
      status: "ready",
      auth: { status: "unknown" },
      message: "Installed and available. Authentication is verified when a Copilot session starts.",
    },
  });
});

export const CopilotProviderLive = Layer.effect(
  CopilotProvider,
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettingsService;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    return yield* makeManagedServerProvider<CopilotSettings>({
      getSettings: serverSettings.getSettings.pipe(
        Effect.map((settings) => settings.providers.copilot),
        Effect.orDie,
      ),
      streamSettings: serverSettings.streamChanges.pipe(
        Stream.map((settings) => settings.providers.copilot),
      ),
      haveSettingsChanged: (previous, next) => !Equal.equals(previous, next),
      initialSnapshot: (settings) => stampDefaultCopilotIdentity(makePendingCopilotProvider(settings)),
      checkProvider: serverSettings.getSettings.pipe(
        Effect.map((settings) => settings.providers.copilot),
        Effect.flatMap((settings) =>
          checkCopilotProviderStatus(settings).pipe(Effect.map(stampDefaultCopilotIdentity)),
        ),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      ),
    });
  }),
);
