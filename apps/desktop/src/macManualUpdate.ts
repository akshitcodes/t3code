import * as ChildProcess from "node:child_process";
import * as FS from "node:fs/promises";
import * as Path from "node:path";
import * as OS from "node:os";

export function resolveMacAppBundlePath(executablePath: string): string | null {
  const normalizedPath = executablePath.replaceAll("\\", "/");
  const match = /^(.*?\.app)(?:\/|$)/i.exec(normalizedPath);
  return match?.[1] ?? null;
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

export function buildMacManualUpdateScript(input: {
  scriptPath: string;
  appPid: number;
  targetAppPath: string;
  downloadedFile: string;
  logFile: string;
}): string {
  const scriptPath = shellSingleQuote(input.scriptPath);
  const targetAppPath = shellSingleQuote(input.targetAppPath);
  const downloadedFile = shellSingleQuote(input.downloadedFile);
  const logFile = shellSingleQuote(input.logFile);

  return `#!/bin/bash
set -euo pipefail

SCRIPT_PATH=${scriptPath}
APP_PID=${input.appPid}
TARGET_APP=${targetAppPath}
UPDATE_FILE=${downloadedFile}
LOG_FILE=${logFile}
TARGET_PARENT="$(/usr/bin/dirname "$TARGET_APP")"
TMP_ROOT="$(/usr/bin/mktemp -d "\${TMPDIR:-/tmp}/t3code-manual-update.XXXXXX")"
EXTRACT_DIR="$TMP_ROOT/extracted"

log() {
  /bin/mkdir -p "$(/usr/bin/dirname "$LOG_FILE")"
  /bin/printf '[%s] %s\\n' "$(/bin/date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" >> "$LOG_FILE"
}

cleanup() {
  if [[ -d "$TMP_ROOT" ]]; then
    /bin/rm -rf "$TMP_ROOT"
  fi
}

install_update() {
  trap cleanup EXIT
  /bin/mkdir -p "$EXTRACT_DIR"
  log "Extracting update archive $UPDATE_FILE"
  /usr/bin/ditto -x -k "$UPDATE_FILE" "$EXTRACT_DIR"

  local source_app
  source_app="$(
    /usr/bin/find "$EXTRACT_DIR" -maxdepth 2 -type d -name '*.app' -print -quit
  )"

  if [[ -z "$source_app" ]]; then
    log "Failed to locate .app bundle in extracted update"
    exit 1
  fi

  log "Replacing app bundle at $TARGET_APP"
  /bin/rm -rf "$TARGET_APP"
  /usr/bin/ditto "$source_app" "$TARGET_APP"
  /usr/bin/xattr -dr com.apple.quarantine "$TARGET_APP" >/dev/null 2>&1 || true
}

wait_for_app_exit() {
  local attempts=0
  while /bin/kill -0 "$APP_PID" >/dev/null 2>&1; do
    attempts=$((attempts + 1))
    if (( attempts > 180 )); then
      log "Timed out waiting for app process $APP_PID to exit"
      return 1
    fi
    /bin/sleep 1
  done
  return 0
}

run_install() {
  if [[ -w "$TARGET_PARENT" ]]; then
    install_update
    return 0
  fi

  log "Target parent $TARGET_PARENT requires administrator privileges"
  /usr/bin/osascript <<APPLESCRIPT
do shell script quoted form of POSIX path of "$SCRIPT_PATH" & " --install" with administrator privileges
APPLESCRIPT
}

if [[ "\${1:-}" == "--install" ]]; then
  install_update
  exit 0
fi

log "Manual Mac update helper started for $TARGET_APP"
wait_for_app_exit
run_install
log "Relaunching updated app bundle"
/usr/bin/open -n "$TARGET_APP"
`;
}

export async function scheduleMacManualUpdateInstall(input: {
  appPid: number;
  executablePath: string;
  downloadedFile: string;
  logFile: string;
}): Promise<void> {
  const targetAppPath = resolveMacAppBundlePath(input.executablePath);
  if (!targetAppPath) {
    throw new Error(`Could not resolve app bundle path from executable ${input.executablePath}.`);
  }

  if (Path.extname(input.downloadedFile).toLowerCase() !== ".zip") {
    throw new Error(`Expected a downloaded .zip update, got ${input.downloadedFile}.`);
  }

  const helperDir = await FS.mkdtemp(Path.join(OS.tmpdir(), "t3code-mac-update-"));
  const helperPath = Path.join(helperDir, "install-update.sh");
  const script = buildMacManualUpdateScript({
    scriptPath: helperPath,
    appPid: input.appPid,
    targetAppPath,
    downloadedFile: input.downloadedFile,
    logFile: input.logFile,
  });

  await FS.writeFile(helperPath, script, { encoding: "utf8", mode: 0o700 });
  await FS.chmod(helperPath, 0o700);

  const child = ChildProcess.spawn("/bin/bash", [helperPath], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}
