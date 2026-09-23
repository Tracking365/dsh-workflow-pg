# Sealed patch-worker boundary

Status: foundation only (2026-09-23). No production worker, OAuth flow, browser, endpoint, credential, or live writer is enabled by this document or its accompanying TypeScript contract.

## Why this is a separate boundary

The local macOS `sandbox-exec(1)` manual marks that command deprecated, and `sandbox(7)` states that descendants inherit the parent sandbox while already-open file descriptors can remain usable. Consequently, adding outbound network access to the current App Server process cannot establish that its tool children cannot borrow private state, a credential channel, or a network capability.

This follows the general platform rule that agent-generated code can access the files, credentials, and network available to its environment; workloads that must not share data need separate isolation. [OpenAI's sandbox-security guidance](https://developers.openai.com/api/docs/guides/agents-api/environments/security) makes the same distinction and recommends isolated workloads plus narrowly scoped network access.

## Protocol now implemented

`SealedPatchProposalExecutor` defines a worker-neutral handoff with these fixed rules:

- The worker receives a by-value, UTF-8 source snapshot with relative paths and hashes. It never receives the candidate's absolute path, control-plane root, environment, credential, private `$CODEX_HOME`, or frozen host context.
- Source files whose content appears secret-like are rejected before dispatch. Task and verifier text is redacted and bounded.
- The worker can return only one bounded Git text patch that names the exact input snapshot. Rename, copy, binary, mode-only, quoted-path, traversal, protected-path, and out-of-scope patches are rejected.
- The host rechecks the source snapshot before applying the patch, applies it with noninteractive Git, then rechecks allowed/protected scope. The normal verification and review gates remain outside the worker.
- Every worker operation owns `stop()`. A normal completion is accepted only after it returns `true`; a cancellation, malformed operation, or startup failure without a stoppable operation retains the writer lease instead of claiming that remote work stopped.

The included workers are synthetic tests only. An in-process implementation of this interface would not satisfy the isolation claim.

## Production implementation requirements

Before this path can be connected to a live execution mode, one deliberately selected deployment must prove all of the following:

1. The worker runs in an independently enforced workload (for example a managed sandbox, VM, or separately administered runtime), not as a child of the local App Server process.
2. The worker receives only a disposable source snapshot and writes no local candidate path. It has no mount or inherited descriptor for the DevKit control plane, private Codex state, user home, or host credential store.
3. Network egress is disabled or restricted by that workload's own enforcement to the exact required destinations. Any credential substitution happens outside the worker and cannot become a generic proxy.
4. Authentication/state handling remains in a separately isolated control workload. It never reads or copies an existing local Codex login.
5. The deployment exposes an auditable stop/cleanup proof, endpoint policy, runtime identity/version, and a disposable end-to-end fixture before the native writer gate changes.

OpenAI-hosted and self-hosted sandbox options are possible future deployment choices; their network and credential model must be selected explicitly because it changes billing, account authority, and operational ownership. The [self-hosted sandbox guide](https://developers.openai.com/api/docs/guides/agents-api/environments/self-hosted) likewise requires environment isolation and an explicit outbound-host policy. DevKit does not choose or configure either option yet.

## Explicit non-goals

This protocol does not claim to secure a worker merely because it is passed a TypeScript interface. It does not use the current ChatGPT login, start the App Server, invoke a model, upload repository data, call an endpoint, or relax any existing Seatbelt network denial. It is an input/output contract for a future independently verified deployment.
