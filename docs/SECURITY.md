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

The dormant DSH Codex bridge delegates only through the official `subagents` registry; it
does not invoke a Codex CLI or HTTP endpoint itself. Before it can call a provider, it requires
the parent session's canonical `cwd` to equal the isolated candidate worktree, because the
official provider owns its child cwd and has no public per-run cwd override. A mismatch returns
`CODEX_WORKSPACE_BINDING_UNAVAILABLE` without starting a child. After a published child, the
bridge waits for `dispose()` and retains the writer lease if teardown cannot be proved.

`git()` disables hooks for generated fixture repositories; it is not a production Git
adapter and does not implement organization signing/hooks policies. No host commit/push/
merge/deployment feature is exposed. Patches remain local and fixture evidence stays labeled.

`accept()` is a trusted in-process API, not a model tool. Its actor string is NOT an
authentication mechanism. Only trusted host code may invoke it; authenticated approval
capabilities, binding to operator identity and expiration remain unimplemented.

## Explicit gaps / do not relax these to make tests pass

* The official Codex provider can be registered and the DevKit bridge is fail-closed on an
  unbound workspace, but no real Codex session has been composed at the candidate worktree.
  There is no verified OS sandbox, network egress enforcement, credential broker or readonly
  tool-using reviewer; live runs remain blocked.
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
