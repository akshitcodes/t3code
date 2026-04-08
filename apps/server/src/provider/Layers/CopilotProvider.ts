import type {
  CopilotSettings,
  ModelCapabilities,
  ServerProvider,
  ServerProviderModel,
} from "@t3tools/contracts";
import { Effect, Equal, Layer, Option, Result, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { ServerSettingsService } from "../../serverSettings";
import { resolveCopilotCliPath } from "../copilotCliPath";
import { makeManagedServerProvider } from "../makeManagedServerProvider";
import {
  buildServerProvider,
  DEFAULT_TIMEOUT_MS,
  detailFromResult,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
} from "../providerSnapshot";
import { CopilotProvider } from "../Services/CopilotProvider";
import { ServerSettingsError } from "@t3tools/contracts";

const PROVIDER = "copilot" as const;

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

export const checkCopilotProviderStatus = Effect.fn("checkCopilotProviderStatus")(function* (
  resolveBinaryPath: () => string | undefined = resolveCopilotCliPath,
): Effect.fn.Return<
  ServerProvider,
  ServerSettingsError,
  ChildProcessSpawner.ChildProcessSpawner | ServerSettingsService
> {
  const serverSettings = yield* ServerSettingsService;
  const settings = yield* serverSettings.getSettings.pipe(
    Effect.map((allSettings) => allSettings.providers.copilot),
  );
  const checkedAt = new Date().toISOString();
  const fallbackModels = providerModelsFromSettings(BUILT_IN_MODELS, PROVIDER, settings.customModels);

  if (!settings.enabled) {
    return buildServerProvider({
      provider: PROVIDER,
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
  const versionProbe = yield* runCopilotCommand(binaryPath, ["--version"]).pipe(
    Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionProbe)) {
    const error = versionProbe.failure;
    return buildServerProvider({
      provider: PROVIDER,
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
      provider: PROVIDER,
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
      provider: PROVIDER,
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
    provider: PROVIDER,
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
    const checkProvider = checkCopilotProviderStatus().pipe(
      Effect.provideService(ServerSettingsService, serverSettings),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );

    return yield* makeManagedServerProvider<CopilotSettings>({
      getSettings: serverSettings.getSettings.pipe(
        Effect.map((settings) => settings.providers.copilot),
        Effect.orDie,
      ),
      streamSettings: serverSettings.streamChanges.pipe(
        Stream.map((settings) => settings.providers.copilot),
      ),
      haveSettingsChanged: (previous, next) => !Equal.equals(previous, next),
      checkProvider,
    });
  }),
);
