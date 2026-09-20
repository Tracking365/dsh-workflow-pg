# Quickstart

## Run the implemented fixture

Node >=22.13 and Git are required; current fixture guard permits Linux only.

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

## Evaluate the DSH control plane (not locally verified)

Build and pack, then install the `.tgz` into an independent `devkit-eval` profile as shown
in README. Do not install directly from Git without separately solving DSH's documented
build-script authorization; tarball installation avoids missing build output.

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

No automatic resume currently exists. An interrupted task keeps its lease and artifacts;
an operator must prove the old execution has stopped and reconcile its effects before
future recovery support can safely retry. Never remove locks just to get a green run.
