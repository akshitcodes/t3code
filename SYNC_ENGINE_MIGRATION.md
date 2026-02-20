# Sync Engine Migration Runbook

This runbook describes how to operate and verify the LiveStore migration path safely.

## Runtime modes

Server mode is controlled by `T3CODE_SYNC_ENGINE_MODE`:

- `legacy` (default): legacy persistence service is canonical for reads/writes.
- `shadow`: legacy remains canonical, and `state.event` writes are mirrored into LiveStore.
- `livestore-read-pilot`: write path remains legacy-backed, but state reads prefer LiveStore mirror with delegate fallback.

## Diagnostics flags

- `T3CODE_LIVESTORE_BOOTSTRAP_PARITY_CHECK=1`
  - In read-pilot mode, compares `state.bootstrap` mirror output against delegate output.
- `T3CODE_LIVESTORE_CATCHUP_PARITY_CHECK=1`
  - In read-pilot mode, compares `state.catchUp` mirror output against delegate output.
- `VITE_T3CODE_STATE_SOURCE_MODE=legacy-api|livestore-read-pilot`
  - Client-side state-source mode seam. Current implementation is protocol-compatible in both modes.

## Suggested rollout sequence

1. **Baseline**
   - Run in `legacy`.
   - Ensure no outstanding state-sync regressions in CI.
2. **Shadow validation window**
   - Enable `T3CODE_SYNC_ENGINE_MODE=shadow`.
   - Watch logs for mirror commit failures.
   - Validate parity fixtures and targeted tests.
3. **Read pilot**
   - Enable `T3CODE_SYNC_ENGINE_MODE=livestore-read-pilot`.
   - Start with parity flags enabled in staging.
   - Verify bootstrap/catch-up/list-message fallback behavior under induced mirror failures.
4. **Confidence window**
   - Keep parity flags enabled until drift warnings are consistently absent.
   - Track fallback frequency (should trend toward zero in healthy conditions).

## Phase-5 cleanup readiness checklist

Before removing legacy-only sync plumbing:

- [ ] Read-pilot mode has stable production/staging behavior for a full confidence window.
- [ ] Bootstrap and catch-up parity checks show no unexplained drift.
- [ ] Fallback-to-delegate behavior has been exercised and observed as safe.
- [ ] Web client state-source mode seam is present and default behavior remains backwards-compatible.
- [ ] Parity and integration tests cover:
  - [ ] project/thread/message lifecycle parity
  - [ ] checkpoint revert parity
  - [ ] websocket bootstrap/catch-up ordering in read-pilot
  - [ ] websocket read fallback under mirror failures

## Final cutover notes

When promoting LiveStore path to default:

- keep legacy fallback for at least one release window;
- remove fallback only after confirming operational metrics and parity diagnostics remain healthy;
- remove legacy-only state sync glue in a dedicated cleanup PR to keep risk isolated and reviewable.
