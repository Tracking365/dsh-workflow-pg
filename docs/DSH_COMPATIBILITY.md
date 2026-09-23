# DSH compatibility — ToolRuntime, offline AgentLoop, candidate session, launcher, and one authorized Codex fixture

Checked 2026-09-22 against official source/documentation and the installed, exact npm packages.
The repeatable fixtures deliberately do not access a user credential or remote model. One
test-only, in-process adapter supplies fixed stream chunks to the real DSH AgentLoop. A
separate user-authorized, non-CI temporary fixture used the current Codex login once; its
narrow evidence and limits are recorded below.

On 2026-09-23, the direct App Server client was also checked against the official App Server
protocol documentation. The stable local transport is newline-delimited JSON-RPC over stdio;
the server can initiate command, file-change and permission approval requests, which a product
client must answer with a decision bound to its active thread and turn. DevKit implements that
client contract and a synthetic loopback human-approval presentation against local peers, rather
than modifying the DSH provider's auto-decline stream. The official guidance says to use the Codex SDK for job/CI automation; DevKit is not
claiming that its local interactive protocol adapter is a deployed production automation path.
The WebSocket and remote Code Mode transport caveats do not apply to this stdio fixture, but are
not a license to expose a listener or bypass the local credential/approval boundary.
The same protocol documents an App-Server-managed ChatGPT OAuth flow, including device/browser
login and token refresh owned by the App Server. `CodexManagedAuthSession` now has synthetic
coverage for only that account protocol: browser/device-code start, matching completion/cancel,
sanitized account read and rejection of external-token refresh. Its launch contract accepts no
candidate workspace/cwd or credentials. A separate real Seatbelt fake-wrapper fixture now proves
the launch can hold a private 0700 `$CODEX_HOME` while allowing only an authenticated, per-session
CONNECT proxy to `auth.openai.com`; direct external and unrelated loopback paths remain denied.
This is persistent-state and egress-boundary evidence, not OAuth connectivity or proof that a real
App Server honors the proxy variables. Any real flow is limited to a fresh private home; it will
not read, copy or proxy the user's existing Codex login state.

The new `SealedPatchProposalExecutor` is deliberately outside the current DSH provider wiring: it
is a future independently isolated worker handoff, not a way to grant the provider network or a
local candidate path. It sends by-value source content and accepts only an exact-snapshot scoped
patch after worker stop proof. No DSH profile, Codex process, endpoint, or account state is started
by its synthetic fixtures.

Sources:

- `@deepseek-ai/dsh-tools@0.1.6-alpha.2`, installed at
  `node_modules/@deepseek-ai/dsh-tools/lib/types/index.d.ts`: `ToolDefinition` requires
  `output.schema`, `output.render(args,value)`, and `execute(args,exec)`; `ToolRuntime.register`
  and `ToolRuntime.execute` are the real registry/dispatch seam.
- `@deepseek-ai/dsh-agent-loop@0.1.6-alpha.2`, installed at
  `node_modules/@deepseek-ai/dsh-agent-loop/lib/types/index.d.ts`: `AgentLoop` is the concrete
  factory and turn/step driver behind `ctx.agents`; `ctx.agents.create()` accepts a session
  `cwd` and parent Agent ownership, while DevKit canonicalizes the candidate path before passing
  it there. It dispatches model tool calls through the real tool scheduler and owns
  cancellation/stream settlement.
- `@deepseek-ai/dsh-llm@0.1.6-alpha.2`, installed at
  `node_modules/@deepseek-ai/dsh-llm/lib/types/index.d.ts`: `LlmRuntime.registerAdapter()` and
  `LlmAdapter.stream()` are the supported local adapter seam. `isAgentLoopRequest()` proves the
  fixture receives a loop-built, immutable request rather than a hand-built call.
