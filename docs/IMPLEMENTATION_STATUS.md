# Implementation status

2026-09-20. First implementation increment on the existing TypeScript scaffold.

| Milestone | Status | Evidence / remaining work |
|---|---|---|
| M0 | partial | Existing repo read; official tool/bundle sources inspected. Runtime unavailable, no locked installed DSH. |
| M1 | partial | Bundle, native boundary, seven definitions and import/contract smoke. True DSH registration/dispatch/reload not run. |
| M2 | partial | Strict contracts, SQLite transactions/CAS/leases, copied workspaces, snapshots, process runner, events/artifacts, cooperative cancellation. No enforceable live sandbox or automatic recovery. |
| M3 | partial | Real Git/test fixture loop, structured review/triage/backlog/retries/patches/host acceptance. Explicit fake author/reviewer; no native Codex implementation/live test. |
| M4/M5 | deferred | No UI or feature workflow implemented. |

Do not mark v0.1/M0–M3 complete. The original handoff and acceptance requirements remain
unchanged; this PR does not lower them to match the implementation.

Architecture: contracts/domain -> adapters -> `Devkit` application service -> thin native
DSH definitions. No product launcher, external DB service, workflow GUI or model-funded
background job was added. Scripts only exercise fixtures and packaging.

Decisions: built-in SQLite requires Node 22.13+; independent clone avoids shared worktree
metadata; fixture is dependency-free JavaScript under a strict TypeScript plugin to separate
control-plane tests from compiler setup; trusted host supplies immutable test plans.

Next work, in order:
1. Install/pin DSH and test actual profile loading, registry dispatch, cancellation and reload.
2. Implement native Codex provider adapter plus verified process/files/network/credential
   boundaries. Keep live disabled until capability enforcement is demonstrated.
3. Wire a separately configured DeepSeek reviewer and run an explicitly authorized live fixture.
4. Add bounded project context, regression overlay/adjudication, authenticated approvals,
   crash reconciliation and resume. Never reclaim a lease based on age alone.
5. Finish the original acceptance matrix before UI/feature extensions.
