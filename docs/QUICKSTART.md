# Quickstart

## Run the implemented fixture

Node >=22.13 and Git are required. Fixture mode is an explicitly configured local test
harness, not an OS sandbox; the latest clean verification ran on macOS. Windows behavior
remains unverified.

```sh
npm ci
npm run check
npm test
npm run demo
npm run test:pack
npm run test:seatbelt-host
```

Demo prints a temporary report/patch path and `realModelsUsed:false`. Read those artifacts;
`awaiting_human/final_acceptance` is not completed or deployed. Temporary directories are
kept for inspection. No model credentials are required and none are probed automatically.

`test:seatbelt-host` is a macOS host-capability gate, not a model test. It requires a usable
`/usr/bin/sandbox-exec` and uses only disposable directories: candidate writes must work while
control writes, reads from a synthetic protected directory, host-home directory enumeration,
loopback TCP, and a local Unix socket are denied. It also runs a fake package-shaped App Server wrapper through the exact managed
launch boundary; it does not launch Codex or use account state. A constrained nested environment
can legitimately fail this gate; DevKit treats that as unsupported rather than falling back to an
unrestricted command. Its App Server boundary narrows major ambient host-data roots but is not a
complete macOS read allowlist; the production credential broker and an actual-App-Server
cancellation proof are still absent.

## Evaluate the DSH control plane (headless launcher gate verified)

Build and pack, then install the `.tgz` into an independent `devkit-eval` profile as shown
in README. The current checkout's `test:launcher` gate has performed this tarball install and
two headless `--help` boots in a disposable profile; it did not submit a task or start a model.
Do not install directly from Git without separately solving DSH's documented build-script
authorization; tarball installation avoids missing build output.

`npm run test:codex-provider-profile` repeats the corresponding host-plane check for the
official Codex provider itself: it packs the already-installed provider, adds it to a fresh
headless profile, validates its patch row, and boots that profile twice. It does not call
`subagents.start`, so it cannot start a Codex App Server.

If the only goal is to check the official provider's host registration, install the exact
Codex bundle separately and inspect `devkit_doctor`:

```sh
dsh plugin --profile devkit-eval add @deepseek-ai/dsh-subagent-codex@0.1.6-alpha.2
```

The provider may then appear as `codexSubagent.state: "supported"`; this is registration
evidence only. Its `writerSandbox` must be treated as `unverified` for `permissionMode: "never"`.
The locked provider only emits an explicit App Server `workspace-write` sandbox request for
`approve-for-me` with an empty explicit `env`; that is a necessary protocol prerequisite, not an
OS-boundary result. The locked provider lacks an authenticated App Server approval bridge and
DevKit lacks a credential broker, so `writerLaunchEligible` remains false. Native DevKit remains
`executionMode: "disabled"`, so `dev_task_run` still does not start Codex. Do not configure
`dangerously-bypass-approvals-and-sandbox` or provide credentials for this check.

## Test-only native deterministic lifecycle

The only native execution path that currently exists is the non-production
`pagination-v1` fixture exercised by `npm test`. It needs two separate host-owned opt-ins:
the policy must set both `executionMode: "fixture"` and `fixtureDriver: "pagination-v1"`,
and the DevKit plugin configuration must separately set `fixtureDriver: "pagination-v1"`.
The plugin then accepts exactly one repository alias (`fixture`), fixed `src/` and `test/`
scopes, a fixed Node TAP regression command, and a marker plus known fixture file contents.

This path uses deterministic host code for both writing and review. It does not start a model,
does not provide a general local shell runner, and must not be pointed at a business repository.
Any missing opt-in, changed fixture content, extra repository/profile, or different command is
rejected before a verification command can run.

Default data location is `~/.dsh-devkit`. To configure repository aliases, set the absolute
path `DSH_DEVKIT_CONFIG` in the host environment before starting DSH. The JSON file is a
host-owned file, not a task payload, and must not be writable by a code execution sandbox.

