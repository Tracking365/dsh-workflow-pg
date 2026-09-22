# Implementation status

2026-09-22. First implementation increment on the existing TypeScript scaffold.

| Milestone | Status | Evidence / remaining work |
|---|---|---|
| M0 | partial | Exact `@deepseek-ai/dsh@0.1.6-alpha.2`, `@deepseek-ai/dsh-tools@0.1.6-alpha.2`, direct AgentLoop session-test core packages, optional `dsh-subagent`/`dsh-subagent-codex@0.1.6-alpha.2`, and compatible `@deepseek-ai/cordis@4.0.3` are locked, installed, and type/source checked. Disposable official profiles package, install and boot both the DevKit bundle and the official Codex provider bundle. |
| M1 | partial | Bundle, native boundary and seven definitions pass actual Cordis `ToolRuntime` registration, dispatch, schema rejection, unload and reload fixture tests. A double-opt-in `pagination-v1` profile also completes a deterministic native task lifecycle without a model. An offline `LlmAdapter` now drives the real DSH `AgentLoop`: it selects `devkit_doctor`, persists and replays its rendered result, and propagates user cancellation while retaining streamed text. The repeatable automated launcher/profile gates discover the tarball and boot it twice without a live provider/model session. |
| M2 | partial | Strict contracts, SQLite transactions/CAS/leases, copied workspaces, snapshots, process runner, events/artifacts, cooperative cancellation. The native fixture uses an exact content/policy workspace guard before its first verification command. A macOS Seatbelt command-confinement adapter performs a functional probe and, when available, limits writes to candidate/private temp roots, rejects configured protected-root reads and both TCP and Unix-socket connectivity; a host fixture proved those boundaries. `runCommand()` now accepts this host boundary and disposes its private temp after settlement. On restart, unfinished writers become `interrupted` and retain their lease; a host-only, fact-bound recovery authorization can preserve the old clone and queue a fresh clone from the frozen base after a second TOCTOU inspection. Native DSH supplies no authenticated recovery authority yet. |
| M3 | partial | Real Git/test fixture loop, structured review/triage/backlog/retries/patches/host acceptance. `DshCandidateWorkspaceCodexExecutor` creates a short-lived real DSH parent Agent at the canonical candidate cwd, preserves the invoking Agent as its lifecycle/lineage parent, then delegates only through the official registry; the bound bridge redacts/bounds its task and proves teardown before release. Native fixtures cover a registered fixture provider, the official provider’s rejecting subprocess seam, and its in-memory JSON-RPC cancellation lifecycle through interrupt, managed termination and candidate-parent release. A disabled-mode host policy can now mount the exact official provider in a DevKit-owned subprocess scope; its preflighted Seatbelt boundary accepts only the canonical package-local `node …/node_modules/@openai/codex/bin/codex.js app-server --stdio` launch, uses a fresh home, tombstones all ambient child environment names, blocks ambient home/current-user-temp/volume and known configuration roots, then restores only candidate/private roots, the current Node runtime and the exact package tree. It grants only exact ancestor metadata required for module resolution; configured protected roots remain final denials. A host fixture runs a fake package-shaped child through the actual wrapper and proves candidate-only writes, configured protected-read denial, host-home listing denial, TCP/Unix-socket denial, parent-environment exclusion and cleanup. This is still not a universal file-read allowlist or credential broker, does not connect a real model, and leaves live disabled. The native boundary refuses full-access, unreadable/unknown provider data, or nonempty explicit provider env; `approve-for-me` plus `env: {}` is merely protocol-eligible because the locked wire emits `sandbox: "workspace-write"`, while its unauthenticated approval handling and the missing credential broker keep native writer launch disabled. A host policy can configure a separate DeepSeek reviewer using endpoint/model/credential-variable metadata; the value stays deferred. One explicitly authorized non-CI fixture started the real official App Server once from a temporary Git candidate with `permissionMode: "never"` and `env: {}`; its observed subprocess cwd was the candidate and it wrote the exact scoped proof. Real-App-Server cancellation/reviewer behavior and a production credential broker remain unproven. |
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
1. Bind the demonstrated Seatbelt command boundary and a separate credential broker to the
   App Server, then verify actual-App-Server cancellation from the already-tested
   candidate-bound parent session. Keep live disabled until those boundaries are proven.
2. Verify the configured DeepSeek reviewer and run an explicitly authorized live fixture only after the App Server boundary is in place.
3. Add bounded project context, regression overlay/adjudication, and authenticated approval/
   recovery control planes. Never reclaim a lease based on age alone.
4. Finish the original acceptance matrix before UI/feature extensions.
