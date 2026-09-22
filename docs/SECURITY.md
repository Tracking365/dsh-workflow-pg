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
On store reopen, prior `running`/`cancelling` tasks are atomically marked `interrupted` while
their lease remains held.

Shell interpolation is not used. Child processes get an environment allowlist, not model
keys or NODE_OPTIONS. Output and model context are bounded. The HTTP reviewer has no tools,
uses explicit HTTPS configuration and a separate credential callback, rejects redirects,
checks response shape/model identity, and rejects known credential patterns in context.
Regex redaction is best-effort, not a complete secret detector. Do not pass real secrets.

`MacosSeatbeltCommandConfinement` is an optional host-owned boundary for trusted command
plans. It first creates a disposable probe that must prove a candidate write succeeds while a
control write, a configured protected-root read, loopback TCP, and a local Unix-socket connection
fail. Only after that proof does it wrap a command in `sandbox-exec`: writes are limited to the
candidate and a private temporary directory, protected roots are unreadable, and all network
access is denied. It has no unconfined fallback and `runCommand()` disposes the private temporary
root after the managed child settles.

`MacosSeatbeltAppServerConfinement` applies the same functional probe to a separately scoped,
DevKit-owned official provider. It permits exactly one prepared, canonical package-local
`node …/node_modules/@openai/codex/bin/codex.js app-server --stdio` launch per candidate,
supplies a fresh private home and temporary roots, tombstones every inherited DSH
child-environment name, then restores only a fixed system path, locale and non-interactive Git
settings. That prevents ambient Node loader, dynamic-linker, shell-startup, proxy and host-config
variables from re-entering the child.

Its App Server profile additionally denies reads from the invoking home, current-user temporary
area, shared temporary roots, mounted volumes and existing host configuration/cache roots before
restoring only the candidate, private boundary state, current Node runtime directory and the
canonical installed package tree. Node needs ancestor `lstat` calls to load an absolute module, so
the profile grants metadata—not directory data—on only those exact ancestors. Explicit configured
protected roots are emitted as final denials and cannot be reallowed. The host fixture proves a
fake package-shaped wrapper can write only the candidate, cannot read the synthetic protected root
or enumerate the host home, and cannot reach TCP or Unix sockets. It does not launch an actual
Codex binary, access a login, or prove the inner App Server sandbox. This is a narrowed ambient
data boundary, not a universal macOS read allowlist; system and other non-enumerated roots may
still be readable. The profile deliberately denies all network, so it cannot provide model
connectivity. Protected-root denial is not a credential broker.

The dormant DSH Codex bridge delegates only through the official `subagents` registry; it
does not invoke a Codex CLI or HTTP endpoint itself. Its candidate-session composition layer
canonicalizes the already-created DevKit workspace, creates a short-lived DSH Agent at that
cwd, and records the invoking Agent as its lifecycle/lineage parent. The bound bridge then
requires the new parent session’s canonical `cwd` to equal the candidate worktree, because the
official provider owns its child cwd and has no public per-run cwd override. A mismatch returns
`CODEX_WORKSPACE_BINDING_UNAVAILABLE` without starting a child. After a published child, the
bridge waits for both the child run and candidate parent handle to dispose; an unproven teardown
retains the writer lease. Under the exact locked official provider, the native boundary also
reads its declared `permissionMode`, explicit provider environment and metadata. It refuses a
full-access, unknown/unreadable, or nonempty-env provider. `approve-for-me` with `env: {}` is
reported only as a provider protocol prerequisite because the tested wire sends
`sandbox: "workspace-write"`; `never` remains observable but is not writer-eligible. The locked
wire explicitly lacks an authenticated interactive-approval bridge, and the boundary lacks a
credential broker, so native writer launch remains false even when both the provider and boundary
are mounted. This configuration guard does not make either provider mode an OS sandbox. The
default disabled policy rejects a task before this composition is invoked.

A host policy may configure the separate DeepSeek reviewer with an HTTPS completions endpoint,
fixed model and a `DSH_DEVKIT_*` credential environment-variable name. The secret itself is not
accepted in JSON, is read only at an eventual review call, and is never handed to the Codex
provider's explicit environment. This is a configuration boundary only: no live review has run.

`git()` disables hooks for generated fixture repositories; it is not a production Git
adapter and does not implement organization signing/hooks policies. No host commit/push/
merge/deployment feature is exposed. Patches remain local and fixture evidence stays labeled.

`accept()` and `recover()` are trusted in-process APIs, not model tools. `recover()` requires a
host `RecoveryAuthority` to bind an approval to the task, retained run lease and a recovery
facts fingerprint, prove the old writer stopped, and survive a second inspection before it
queues a fresh clone. The interrupted clone is never deleted or reused. The shipped native DSH
plugin does not configure that authority; task history stores only a hash of its approval audit
artifact, never the raw artifact. Its callback seam is not itself an authentication
mechanism; authenticated identity, expiry and approval presentation remain unimplemented.

## Explicit gaps / do not relax these to make tests pass

* Native fixtures compose a real candidate-bound DSH parent and confirm that the official
  provider’s deliberately rejecting subprocess seam receives that canonical cwd. An in-memory
  JSON-RPC peer also proves the official provider sends an interrupt and waits for managed
  teardown after a published-turn cancellation. One separately authorized temporary run started
  an App Server and observed that cwd and a single exact scoped write. A separate host-level
  Seatbelt fixture proves both the trusted-command wrapper and the exact App-Server-shaped launch
  wrapper can deny configured reads, external writes, TCP, and Unix sockets. The latter uses a
  fake wrapper only; it does not supply an isolated model credential or prove actual-App-Server
  cancellation. The App Server profile blocks the main ambient home/config/cache locations and
  has a host test for non-enumerability, but it is not yet a complete file-read whitelist or a
  separately killable execution VM. The separate readonly reviewer has a lazy host configuration
  path but no live behavior evidence. There is no credential broker; live runs remain blocked.
* Recovery never infers quiescence from a PID, timeout or lease age. The durable restart and
  host-only fresh-clone path are fixture-tested, but the shipped native DSH profile has no
  authenticated `RecoveryAuthority`; public `resume` therefore still raises
  `RECOVERY_REQUIRES_OPERATOR` and cannot release a retained lease.
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
