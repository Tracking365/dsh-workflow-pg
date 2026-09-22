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
```

Demo prints a temporary report/patch path and `realModelsUsed:false`. Read those artifacts;
`awaiting_human/final_acceptance` is not completed or deployed. Temporary directories are
kept for inspection. No model credentials are required and none are probed automatically.

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
evidence only. Native DevKit remains `executionMode: "disabled"`, so `dev_task_run` still
does not start Codex. Do not configure `dangerously-bypass-approvals-and-sandbox` or provide
credentials for this check.

Default data location is `~/.dsh-devkit`. To configure repository aliases, set the absolute
path `DSH_DEVKIT_CONFIG` in the host environment before starting DSH. The JSON file is a
host-owned file, not a task payload, and must not be writable by a code execution sandbox.

```json
{
  "dataRoot": "/absolute/path/outside/repos/devkit-data",
  "executionMode": "disabled",
  "repositories": {
    "demo": {
      "path": "/absolute/path/to/a/test-repo",
      "allowedPaths": ["src/"],
      "protectedPaths": ["test/"]
    }
  },
  "verificationProfiles": {
    "node-tap": [{
      "id": "regression",
      "command": "/absolute/path/to/node",
      "args": ["--test", "--test-reporter=tap", "test/page.test.mjs"],
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
Ask DSH to run doctor, create a bugfix task with alias demo/profile node-tap and acceptance
ID A1, then inspect status/report. `dev_task_run` returns a blocked task with
`LIVE_SANDBOX_NOT_IMPLEMENTED`. That is intentional. Do not use another shell tool to
bypass it, or set fixture mode in native DSH: native fixture mode is rejected.

The future Codex bridge will also fail closed with `CODEX_WORKSPACE_BINDING_UNAVAILABLE`
unless the parent DSH session's canonical working directory is exactly the isolated DevKit
candidate worktree. The installed provider has no public per-run cwd option, so a normal
session rooted at the source repository cannot be treated as a substitute.

No automatic resume currently exists. An interrupted task keeps its lease and artifacts;
an operator must prove the old execution has stopped and reconcile its effects before
future recovery support can safely retry. Never remove locks just to get a green run.
