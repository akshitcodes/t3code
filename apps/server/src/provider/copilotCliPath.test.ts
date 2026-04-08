import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, it, assert } from "@effect/vitest";

import {
  remapVirtualAsarPathToUnpacked,
  resolveCopilotExecutablePathFromPackageDir,
} from "./copilotCliPath";

describe("copilotCliPath", () => {
  it("remaps virtual asar executable paths to the unpacked app bundle", () => {
    const candidate =
      "C:\\Users\\akshit\\AppData\\Local\\Programs\\t3code\\resources\\app.asar\\node_modules\\@github\\copilot-win32-x64\\copilot.exe";

    assert.strictEqual(
      remapVirtualAsarPathToUnpacked(candidate),
      "C:\\Users\\akshit\\AppData\\Local\\Programs\\t3code\\resources\\app.asar.unpacked\\node_modules\\@github\\copilot-win32-x64\\copilot.exe",
    );
  });

  it("resolves executable paths from package exports", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "t3-copilot-cli-"));
    try {
      const packageDir = join(tempRoot, "node_modules", "@github", "copilot-win32-x64");
      mkdirSync(packageDir, { recursive: true });
      writeFileSync(
        join(packageDir, "package.json"),
        JSON.stringify({
          name: "@github/copilot-win32-x64",
          exports: "./copilot.exe",
        }),
      );
      writeFileSync(join(packageDir, "copilot.exe"), "stub");

      assert.strictEqual(
        resolveCopilotExecutablePathFromPackageDir(packageDir),
        join(packageDir, "copilot.exe"),
      );
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
