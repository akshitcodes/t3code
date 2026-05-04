import { describe, expect, it } from "vitest";

import { buildMacManualUpdateScript, resolveMacAppBundlePath } from "./macManualUpdate.js";

describe("resolveMacAppBundlePath", () => {
  it("resolves the enclosing .app bundle from the executable path", () => {
    expect(
      resolveMacAppBundlePath("/Applications/T3 Code (Alpha).app/Contents/MacOS/T3 Code (Alpha)"),
    ).toBe("/Applications/T3 Code (Alpha).app");
  });

  it("returns null when the executable is not inside a .app bundle", () => {
    expect(resolveMacAppBundlePath("/usr/local/bin/t3code")).toBeNull();
  });
});

describe("buildMacManualUpdateScript", () => {
  it("builds a helper script that extracts, replaces, and relaunches the app", () => {
    const script = buildMacManualUpdateScript({
      scriptPath: "/tmp/install-update.sh",
      appPid: 1234,
      targetAppPath: "/Applications/T3 Code (Alpha).app",
      downloadedFile: "/Users/test/Library/Caches/t3code/update.zip",
      logFile: "/Users/test/.t3/userdata/logs/mac-manual-update.log",
      readyFile: "/tmp/install-update.ready",
    });

    expect(script).toContain("APP_PID=1234");
    expect(script).toContain("READY_FILE='/tmp/install-update.ready'");
    expect(script).toContain("mark_ready");
    expect(script).toContain('log "Waiting for app process $APP_PID to exit"');
    expect(script).toContain("/usr/bin/printf");
    expect(script).toContain('/usr/bin/ditto -x -k "$UPDATE_FILE" "$EXTRACT_DIR"');
    expect(script).toContain("/usr/bin/osascript");
    expect(script).toContain('/usr/bin/open -n "$TARGET_APP"');
  });
});
