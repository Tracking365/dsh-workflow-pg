# DSH compatibility — source verified, runtime unverified

Checked 2026-09-20 against official source/documentation; no DSH installation was available
in the execution container. Do not describe this as an installed or locked DSH dependency.

Sources:

- https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/tools/package.json
  inspected version: `@deepseek-ai/dsh-tools` **0.1.6-alpha.2**;
  blob `041bf5570bb9c564e1d61fd2a9ce753c731a32f0`.
- https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/tools/src/index.ts
  inspected source blob `6be7be61e257cd9e38c8a3122298316bf3df9892`.
  `ToolDefinition` extends `ToolSchema`, requires `output.schema`,
  `output.render(args,value)` and `execute(args,exec)`, with `exec.signal`.
  `ToolRuntime.register` is the registration seam.
- https://deepseek-harness.github.io/deepseek-harness/develop/basic/publish
  `dsh.bundle.patch`, insert rows and `dsh plugin --profile ... add ...tgz`.
- https://deepseek-harness.github.io/deepseek-harness/develop/framework/lifecycle
  Cordis plugin lifecycle; actual disposal behavior must be checked against the installed version.
- https://api-docs.deepseek.com/api/create-chat-completion
  Reference for the separate HTTP adapter; protocol behavior was tested with injected responses,
  not against a live endpoint.

`native/index.mjs` uses the documented raw tool-definition interface without importing a
second runtime copy or declaring a fabricated Context type. It exports name/inject/apply.
The pack smoke imports this boundary and checks definitions directly; it does NOT call a
mock Context and claim native integration.

## Remaining compatibility gate

Install and pin a real DSH runtime in an isolated profile; verify tools service injection,
JSON input/output schema acceptance, all seven registrations via `ctx.tools.execute`,
caller cancellation, dispose/reload, package resolution and profile isolation. Then record
the exact runtime commit and results. Until then A03 and native parts of A02/A04 are blocked.

## Toolchain decision

Node >=22.13 is required for built-in SQLite. TypeScript 5.7.2 and @types/node 22.10.2 remain
pinned; unused tsx/esbuild tooling was removed because tests run compiled JS. A clean isolated
worktree ran `npm ci`, `npm run check`, `npm test`, `npm run demo`, and `npm run test:pack` on
2026-09-22 with those exact locked packages. This verifies the package toolchain, not a DSH
runtime integration.