```json
{
  "dataRoot": "/absolute/path/outside/repos/devkit-data",
  "executionMode": "disabled",
  "reviewer": {
    "endpoint": "https://api.deepseek.com/chat/completions",
    "model": "your-independent-review-model",
    "credentialEnv": "DSH_DEVKIT_REVIEWER_API_KEY",
    "timeoutMs": 60000
  },
  "repositories": {
    "demo": {
      "path": "/absolute/path/to/a/test-repo",
      "allowedPaths": ["src/"],
      "protectedPaths": ["test/"],
      "contextPaths": ["docs/", "CONTRIBUTING.md"],
      "regressionOverlays": {
        "invalid-page-zero": {
          "source": "/absolute/path/outside/repos/host-regression-overlays/invalid-page-zero.test.mjs",
          "target": "test/invalid-page-zero.regression.test.mjs",
          "verificationProfile": "node-tap",
          "baselineFailureMarker": "INVALID_PAGE_ZERO_REGRESSION"
        }
      }
    }
  },
  "verificationProfiles": {
    "node-tap": [{
      "id": "regression",
      "command": "/absolute/path/to/node",
      "args": ["--test", "--test-reporter=tap", "test/page.test.mjs", "test/invalid-page-zero.regression.test.mjs"],
      "criteria": ["A1"],
      "timeoutMs": 10000
    }]
  },
  "maxRetries": 2,
  "maxDurationMs": 600000
}
```

This is the implementation's `HostPolicy` format. It is **not** a promise that the broader
handoff example config has been completely implemented; unknown keys are rejected.

The optional reviewer block stores only a fixed HTTPS endpoint, model and an environment-variable
reference; never put a token in the JSON file. The current disabled path does not read this
variable or make a request.

### Optional frozen task context

`contextPaths` is an optional host-owned allowlist. An entry ending in `/` is an existing
repository directory; any other entry is one existing repository file. A task may then supply
`contextRefs` containing up to eight individual relative files within that allowlist. It cannot
name a directory, escape the repository, use a symlink, or broaden the host policy.

At task creation DevKit reads each selected blob from the resolved Git base, not the dirty working
tree. It accepts UTF-8 files only, limits each file to 4 KiB and all selected text to 6 KiB, and
rejects NUL bytes and text matching its known-secret redaction patterns. The private data root
stores the raw text in `contexts/<manifest-hash>.json` (directory 0700, artifact 0600); the task
record and events retain only the base, file paths, sizes and hashes. Before an executor receives
the context, its fresh candidate clone must hash-match that frozen manifest.

This is a small, explicit reference bundle, not a semantic code search or a production credential
boundary. The native disabled policy still blocks execution; do not treat this configuration as an
authorization to run a model against a business repository.

### Optional frozen regression overlays

`regressionOverlays` is a separate host-owned map. A task can pass only
`regressionOverlayRefs`—up to eight short map keys—not a source path, target, command, test body,
or failure condition. Each map entry must use an existing regular UTF-8 source file outside both the
repository and `dataRoot`, a new individual target below `protectedPaths`, one existing verification
profile, and an exact non-secret `baselineFailureMarker`. The configured profile must actually run
the target file.

At creation DevKit copies and hashes the source (at most 16 KiB each and 48 KiB total) into
`regression-overlays/<manifest-hash>.json` under the private 0700/0600 data root. It rejects
symlink/fifo sources, NUL/non-UTF-8 bytes, suspected secrets, duplicate targets, source files inside
the repository/control plane, and targets that already exist at the pinned Git base. The task record
and the overlay-manifest event retain only ref/target/size/hash/marker-hash descriptors; ordinary
verification evidence can contain the required non-secret marker by design.

Before the baseline reproduction, the fresh candidate gets exactly those frozen bytes once. Every
overlay must produce its host-declared literal marker in a `failed_assertion` result; otherwise no
writer is dispatched. The overlay is then protected by the frozen-test hash for the whole run. It is
also deliberately omitted from the delivery patch: DevKit rebuilds the candidate Git index from the
base and stages only `allowedPaths`, so a writer cannot smuggle a protected or untracked test through
its index. The content and marker are still host assertions, not independent evidence or a general
semantic proof for an arbitrary business bug.

The content-locked `pagination-v1` native fixture rejects this option. The normal native policy
remains `executionMode: "disabled"`; configuring an overlay neither starts a model nor enables live
execution.

### Optional local approval presentation

This opt-in does **not** enable Codex, a model connection, or `dev_task_run`. It only starts the
authenticated loopback page used by a future direct App Server client. Choose a dedicated local
secret with at least 32 characters; do not reuse a model or business credential.

```sh
export DSH_DEVKIT_APPROVAL_SECRET='a-local-secret-of-at-least-32-characters'
```

Add this host-owned block beside `reviewer` when starting DSH:

```json
"codexApprovalControlPlane": {
  "mode": "loopback-v1",
  "credentialEnv": "DSH_DEVKIT_APPROVAL_SECRET",
  "operatorId": "local-operator",
  "port": 0
}
```

