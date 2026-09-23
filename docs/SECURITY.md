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

Optional frozen task context is also host-owned. `RepositoryPolicy.contextPaths` can name only
existing exact files or existing directories; a task can select at most eight individual relative
files from that allowlist. DevKit reads immutable Git blobs at the task's pinned base, rather than
the working tree, rejects non-blob paths, symlinks, non-UTF-8/NUL text, known-secret matches, files
over 4 KiB, and a total over 6 KiB. The private `dataRoot/contexts` directory is enforced 0700 and
each artifact 0600; task records and durable events contain only the manifest's paths, sizes and
hashes, never the text. Before dispatch, the fresh candidate must hash-match every frozen file.
The bounded Codex renderer redacts again. This is not a complete secret detector, semantic retriever,
or an OS security boundary.

Optional frozen regression overlays are distinct from task context. A task selects only up to eight
short `regressionOverlayRefs`; the host policy maps each ref to one external regular source file, a
new file target under `protectedPaths`, a fixed existing verification profile and one bounded literal
baseline-failure marker. DevKit rejects a source inside the repository or its control-plane data root,
direct symlinks/non-files, non-UTF-8/NUL/secret-looking content, duplicate targets, an existing target
at the pinned Git base, unprotected targets, and a profile mismatch. It freezes no more than 16 KiB per
source / 48 KiB total in `dataRoot/regression-overlays` (0700 directory, 0600 artifact); task records
and overlay-manifest events retain only ref/target/size/hash/marker-hash descriptors. Ordinary command
evidence can contain the deliberately non-secret marker. Before any writer dispatch, the
candidate receives the frozen bytes and each overlay's host-declared marker must occur in a failed
assertion result from the fixed verification plan. The candidate snapshot then treats the overlay as a
frozen protected test. Patch export rebuilds the Git index at the base and stages only `allowedPaths`,
so a writer-controlled index cannot smuggle this untracked test or another protected file into the
delivery artifact. Marker matching is a constrained host assertion, not independent evidence, a test
framework parser, or a semantic proof of arbitrary business behavior.

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

`CodexAppServerExecutor` is a separate direct stdio JSONL client for the documented App
Server protocol. It is deliberately not a stream interceptor for the DSH provider. It sends
one stable-only `initialize`/`initialized` handshake, requires an ephemeral candidate-bound
thread, and starts a turn with `approvalPolicy: "onRequest"`, one writable/readable candidate
root, and `networkAccess: false`. Command/file approvals are routed only when their task,
thread, turn, item, cwd and path bindings match the active run. Both item-start and terminal
notifications must identify that same thread/turn; bounded caches are a compatibility aid, not
an authority source. Network requests, cross-thread requests, missing file-change items,
out-of-scope paths and permission expansion are declined; MCP elicitation is declined and
generic user-input receives an empty answer map. The broker API can return only per-request
`accept` or `decline`, never `acceptForSession`. It is a host-only interface, not a model tool
and not an authentication system.

`CodexManagedAuthSession` reuses only the strict JSONL transport, but has a deliberately
incompatible host launch contract: it accepts neither workspace/cwd/task data nor an argv,
environment, API key, external token, thread, turn, tool, approval, or logout operation. Its
whole feature surface is stable `initialize`, `account/read`, managed-ChatGPT browser/device-code
`account/login/start`, and matching `account/login/cancel`. Account reads accept only a managed
`chatgpt` account or an unauthenticated OpenAI-required state; email, plan metadata, tokens and
server error text are not returned. Browser URLs and device codes are ephemeral in-memory values
for a future host-owned presentation, never task/artifact/event/log values. Unexpected server
requests—including external-token refresh—receive `-32601`; only a matching login-completed
notification can settle an attempt. The session bounds one active login, cancellation, timeout,
exit, and release proof. This is synthetic protocol coverage, not a credential broker: its concrete
private-home launch remains network-denied, has no browser/OAuth fixture, no narrowly scoped
outbound transport, and is not native-policy wired or callable by a task.

`LocalCodexApprovalBroker` is the host-side queue implementation for that interface. It creates
an opaque one-time ID, binds resolution to the task and fingerprint, rejects on abort/expiry/
shutdown or queue saturation, and records only a hash of the approval ID in a bounded audit
entry. `LocalApprovalControlPlane` is an optional loopback-only HTML presentation for the queue:
a trusted host supplies a 32+-character secret through a callback, the server retains only its
hash, and the browser gets an `HttpOnly`, `SameSite=Strict` short-lived session plus a CSRF
value. Sessions are bounded and pruned; the secret is never put in a URL, page, task record or
DSH tool result; cross-origin POSTs are rejected and model-provided fields are HTML escaped. A
disabled native policy may opt in through `codexApprovalControlPlane`; native reads only its
explicit `DSH_DEVKIT_*` environment reference at listener startup, reports the loopback URL, and
closes the listener/broker on plugin unload. This supplies an authenticated local presentation,
not a direct-client executor, credential broker, or proof that a live DSH writer is safe.

