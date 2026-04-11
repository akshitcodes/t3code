# Provider Thread Sync

## Goal

Make T3 Code the canonical thread model while syncing as much native provider session state as is realistically possible.

That breaks down into two separate problems:

1. Same-provider sync
   T3 thread <-> native Codex session
   T3 thread <-> native Claude session
2. Cross-provider handoff
   T3 thread -> new Codex or Claude session seeded from T3 context

True native cross-provider shared threads are not realistic. Codex and Claude have different storage formats, resume semantics, and runtime event models.

## Current State

### Codex

- T3-created Codex threads already appear in Codex app UI.
- T3 persists its own thread state and also keeps provider resume state for Codex.
- This is the strongest existing native sync path today.

### Claude

- T3 can create and resume Claude sessions through the Claude SDK-backed adapter.
- Native Claude sessions are stored under `~/.claude/projects/<workspace>/<sessionId>.jsonl`.
- Before this change, T3 did not discover or import those native Claude sessions automatically.

## What Was Implemented

### Claude native session discovery

Added a parser/discovery layer that scans `~/.claude/projects` and summarizes top-level Claude session files:

- session id
- workspace root (`cwd`)
- title heuristic
- created/updated timestamps
- entrypoint
- slug
- git branch
- permission mode
- model

The parser intentionally ignores nested subagent files for now.

### Claude startup import into T3

On server startup, T3 now:

1. Scans native Claude sessions from `~/.claude/projects`
2. Reads persisted provider runtime bindings already known to T3
3. Dedupes by native Claude `sessionId`
4. Creates missing T3 projects for new Claude workspaces
5. Creates a T3 thread shell for each new Claude session
6. Persists a Claude provider runtime binding with the native session resume cursor

Result:

- Native Claude sessions can now show up in T3 as resumable thread shells.
- The imported threads are bound to the native Claude `sessionId`.
- Sending a new turn from T3 can recover and resume that native Claude session through the existing provider recovery path.

## Deliberate Limits In This Slice

This first implementation does **not** import the full historical transcript into T3 messages.

Reason:

- The current orchestration command model does not have a generic "import historical thread messages" command.
- Reusing live turn commands for historical user/assistant content would be unsafe and would trigger provider-side behavior.
- Writing directly around the event model would break the current architecture.

So the current approach imports:

- project/thread identity
- session binding
- resume metadata

But not:

- historical user messages
- historical assistant messages
- historical tool activity

## Why This Is Still Useful

Even without full transcript hydration, this gets T3 much closer to "all Claude sessions are usable in T3":

- native Claude sessions become visible in T3
- T3 can resume them through the native Claude session id
- T3 avoids duplicate imports across restarts

This is the right architectural first slice because it respects the existing event-sourced model.

## Plausible Next Steps

### 1. Add transcript import as a first-class orchestration capability

Add explicit import commands/events for:

- historical user message append
- historical assistant message append
- historical activity append

This is the cleanest path to showing past Claude conversation history inside T3.

### 2. Lazy transcript hydration

Alternative to eager import:

- import thread/session shell on startup
- hydrate transcript only when a Claude-imported thread is opened

This avoids heavy startup work and keeps the first screen fast if the native session store grows large.

### 3. Capture more Claude-native metadata

Potential future fields:

- plan/worktree state
- tool summaries
- attachment metadata
- per-turn mode changes

### 4. Codex parity work

Codex already has stronger native visibility. Next work there is mostly about making the mapping explicit and documenting the round-trip behavior.

## Risks / Open Questions

### Claude resume picker behavior

Claude stores native sessions locally, but not every SDK-created session is necessarily surfaced in Claude's own resume picker UI. T3 should not depend on the native picker behavior for correctness.

### Duplicate workspace roots with different casing

Windows path casing can differ between T3 and Claude session files. The importer normalizes workspace roots for lookup to reduce duplicate project creation.

### Large Claude session stores

If `~/.claude/projects` grows large, startup discovery may eventually need pagination, caching, or lazy loading.

## Status

- Codex native visibility from T3: working
- Claude T3-originated resume: working
- Claude native session discovery in T3: implemented
- Claude native session shell import into T3: implemented
- Claude historical transcript hydration into T3: not implemented yet