Only `127.0.0.1` is bound. With `port: 0`, `devkit_doctor` reports the allocated local URL; the
page requires the secret above, and plugin shutdown closes the listener and declines pending
requests. Missing, short, or invalid secrets fail plugin loading. The configured page remains
presentation-only until the separate direct-client execution and transport gates are completed.

Ask DSH to run doctor, create a bugfix task with alias demo/profile node-tap and acceptance
ID A1, then inspect status/report. `dev_task_run` returns a blocked task with
`LIVE_SANDBOX_NOT_IMPLEMENTED`. That is intentional. Do not use another shell tool to
bypass it. The test-only `pagination-v1` exception above is content-locked and cannot turn
this general disabled policy into a local execution facility.

The dormant Codex bridge composes a short-lived DSH parent session whose canonical working
directory is exactly the isolated DevKit candidate worktree, retaining the invoking session
only as its lifecycle/lineage parent. It still fails closed with
`CODEX_WORKSPACE_BINDING_UNAVAILABLE` when that candidate directory cannot be resolved. The
installed provider has no public per-run cwd option, so a normal session rooted at the source
repository cannot be treated as a substitute. The default disabled policy blocks before this
composition can start a provider.

On a restart, an unfinished task is marked `interrupted` and keeps its lease and artifacts.
The packaged DSH tools do not have authority to release it: public `resume` remains blocked.

### Optional interrupted-task recovery presentation

This is separate from the approval page above. It does not enable Codex, a model connection, or
`dev_task_run`, and it does not add a `dev_task_recover` tool. It is an explicit local operator
path for a retained interrupted lease only. Use a different dedicated local secret of at least
32 characters:

```sh
export DSH_DEVKIT_RECOVERY_SECRET='a-different-local-secret-of-at-least-32-characters'
```

Add this host-owned block beside `codexApprovalControlPlane` or `reviewer` in a disabled policy:

```json
"recoveryControlPlane": {
  "mode": "loopback-v1",
  "credentialEnv": "DSH_DEVKIT_RECOVERY_SECRET",
  "operatorId": "local-recovery-operator",
  "port": 0
}
```

The listener binds only `127.0.0.1`; with `port: 0`, `devkit_doctor` reports its allocated URL
under `nativeRuntime.recoveryControlPlane`. After local-secret login, enter the interrupted task
ID. The page displays only retained-run facts, requests a bound one-time authorization, and
requires a checkbox confirming that the old writer has stopped. It then rechecks the durable
facts, preserves the old candidate, and queues a fresh clone from the frozen base. It never
reuses the old workspace or removes a lease based on a PID, timeout, or age. Closing the plugin
closes the listener and declines unsettled requests; a missing, short, or invalid secret fails
plugin loading.

This is a private-local-host control, not a multi-user identity or process-attestation system.
Do not share its secret or use it to assert that an unverified writer stopped. Public `resume`
remains read-only and cannot release the lease.

### Optional high-risk finding adjudication presentation

This is a third, separate local presentation. It does not enable Codex, a model connection, or
`dev_task_run`, and it does not add `dev_task_adjudicate`. It can only process a pending P0/P1
review finding from an active host workflow. Use a different dedicated local secret of at least
32 characters:

```sh
export DSH_DEVKIT_ADJUDICATION_SECRET='a-third-local-secret-of-at-least-32-characters'
```

Add this host-owned block in a disabled policy:

```json
"findingAdjudicationControlPlane": {
  "mode": "loopback-v1",
  "credentialEnv": "DSH_DEVKIT_ADJUDICATION_SECRET",
  "operatorId": "local-adjudication-operator",
  "port": 0
}
```

The listener binds only `127.0.0.1`; with `port: 0`, `devkit_doctor` reports its URL under
`nativeRuntime.findingAdjudicationControlPlane`. The page shows a redacted, bounded finding
summary plus task/run/snapshot identifiers—not task prose. A confirmation needs an explicit
checkbox and is bound to that exact finding fingerprint and candidate snapshot. It only causes
the normal limited repair → validation → review loop to continue; it cannot mark the finding
rejected, release a recovery lease, or accept delivery. Choosing defer, expiry, or page closure
keeps the high-risk issue for human judgement rather than allowing a green result. In the current
disabled native profile no writer can create a pending finding; the page is pre-wired for the
future execution boundary and remains non-live.

This is also a private-local-host control, not independent evidence, multi-user authorization,
or a substitute for an actual reviewer. Do not share its secret or use it to override an
unverified high-risk finding.
