# Implementation status

2026-09-23. First implementation increment on the existing TypeScript scaffold.

| Milestone | Status | Evidence / remaining work |
|---|---|---|
| M0 | partial | Exact `@deepseek-ai/dsh@0.1.6-alpha.2`, `@deepseek-ai/dsh-tools@0.1.6-alpha.2`, direct AgentLoop session-test core packages, optional `dsh-subagent`/`dsh-subagent-codex@0.1.6-alpha.2`, and compatible `@deepseek-ai/cordis@4.0.3` are locked, installed, and type/source checked. Disposable official profiles package, install and boot both the DevKit bundle and the official Codex provider bundle. |
| M1 | partial | Bundle, native boundary and seven definitions pass actual Cordis `ToolRuntime` registration, dispatch, schema rejection, unload and reload fixture tests. A double-opt-in `pagination-v1` profile also completes a deterministic native task lifecycle without a model. An offline `LlmAdapter` now drives the real DSH `AgentLoop`: it selects `devkit_doctor`, persists and replays its rendered result, and propagates user cancellation while retaining streamed text. The repeatable automated launcher/profile gates discover the tarball and boot it twice without a live provider/model session. |
| M2 | partial | Strict contracts, SQLite transactions/CAS/leases, copied workspaces, snapshots, process runner, events/artifacts, cooperative cancellation. The native fixture uses an exact content/policy workspace guard before its first verification command. A macOS Seatbelt command-confinement adapter performs a functional probe and, when available, limits writes to candidate/private temp roots, rejects configured protected-root reads and both TCP and Unix-socket connectivity; a host fixture proved those boundaries. `runCommand()` now accepts this host boundary and disposes its private temp after settlement. On restart, unfinished writers become `interrupted` and retain their lease; a host-only, fact-bound recovery authorization can preserve the old clone and queue a fresh clone from the frozen base after a second TOCTOU inspection. Native DSH supplies no authenticated recovery authority yet. |
| M3 | partial | Real Git/test fixture loop, structured review/triage/backlog/retries/patches/host acceptance. `DshCandidateWorkspaceCodexExecutor` creates a short-lived real DSH parent Agent at the canonical candidate cwd, preserves the invoking Agent as its lifecycle/lineage parent, then delegates only through the official registry; the bound bridge redacts/bounds its task and proves teardown before release. Native fixtures cover a registered fixture provider, the official provider’s rejecting subprocess seam, and its in-memory JSON-RPC cancellation lifecycle through interrupt, managed termination and candidate-parent release. A disabled-mode host policy can now mount the exact official provider in a DevKit-owned subprocess scope; its preflighted Seatbelt boundary accepts only the canonical package-local `node …/node_modules/@openai/codex/bin/codex.js app-server --stdio` launch, uses a fresh home, tombstones all ambient child environment names, blocks ambient home/current-user-temp/volume and known configuration roots, then restores only candidate/private roots, the current Node runtime and the exact package tree. It grants only exact ancestor metadata required for module resolution; configured protected roots remain final denials. A host fixture runs a fake package-shaped child through the actual wrapper and proves candidate-only writes, configured protected-read denial, host-home listing denial, TCP/Unix-socket denial, parent-environment exclusion and cleanup. This is still not a universal file-read allowlist or credential broker, does not connect a real model, and leaves live disabled. The native boundary refuses full-access, unreadable/unknown provider data, or nonempty explicit provider env; `approve-for-me` plus `env: {}` is merely protocol-eligible because the locked wire emits `sandbox: "workspace-write"`, while its unauthenticated approval handling and the missing credential broker keep native writer launch disabled. A host policy can configure a separate DeepSeek reviewer using endpoint/model/credential-variable metadata; the value stays deferred. One explicitly authorized non-CI fixture started the real official App Server once from a temporary Git candidate with `permissionMode: "never"` and `env: {}`; its observed subprocess cwd was the candidate and it wrote the exact scoped proof. Real-App-Server cancellation/reviewer behavior and a production credential broker remain unproven. |
| M4/M5 | deferred | No UI or feature workflow implemented. |

Direct App Server protocol increment (2026-09-23): `CodexAppServerExecutor` now owns a
strict stdio JSONL client instead of trying to rewrite the DSH provider's auto-decline stream.
It requires an ephemeral candidate-bound thread, binds `workspaceWrite` to the single candidate
root, uses restricted reads and command network-off, accepts only current task/thread/turn/item
approvals, checks both item-start and terminal-notification bindings, and never permits
session-wide or per-turn permission grants. Its bounded caches support the documented optional
command/cwd approval fields without trusting a cross-turn item notification.
`MacosSeatbeltAppServerClientLaunch` can compose that client with the existing exact-wrapper
Seatbelt boundary. `LocalCodexApprovalBroker` adds a bounded one-time pending queue that binds a
decision to task/fingerprint, expires or declines on cancellation, and retains only a bounded,
hashed audit record. `LocalApprovalControlPlane` presents that queue over authenticated loopback
HTTP with an `HttpOnly` SameSite session, CSRF checks and a bounded session set. A disabled
native host policy may now explicitly configure `codexApprovalControlPlane`; it reads the named
host secret only to start the loopback listener, exposes no approval capability to a task, and
closes the listener/broker on unload. It remains disconnected from the direct client and does not
enable live execution.
All of these pieces are covered only with synthetic peers and secrets: no current login,
endpoint, or model was accessed, and the native live path remains disabled.

Frozen-context increment (2026-09-23): a host can authorize exact files/directories through
`RepositoryPolicy.contextPaths`; task `contextRefs` then freeze up to eight UTF-8 Git-base blobs
(4 KiB each, 6 KiB total) into a private 0700/0600 manifest artifact. Task records/events retain
only descriptors and the candidate clone must hash-match them before the executor receives the
bounded, re-redacted prompt context. Fixture tests cover source advancement after task creation,
host-policy rejection, suspected secrets, native fixture rejection, and corrupt-artifact blocking.
This is not semantic retrieval and does not change the disabled live gate.

Do not mark v0.1/M0–M3 complete. The original handoff and acceptance requirements remain
unchanged; this PR does not lower them to match the implementation.

Architecture: contracts/domain -> adapters -> `Devkit` application service -> thin native
DSH definitions. No product launcher, external DB service, workflow GUI or model-funded
background job was added. Scripts only exercise fixtures and packaging.

Decisions: built-in SQLite requires Node 22.13+; independent clone avoids shared worktree
metadata; fixture is dependency-free JavaScript under a strict TypeScript plugin to separate
control-plane tests from compiler setup; trusted host supplies immutable test plans.

Next work, in order:
1. Implement and verify an isolated App-Server-managed ChatGPT OAuth lifecycle in a private home
   (never copy/read the existing login), plus a model transport that cannot be borrowed by
   candidate commands. Keep live disabled until both are independently proven.
2. Wire the direct client to native execution only after that transport boundary exists; then
   verify actual-App-Server cancellation and the configured DeepSeek reviewer in explicitly
   authorized disposable fixtures only.
3. Add regression overlay/adjudication and authenticated recovery control planes; evolve frozen
   context only with explicit bounds and evidence. Never reclaim a lease based on age alone.
4. Finish the original acceptance matrix before UI/feature extensions.