`MacosSeatbeltAppServerClientLaunch` composes that client with the existing Seatbelt boundary
using only the canonical `node <package-local-wrapper> app-server --stdio` shape and an empty
explicit environment. It has no ambient-login or secret fallback. The current Seatbelt profile
denies all network, so this path cannot reach a model; the client/launch tests use a synthetic
JSONL peer only. The documented future direction is a fresh private App Server home using its
own managed ChatGPT OAuth lifecycle, rather than reading or copying the user's existing Codex
tokens. `PrivateCodexStateRoot` now makes a canonical 0700 `$CODEX_HOME` leaf only under an
existing current-user-owned, non-group/world-writable parent and rejects any overlap with supplied
candidate/control roots. It has no
list/read/copy API. `MacosSeatbeltManagedAuthLaunch` uses it as `CODEX_HOME`, gives its App Server
an ephemeral `HOME`, has no candidate cwd parameter, accepts only the exact package-local wrapper,
and keeps the state root while deleting only the temporary HOME after exit/release proof. The actual
Seatbelt fixture verifies a fake wrapper can write its state root but cannot read candidate/control/
protected roots, enumerate host home, or reach loopback. This matches Codex's use of
[`$CODEX_HOME`](https://developers.openai.com/zh-Hans/docs/config-file/config-reference) for local
state without reading or copying the user's existing login. It deliberately denies all network, so
it cannot complete OAuth or reach a model. A narrowly scoped outbound-transport design that cannot
be borrowed by candidate commands, plus an explicit authorized OAuth fixture, still need to be
built and exercised. Until those controls are designed, reviewed and exercised, native live
execution remains disabled.

`sandbox-exec` remains a macOS host-test/legacy local boundary, not a production network-broker
mechanism: the local macOS manual marks it deprecated and its sandbox restrictions inherit into
descendants. `SealedPatchProposalExecutor` consequently does not relax that process's network
policy. Instead it makes a future independently enforced worker accept an in-memory source snapshot
with no absolute workspace/control/state/environment/context reference, and emit only a bounded,
same-snapshot, text-only patch within allowed non-protected paths. The host requires the worker's
own stop proof, rechecks source/scope and applies the patch noninteractively. A TypeScript worker
implementation is not isolation; the required external workload and deployment evidence are
specified in [`SEALED_WORKER_DESIGN.md`](SEALED_WORKER_DESIGN.md). No concrete worker, endpoint,
OAuth, credential, or live path is wired today.

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
queues a fresh clone. The interrupted clone is never deleted or reused. An explicitly configured
disabled native policy may supply `recoveryControlPlane`: its separate loopback page uses a
host-secret login, `HttpOnly` SameSite session, CSRF/origin checks, bounded expiry/audit queues,
and an explicit old-writer-stopped confirmation. It binds the decision to exact task/run/
fingerprint facts; no recovery capability is exposed as a model tool. Task history stores only a
hash of its approval artifact, never the raw artifact. This local-secret presentation is still
not multi-user identity or independent process attestation.

High-risk finding confirmation also stays host-only. The legacy `confirmFinding` callback is a
test seam; an explicitly configured disabled native policy may instead supply
`findingAdjudicationControlPlane`. Its separate loopback page receives only bounded, redacted
P0/P1 finding data and binds a local-secret decision to task/run/snapshot/finding facts. Confirm
requires an explicit repair checkbox and can only schedule the existing finite retry path; defer,
expiry, cancellation, or page closure do not reject the finding or accept delivery. Audit/task
events retain hashes rather than raw approval IDs. This is not independent evidence, multi-user
identity, or a live-review guarantee.

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
  separately killable execution VM. A direct JSONL client now has synthetic protocol coverage
  for strict per-request approvals, cancellation and exit-proof release. A separate synthetic
  managed-auth account client accepts only the documented ChatGPT browser/device-code lifecycle,
  rejects external token refresh, and requires exit/release proof. Its separately tested private
  state launch preserves only a 0700 `CODEX_HOME` and denies candidate data/network, but has no
  OAuth, browser, or outbound transport. A patch-only sealed-worker contract now protects the
  future data handoff but has no isolated deployment. Loopback approval,
  recovery, and high-risk finding-adjudication presentations are explicitly native-policy-wired
  with synthetic authentication, CSRF, startup-failure, and unload coverage, but no direct-client
  execution, credential broker, or actual-App-Server behavior evidence.
  The separate readonly reviewer has a lazy host configuration path but no live behavior
  evidence. There is no credential broker; live runs remain blocked.
* Recovery never infers quiescence from a PID, timeout or lease age. The durable restart and
  host-only fresh-clone path are fixture-tested. An explicit disabled native policy can start a
  local-secret recovery presentation that binds/limits/expires decisions and requires an operator
  assertion that the old writer stopped; it still has no multi-user identity or live process
  proof. Public `resume` remains unable to release a retained lease.
* No multi-user authorization boundary for shared DSH sessions. Use a private local profile.
* Reproduction uses a frozen, trusted Node TAP test plan. A narrow host-authorized regression-overlay
  path can require a literal marker from a failed assertion, but it is not a general-purpose expected-
  failure-signature language or proof of arbitrary business bugs.
* A host `confirmFinding` callback remains a compatibility test seam. The local finding-
  adjudication presentation binds and logs a human decision but does not create independent
  evidence, a multi-user authorization boundary, or live reviewer behavior.
* A small frozen task-context bundle is available, but it is explicit Git-base text only—not a
  complete semantic project-context retriever or large-repository search. Frozen regression overlays
  are separately bounded host artifacts, not a general test generator.
* Process cancellation is exercised by the fixture on macOS. Windows behavior and all live
  execution behavior remain unverified; fixture process groups are not an OS sandbox.

Shutdown aborts and awaits owned cooperative work. A non-cooperative adapter can still hang;
production needs an independently killable sandbox. Persistent artifacts are never deleted
as a side effect of plugin disposal. Reinstall/uninstall is not rollback.
