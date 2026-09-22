# DSH compatibility — ToolRuntime, launcher, and Codex provider registration fixtures verified

Checked 2026-09-22 against official source/documentation and the installed, exact npm packages.
The fixtures deliberately do not submit a model task or access a user credential.

Sources:

- `@deepseek-ai/dsh-tools@0.1.6-alpha.2`, installed at
  `node_modules/@deepseek-ai/dsh-tools/lib/types/index.d.ts`: `ToolDefinition` requires
  `output.schema`, `output.render(args,value)`, and `execute(args,exec)`; `ToolRuntime.register`
  and `ToolRuntime.execute` are the real registry/dispatch seam.
- `@deepseek-ai/cordis@4.0.3`, installed at
  `node_modules/@deepseek-ai/cordis/lib/types/context.d.ts`: `Context.plugin()` provides
  dependency-aware plugin lifecycle and `Context.provide()` exposes explicitly owned fixtures.
- `@deepseek-ai/dsh@0.1.6-alpha.2`, installed at
  `node_modules/@deepseek-ai/dsh/lib/bin.js`: launcher/profile composition and `dsh plugin`
  are exercised by the repeatable integration gate below.
- `@deepseek-ai/dsh-subagent@0.1.6-alpha.2`, installed at
  `node_modules/@deepseek-ai/dsh-subagent/lib/types/index.d.ts`: `SubagentRuntime.start()`
  returns the holder-owned run and `dispose()` is the teardown proof boundary.
- `@deepseek-ai/dsh-subagent-codex@0.1.6-alpha.2`, installed at
  `node_modules/@deepseek-ai/dsh-subagent-codex/lib/index.js`: its published provider name
  defaults to `codex`, has no optional start capabilities, and owns the package-local Codex
  App Server process. Its declared patch registers the provider only; registration does not
  start Codex.
- https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/tools/package.json
  identifies `@deepseek-ai/dsh-tools` **0.1.6-alpha.2** and its Cordis peer range.
- https://deepseek-harness.github.io/deepseek-harness/develop/basic/publish
  `dsh.bundle.patch`, insert rows and `dsh plugin --profile ... add ...tgz`.
- https://deepseek-harness.github.io/deepseek-harness/develop/framework/lifecycle
  Cordis plugin lifecycle; actual disposal behavior must be checked against the installed version.
- https://api-docs.deepseek.com/api/create-chat-completion
  Reference for the separate HTTP adapter; protocol behavior was tested with injected responses,
  not against a live endpoint.

`tests/native/tool-runtime.test.mjs` mounts an actual Cordis `Context` and the published
`ToolRuntime`. Its only explicit substitute is a narrow `systemPrompt.tools()` registration
sink required by ToolRuntime construction; it does not replace the registry or execution
pipeline. The fixture loads `native/index.mjs` through `Context.plugin()`, dispatches
`doctor`, `create`, `status`, invalid-input rejection, and the disabled `run` path through
`ToolRuntime.execute()`, then proves unload and reload do not retain duplicate tools.

The same test file also exercises the only explicit native no-model execution mode. Both the
trusted policy and native plugin config select `pagination-v1`; the adapter rejects anything
except the marked, content-locked pagination repository and its fixed TAP command. Through
the real `ToolRuntime` it completes `create → run → status → report`, records the workspace
guard and deterministic executor run ID, rejects automatic resume, and accepts a terminal
cancel request. It starts no model, Codex process, or arbitrary child command.

`tests/native/dsh-codex-executor.test.mjs` mounts the actual `SubagentRuntime`, registers a
fixture provider through its real registry, and verifies that `DshCodexExecutor` sends one
bounded/redacted text task, forwards the exact caller signal and parent Agent, requests none
of the Codex provider's unsupported capabilities, and awaits `dispose()` before claiming the
writer stopped. Missing providers, provider failures, teardown failures, and a parent session
whose canonical cwd differs from the candidate worktree all fail closed. The fixture provider
does not start Codex.

The second native ToolRuntime fixture mounts the actual published
`@deepseek-ai/dsh-subagent-codex` plugin with the real `SubagentRuntime` and a deliberately
throwing subprocess seam. It proves that the official provider registers as `codex` and that
`devkit_doctor` observes its published capability shape, while asserting zero subprocess
starts. This is host-plane registration evidence, not an App Server or model-session test.

`npm run test:codex-provider-profile` adds a profile-level counterpart. It packages the
already-installed exact provider, adds the tarball to a new headless `DSH_HOME`, confirms the
provider's `subagent-codex` patch row in `--dump-config`, then boots that profile twice with
`--help`. The command never calls `SubagentRuntime.start()`, so the provider has no reason to
launch its package-local Codex App Server. Its temporary npm cache avoids reading or repairing
the user's shared npm cache.

The workspace guard is necessary because the official provider starts a child in
`parent.session.header.cwd` and exposes no public per-run cwd option. DevKit therefore refuses
to delegate unless that canonical directory is exactly its isolated candidate worktree; a
prompt instruction cannot substitute for this boundary.

`npm run test:launcher` adds a second, intentionally slow gate. It creates a new temporary
`DSH_HOME`, initializes a headless profile, packages the current checkout, installs that
tarball with the official `dsh plugin` command, verifies the composed bundle row, and boots
the profile twice with `--help`. The gate sets a disabled DevKit policy and disables DSH
telemetry; it supplies no task text. The DevKit SQLite file created inside the temporary
policy data root is the affirmative signal that the bundle's `apply()` ran through the
launcher, rather than merely appearing in `--dump-config`.

`pnpm peers check` inside that isolated profile reports the two DevKit peers as absent from
the profile manifest. This is expected for DSH bundles: the launcher materializes an
installation-owned fallback closure that includes both package names, while pnpm only sees
the profile-local package. `@deepseek-ai/dsh-app-boot` implements that fallback in
`resolveModuleFallbackEntries()` and `healProfileModuleFallback()`; the successful boot
demonstrates the runtime path. Do not add a second profile-local Cordis copy merely to silence
that package-manager-only warning.

## Remaining compatibility gates

The published registry, provider registration, and launcher lifecycle are now covered, but a
real agent session has not selected or rendered a DevKit tool. No DSH parent session has been
composed at the isolated candidate cwd, and no official Codex App Server process, model request
or credential has been started. Caller cancellation through an actual provider process, tool
presentation/output formatting in the actual model loop, model-provider interaction, and an
enforceable filesystem/network/credential sandbox remain unverified. A01–A05 therefore remain
partial. The default native policy keeps `executionMode: "disabled"`; `pagination-v1` is only a
double-opt-in, content-locked regression fixture and does not alter the live gate.

## Toolchain decision

Node >=22.13 is required for built-in SQLite. TypeScript 5.7.2 and @types/node 22.10.2 remain
pinned; unused tsx/esbuild tooling was removed because tests run compiled JS. The lockfile now
pins DSH 0.1.6-alpha.2, the optional subagent/Codex provider peers at 0.1.6-alpha.2, and
Cordis 4.0.3; this removes the invalid root peer produced by Cordis 4.0.2. `npm run check`,
`npm test`, `npm run demo`, `npm run test:pack`, `npm run test:launcher`, and
`npm run test:codex-provider-profile` all passed on 2026-09-22. The launcher and
provider-registration gates verify package/profile composition and lifecycle, not a paid or
credentialed model interaction.
