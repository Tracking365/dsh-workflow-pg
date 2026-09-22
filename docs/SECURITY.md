# Security boundary

## Deployment status

This release is for trusted, local fixtures and control-plane evaluation only. Native DSH
execution is disabled. It must not be enabled for untrusted repositories or real business
work by renaming a live adapter to `fixture`.

An independent Git copy is workflow isolation, NOT OS isolation. Process groups are
best-effort cancellation, NOT a sandbox: a hostile process can escape its group, access
host files, use the network, or forge TAP output. Path/snapshot checks are post-hoc guards
and have filesystem race limits. Therefore real code execution deliberately fails closed.

The sole native exception is the `pagination-v1` non-production fixture. It requires two
separate trusted-host declarations, a marker file, exact known source/test contents, exactly
one repository alias and a fixed Node TAP command before its candidate clone can reach a
verification command. Its writer and reviewer are deterministic host code and start neither
a shell nor a model. This is a regression fixture, not a configurable local sandbox or an
authorization to point DevKit at another repository.

`tests/native/agent-session.test.mjs` also contains an offline, in-process `LlmAdapter` used
only by the test runner. It emits a finite, fixed stream to the real DSH AgentLoop so the
session can select and render `devkit_doctor` and exercise cancellation. It has no plugin row,
endpoint, credential lookup, subprocess or network implementation, and is not packaged as a
runtime provider. It is compatibility evidence only; it cannot authorize live execution.

On 2026-09-22, one separately authorized, non-CI run started the official Codex App Server
from a disposable temporary Git candidate. It used the current login state with
`permissionMode: "never"` and an empty explicit provider environment; no full-access mode,
repository remote, task credential, push, merge, or deployment was configured. The host
observed one subprocess with the exact candidate cwd, a clean provider/parent teardown, and
only the expected proof file. This is a narrow behavior observation, not a sandbox claim or
an authorization to enable native live execution.

## Implemented controls

Task inputs cannot set host policy, arbitrary commands, output paths, approval or readiness.
Repository/profile references resolve through trusted host policy. Task create pins a
committed baseline; dirty source files are not copied, reset or stashed. Test/allowed-path
hashes and verification/review evidence bind to the candidate snapshot. A model never
writes the SQLite store through an exposed tool. Store events and state changes commit
in one transaction; database files use 0600. Persistent leases have no automatic TTL
reclaim. A failed stop proof retains the lease and yields `interrupted`, not `cancelled`.

Shell interpolation is not used. Child processes get an environment allowlist, not model
keys or NODE_OPTIONS. Output and model context are bounded. The HTTP reviewer has no tools,
uses explicit HTTPS configuration and a separate credential callback, rejects redirects,
checks response shape/model identity, and rejects known credential patterns in context.
Regex redaction is best-effort, not a complete secret detector. Do not pass real secrets.

`MacosSeatbeltCommandConfinement` is an optional host-owned boundary for trusted command
plans. It first creates a disposable probe that must prove a candidate write succeeds while a
control write, a configured protected-root read, and loopback network access fail. Only after
that proof does it wrap a command in `sandbox-exec`: writes are limited to the candidate and a
private temporary directory, protected roots are unreadable, and all network access is denied.
It has no unconfined fallback and `runCommand()` disposes the private temporary root after the
managed child settles. This is real macOS Seatbelt evidence for that command path, not a claim
about every host or the Codex App Server. Protected-root denial is not a credential broker.

The dormant DSH Codex bridge delegates only through the official `subagents` registry; it
does not invoke a Codex CLI or HTTP endpoint itself. Its candidate-session composition layer
canonicalizes the already-created DevKit workspace, creates a short-lived DSH Agent at that
cwd, and records the invoking Agent as its lifecycle/lineage parent. The bound bridge then
requires the new parent session’s canonical `cwd` to equal the candidate worktree, because the
official provider owns its child cwd and has no public per-run cwd override. A mismatch returns
`CODEX_WORKSPACE_BINDING_UNAVAILABLE` without starting a child. After a published child, the
bridge waits for both the child run and candidate parent handle to dispose; an unproven teardown
retains the writer lease. Under the exact locked official provider, the native boundary also
reads its declared `permissionMode` and refuses to construct an executor for
`dangerously-bypass-approvals-and-sandbox` or an absent, unreadable, or unknown mode. This
configuration guard does not make `never` or `approve-for-me` an OS sandbox. The default disabled policy rejects a
task before this composition is invoked.

`git()` disables hooks for generated fixture repositories; it is not a production Git
adapter and does not implement organization signing/hooks policies. No host commit/push/
merge/deployment feature is exposed. Patches remain local and fixture evidence stays labeled.

`accept()` is a trusted in-process API, not a model tool. Its actor string is NOT an
authentication mechanism. Only trusted host code may invoke it; authenticated approval
capabilities, binding to operator identity and expiration remain unimplemented.

## Explicit gaps / do not relax these to make tests pass

* Native fixtures compose a real candidate-bound DSH parent and confirm that the official
  provider’s deliberately rejecting subprocess seam receives that canonical cwd. An in-memory
  JSON-RPC peer also proves the official provider sends an interrupt and waits for managed
  teardown after a published-turn cancellation. One separately authorized temporary run started
  an App Server and observed that cwd and a single exact scoped write. A separate host-level
  Seatbelt fixture proves a reusable command wrapper can deny configured reads, external writes
  and network. It does not yet wrap the App Server, supply an isolated model credential, or
  prove App Server cancellation. There is no credential broker or readonly tool-using reviewer;
  live runs remain blocked.
* No automatic crash recovery or PID/lease reclamation. `resume` raises
  `RECOVERY_REQUIRES_OPERATOR`; do not delete a lease while an old writer may still exist.
* No multi-user authorization boundary for shared DSH sessions. Use a private local profile.
* Reproduction uses a frozen, trusted Node TAP test plan. A general-purpose expected failure
  signature and newly proposed regression overlay are not implemented. A failed assertion
  alone is not sufficient for arbitrary business bugs outside this fixture.
* A host `confirmFinding` callback is the trusted evidence seam. The supplied tests use an
  explicit stub; independent production evidence adjudication remains to be built.
* Review context currently includes task, patch and test evidence, not a complete bounded
  project-context retriever. Large repositories are rejected, not silently truncated.
* Process cancellation is exercised by the fixture on macOS. Windows behavior and all live
  execution behavior remain unverified; fixture process groups are not an OS sandbox.

Shutdown aborts and awaits owned cooperative work. A non-cooperative adapter can still hang;
production needs an independently killable sandbox. Persistent artifacts are never deleted
as a side effect of plugin disposal. Reinstall/uninstall is not rollback.
