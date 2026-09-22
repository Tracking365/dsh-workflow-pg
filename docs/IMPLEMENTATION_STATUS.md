# Implementation status

2026-09-22. First implementation increment on the existing TypeScript scaffold.

| Milestone | Status | Evidence / remaining work |
|---|---|---|
| M0 | partial | Exact `@deepseek-ai/dsh@0.1.6-alpha.2`, `@deepseek-ai/dsh-tools@0.1.6-alpha.2`, direct AgentLoop session-test core packages, optional `dsh-subagent`/`dsh-subagent-codex@0.1.6-alpha.2`, and compatible `@deepseek-ai/cordis@4.0.3` are locked, installed, and type/source checked. Disposable official profiles package, install and boot both the DevKit bundle and the official Codex provider bundle. |
| M1 | partial | Bundle, native boundary and seven definitions pass actual Cordis `ToolRuntime` registration, dispatch, schema rejection, unload and reload fixture tests. A double-opt-in `pagination-v1` profile also completes a deterministic native task lifecycle without a model. An offline `LlmAdapter` now drives the real DSH `AgentLoop`: it selects `devkit_doctor`, persists and replays its rendered result, and propagates user cancellation while retaining streamed text. The official headless launcher discovers the tarball and boots it twice; no live provider/model session is used. |
| M2 | partial | Strict contracts, SQLite transactions/CAS/leases, copied workspaces, snapshots, process runner, events/artifacts, cooperative cancellation. The native fixture uses an exact content/policy workspace guard before its first verification command. No enforceable live sandbox or automatic recovery. |
| M3 | partial | Real Git/test fixture loop, structured review/triage/backlog/retries/patches/host acceptance. `DshCandidateWorkspaceCodexExecutor` creates a short-lived real DSH parent Agent at the canonical candidate cwd, preserves the invoking Agent as its lifecycle/lineage parent, then delegates only through the official registry; the bound bridge redacts/bounds its task and proves teardown before release. Native fixtures cover both a registered fixture provider and the official provider's deliberately rejecting subprocess seam. There is no actual Codex process, credentialed provider, enforceable sandbox or live task. |
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
1. Under explicit authorization, verify the official Codex provider's real process,
   filesystem, network, credential and cancellation boundaries from the already-tested
   candidate-bound parent session. Keep live disabled until capability enforcement is
   demonstrated.
2. Wire a separately configured DeepSeek reviewer and run an explicitly authorized live fixture.
3. Add bounded project context, regression overlay/adjudication, authenticated approvals,
   crash reconciliation and resume. Never reclaim a lease based on age alone.
4. Finish the original acceptance matrix before UI/feature extensions.
