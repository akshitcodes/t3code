import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

type PackageJsonLike = {
  readonly optionalDependencies?: Readonly<Record<string, string>>;
  readonly exports?: string;
  readonly bin?: Readonly<Record<string, string>>;
};

function resolveCopilotPlatformPackageName(): string | undefined {
  switch (`${process.platform}-${process.arch}`) {
    case "win32-x64":
      return "@github/copilot-win32-x64";
    case "win32-arm64":
      return "@github/copilot-win32-arm64";
    case "darwin-x64":
      return "@github/copilot-darwin-x64";
    case "darwin-arm64":
      return "@github/copilot-darwin-arm64";
    case "linux-x64":
      return "@github/copilot-linux-x64";
    case "linux-arm64":
      return "@github/copilot-linux-arm64";
    default:
      return undefined;
  }
}

function readJson(path: string): PackageJsonLike | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as PackageJsonLike;
  } catch {
    return undefined;
  }
}

function resolveExecutableRelativePath(packageJson: PackageJsonLike): string | undefined {
  if (typeof packageJson.exports === "string") {
    return packageJson.exports;
  }

  const firstBin = packageJson.bin ? Object.values(packageJson.bin)[0] : undefined;
  return typeof firstBin === "string" ? firstBin : undefined;
}

export function remapVirtualAsarPathToUnpacked(candidatePath: string): string {
  return candidatePath.replace(/([\\/])app\.asar([\\/])/i, "$1app.asar.unpacked$2");
}

function preferExistingExecutablePath(candidatePath: string): string | undefined {
  const unpackedPath = remapVirtualAsarPathToUnpacked(candidatePath);
  if (unpackedPath !== candidatePath && existsSync(unpackedPath)) {
    return unpackedPath;
  }

  return existsSync(candidatePath) ? candidatePath : undefined;
}

export function resolveCopilotExecutablePathFromPackageDir(packageDir: string): string | undefined {
  const packageJson = readJson(join(packageDir, "package.json"));
  const executableRelativePath = packageJson
    ? resolveExecutableRelativePath(packageJson)
    : undefined;
  if (!executableRelativePath) {
    return undefined;
  }

  return preferExistingExecutablePath(join(packageDir, executableRelativePath));
}

function findAncestorNamed(path: string, segmentName: string): string | undefined {
  let current = dirname(path);
  while (current !== dirname(current)) {
    if (current.endsWith(`\\${segmentName}`) || current.endsWith(`/${segmentName}`)) {
      return current;
    }
    current = dirname(current);
  }
  return undefined;
}

function findPackageRoot(startPath: string): string | undefined {
  let current = dirname(startPath);
  while (current !== dirname(current)) {
    if (existsSync(join(current, "package.json"))) {
      return current;
    }
    current = dirname(current);
  }
  return undefined;
}

function resolvePackagedPlatformCliPath(platformPackageName: string): string | undefined {
  const resourcesPath = Reflect.get(process, "resourcesPath");
  if (typeof resourcesPath !== "string" || resourcesPath.length === 0) {
    return undefined;
  }

  const packageDir = join(resourcesPath, "app.asar.unpacked", "node_modules", ...platformPackageName.split("/"));
  return resolveCopilotExecutablePathFromPackageDir(packageDir);
}

function resolveBundledPlatformCliPath(): string | undefined {
  const platformPackageName = resolveCopilotPlatformPackageName();
  if (!platformPackageName) {
    return undefined;
  }

  const packagedPlatformPath = resolvePackagedPlatformCliPath(platformPackageName);
  if (packagedPlatformPath) {
    return packagedPlatformPath;
  }

  const require = createRequire(import.meta.url);

  try {
    const directPlatformPath = require.resolve(platformPackageName);
    const executablePath = preferExistingExecutablePath(directPlatformPath);
    if (executablePath) {
      return executablePath;
    }
  } catch {
    // Fall back to Bun store/package traversal below.
  }

  let sdkEntryPath: string;
  try {
    sdkEntryPath = require.resolve("@github/copilot-sdk");
  } catch {
    return undefined;
  }

  const sdkPackageDir = findPackageRoot(sdkEntryPath);
  if (!sdkPackageDir) {
    return undefined;
  }
  const cliPackageDir = join(dirname(sdkPackageDir), "copilot");
  const cliPackageJson = readJson(join(cliPackageDir, "package.json"));
  const bunStoreDir = findAncestorNamed(sdkEntryPath, ".bun");
  const preferredVersion = cliPackageJson?.optionalDependencies?.[platformPackageName];

  const packageDirNamePrefix = platformPackageName.replace("/", "+");
  const candidateStoreDirs =
    bunStoreDir && existsSync(bunStoreDir)
      ? readdirSync(bunStoreDir)
          .filter((entry) =>
            preferredVersion
              ? entry === `${packageDirNamePrefix}@${preferredVersion}`
              : entry.startsWith(`${packageDirNamePrefix}@`),
          )
          .map((entry) => join(bunStoreDir, entry))
      : [];

  for (const storeDir of candidateStoreDirs) {
    const packageDir = join(storeDir, "node_modules", ...platformPackageName.split("/"));
    const executablePath = resolveCopilotExecutablePathFromPackageDir(packageDir);
    if (executablePath) {
      return executablePath;
    }
  }

  return undefined;
}

export function resolveCopilotCliPath(): string | undefined {
  return resolveBundledPlatformCliPath();
}