- `@deepseek-ai/dsh-session@0.1.6-alpha.2`,
  `@deepseek-ai/dsh-session-projection@0.1.6-alpha.2`, and
  `@deepseek-ai/dsh-system-prompt@0.1.6-alpha.2`: the test mounts the published in-memory
  session store, projection registry, and prompt service required by `AgentLoop`, rather than
  replacing their event or presentation paths.
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
- OpenAI’s current [Codex App Server protocol](https://developers.openai.com/zh-Hans/docs/app-server):
  stdio uses JSONL; App Server approvals are bidirectional JSON-RPC requests; `workspaceWrite`
  supports restricted read roots in the current protocol. The locked DSH provider exposes only
  its own older, narrow permission mapping, so this project does not infer those richer controls
  are available through it.
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

`tests/native/agent-session.test.mjs` composes the actual published `LlmRuntime`,
`SessionStore`, `SessionProjectionRegistry`, `SystemPrompt`, `AgentRegistry`, `ToolRuntime`,
and `AgentLoop`, then mounts the native DevKit plugin with its normal disabled policy. Its
only model substitute is an `OfflineSessionFixtureAdapter` subclass whose finite chunks are
defined in the test and have neither credentials nor endpoint code. The first AgentLoop request
must expose `devkit_doctor`; its fixed response selects that tool. The test proves that the
tool's rendered JSON becomes a durable `tool/result`, is supplied to the second model request,
and leads to a final assistant message. A second agent emits partial text, waits on the exact
request signal, receives `agent.cancel({ kind: "user" })`, and proves that DSH preserves the
streamed text as an interrupted assistant message before closing the turn. This is real DSH
session/tool/presentation/cancellation behavior with no network or live model.

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
whose canonical cwd differs from the candidate worktree all fail closed. The same file composes
the published `LlmRuntime`/session/prompt/AgentRegistry/ToolRuntime/AgentLoop services, creates
a short-lived candidate-bound parent through `ctx.agents.create()`, verifies its lineage and
post-run disposal, then reaches the fixture provider through that real parent. It starts no
model or Codex process.

That candidate-parent fixture also mounts the real published
`@deepseek-ai/dsh-subagent-codex` provider with a subprocess seam that records `cwd` and throws
before execution. The official provider reaches that seam exactly once with the canonical
candidate workspace, then the bridge reports `CODEX_SUBAGENT_START_FAILED` and releases the
candidate parent. This verifies the official provider’s cwd handoff without launching an App
Server, using credentials, or making a network request.

A second official-provider fixture implements only the local newline-delimited JSON-RPC peer:
it accepts initialization and an ephemeral thread, acknowledges `turn/start`, then holds the
published turn open. Cancelling after the turn ID commits makes the real provider send one
`turn/interrupt`, terminate its managed child range, await `waitForExit()`, surface
`CODEX_SUBAGENT_ABORTED`, and release the candidate parent/session. The peer is in-memory; it
does not start an executable, App Server, model session, or network connection. This covers
the provider wire/lifecycle path, not cancellation of a real App Server process.

The second native ToolRuntime fixture mounts the actual published
`@deepseek-ai/dsh-subagent-codex` plugin with the real `SubagentRuntime` and a deliberately
throwing subprocess seam. It proves that the official provider registers as `codex` and that
`devkit_doctor` observes its published capability shape, while asserting zero subprocess
starts. Under the locked provider version, doctor also reads its declared `permissionMode`,
explicit provider env and metadata. `approve-for-me` with `env: {}` is only protocol-eligible,
because the same provider's wire fixture observes its explicit `sandbox: "workspace-write"`
request. Its locked wire declines/cancels App Server approvals and has no authenticated host
approval transport; alongside the missing credential broker, that keeps native executor launch
false. `never` remains visible but is not writer-eligible;
`dangerously-bypass-approvals-and-sandbox`, unrecognized/missing/unreadable metadata, and a
nonempty explicit env are blocked. This is host-plane configuration enforcement, not an App
Server or model-session test and not an OS sandbox.

When a disabled host policy explicitly supplies `codexAppServer`, native `apply()` instead
mounts that exact official provider below a root `subprocess` isolation scope owned by DevKit.
The scoped service is a `MacosSeatbeltAppServerConfinement`: after its functional host probe it
accepts only canonical `node <package-local node_modules/@openai/codex/codex.js> app-server --stdio`,
tombstones every ambient child-environment key before restoring a fixed system
path/locale/private home and non-interactive Git settings, blocks ambient home/current-user
temporary/volume and known configuration roots, and invokes the raw DSH subprocess service through
`sandbox-exec`.
The candidate executor preflights this boundary before creating its candidate
parent and refuses to discard its private state until the provider's `waitForExit()` proof. The
locked provider source discards the `registerProvider()` disposer, so DevKit gives it a private
facade that captures and releases that root-owned registry effect; the native fixture unloads and
reloads the managed provider to prove no stale `codex` entry survives. The real provider’s
in-memory JSON-RPC cancellation fixture runs through this seam. A separate host
fixture launches a fake package-shaped wrapper through actual Seatbelt and proves candidate-only
writes, configured protected-root denial, host-home directory-data denial, denied loopback TCP
and denied Unix socket access.
Neither fixture starts Codex or connects a model: the profile intentionally denies all network
and the provider has no credential broker.

`npm run test:codex-provider-profile` adds a profile-level counterpart. It packages the
already-installed exact provider, adds the tarball to a new headless `DSH_HOME`, confirms the
provider's `subagent-codex` patch row in `--dump-config`, then boots that profile twice with
`--help`. The command never calls `SubagentRuntime.start()`, so the provider has no reason to
launch its package-local Codex App Server. Its temporary npm cache avoids reading or repairing
the user's shared npm cache.

The workspace guard is necessary because the official provider starts a child in
`parent.session.header.cwd` and exposes no public per-run cwd option. DevKit’s composition
layer therefore creates a canonical candidate-bound parent and the lower bridge rechecks that
directory before delegation; a prompt instruction cannot substitute for this boundary.

A separate one-shot fixture then exercised that path with the real published provider and
`LocalSubprocessRuntime`. The source parent and the candidate were different disposable
temporary directories; the fixture recorded exactly one provider spawn and its cwd exactly
equaled the canonical candidate directory. The provider ran with `permissionMode: "never"`
and `env: {}`, without setting a model or a full-access mode. It completed, disposed the child
and candidate parent cleanly, left `README.md` unchanged, created only
`codex-live-proof.txt`, and that file had the exact expected content. The runner did not inject
or inspect credentials; the authorized App Server used the existing login state. This is a
manual behavior check, not a repeatable CI test, a deployed DevKit task, or evidence of OS
filesystem/network/credential isolation.

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

The published registry, offline agent-session tool flow, candidate-parent composition, provider
registration, launcher lifecycle, declared permission/environment guard, official provider wire
cancellation, one real official-provider cwd/write behavior, a standalone macOS Seatbelt command
boundary, an App-Server-shaped Seatbelt launch boundary, a synthetic direct App Server client,
and a separate synthetic managed-auth account client plus loopback approval/recovery/finding-
adjudication presentations are now covered. The direct client proves the documented handshake, candidate-only
`workspaceWrite`/restricted-read/network-off turn policy, task/thread/turn approval binding,
ephemeral-thread enforcement, notification binding, allowed file-change scope, default deny
behavior, cancellation and exit-proof release. It has no native live wiring, credential,
endpoint or model call. The approval presentation is mounted only by an explicit disabled native
policy configuration: a synthetic host-secret test authenticates its loopback session, confirms
the doctor-reported listener closes at plugin unload, and proves missing secrets reject mounting.
The separately configured recovery presentation uses the same local boundary but exposes no
task recovery tool; it binds a one-time assertion to an interrupted retained run and can only
queue a fresh clone after reinspection.
The third, separately configured finding-adjudication presentation exposes no task tool; it
binds a checkbox-protected P0/P1 confirmation to an exact task/run/snapshot/finding and can
only request the existing retry loop or defer to human judgement. None of the three local pages
is connected to a direct-client executor.
The wire fixture
proves the locked provider maps `approve-for-me` to an explicit `sandbox: "workspace-write"`;
native code reports that mode and an empty explicit provider env as protocol eligibility only;
the missing credential broker and authenticated approval bridge keep executor launch disabled.
This is a provider protocol fact, not OS containment. The App Server boundary has
host evidence only for a fake wrapper; it denies candidate-external writes, configured reads,
host-home directory data, TCP and Unix sockets, then removes private state after managed-range
proof. It is not a complete macOS file-read whitelist. The candidate-parent
path has not run inside a deployed live task. The managed-auth account client now has a private-home
launcher with a dedicated auth-only proxy, but not an OAuth run or proof of real App Server proxy
compatibility. Cancellation through an actual App Server process,
provider-specific wire edge cases, actual-App-Server cancellation, an authenticated human
approval presentation connected to a direct-client executor, an independently isolated
managed-OAuth and outbound-transport boundary, and live reviewer behavior remain
unverified.
A01–A05 therefore remain partial. The default native policy keeps `executionMode: "disabled"`;
`pagination-v1` is only a double-opt-in, content-locked regression fixture and does not alter
the live gate.

## Toolchain decision

Node >=22.13 is required for built-in SQLite. TypeScript 5.7.2 and @types/node 22.10.2 remain
pinned; unused tsx/esbuild tooling was removed because tests run compiled JS. The lockfile now
pins DSH 0.1.6-alpha.2, direct AgentLoop session-test core packages and optional
subagent/Codex provider peers at 0.1.6-alpha.2, and Cordis 4.0.3; this removes the invalid
root peer produced by Cordis 4.0.2. `npm run check`,
`npm test` (132 tests), `npm run demo`, `npm run test:pack`, `npm run test:launcher`, and
`npm run test:codex-provider-profile`, and host-level `npm run test:seatbelt-host` passed on 2026-09-23. The launcher and
provider-registration gates verify package/profile composition and lifecycle, not a paid or
credentialed model interaction; the separate manual fixture above is the sole authorized
current-login invocation.
