# Test report — 2026-09-22

## Actual environment

Darwin 23.6.0 x86_64; Node v24.14.1; npm 11.11.0; Git 2.53.0. The committed lockfile pins
DSH **0.1.6-alpha.2**, DSH Tools **0.1.6-alpha.2**, DSH Agent/AgentLoop/LLM/Session core
test dependencies **0.1.6-alpha.2**, optional DSH Subagent and Codex Provider
**0.1.6-alpha.2**, Cordis **4.0.3**, TypeScript **5.7.2** and @types/node **22.10.2**. No real
model or credential was invoked by these checks.

## Executed

| Command/layer | Result | What it proves |
|---|---|---|
| `npm ci --ignore-scripts` | passed | Exact committed dependencies reconstructed before the final type check and test run. |
| `npm run check` | passed | Strict TypeScript check with the above locked compiler/types. |
| `npm test` | passed: 51 tests, 0 failures/skips | Original/domain/SQLite/Git-process fixtures, an explicit content-locked native `pagination-v1` lifecycle, real Cordis/ToolRuntime and DSH AgentLoop fixtures, candidate-bound DSH session and provider subprocess-seam fixtures, plus injected HTTP tests. |
| `npm run demo` | passed | Real failing baseline -> fixed candidate -> real TAP pass -> fixture review -> patch/report, awaiting human acceptance. The task ID and temporary paths are non-portable. |
| `npm run test:pack` | passed | Tarball includes runtime/native/patch/skill/docs, imports without source tree; definition contract checks. |
| Native DSH ToolRuntime fixture | passed | Real `@deepseek-ai/cordis` Context and `@deepseek-ai/dsh-tools` ToolRuntime registered, dispatched, rejected invalid schema input, unloaded and reloaded all DevKit tools. A separately double-opted-in `pagination-v1` policy ran create → reproduce → deterministic write → verify → report → cancel/resume boundary without starting a model. |
| Offline DSH AgentLoop fixture | passed | A local finite `LlmAdapter` drove real `LlmRuntime`/`AgentLoop`/session/prompt/tool services. It selected `devkit_doctor`, persisted its rendered JSON as `tool/result`, fed that result into the next request, and propagated `{ kind: "user" }` cancellation while preserving already streamed text. The adapter has no endpoint, credential or network implementation. |
| DSH Codex registry bridge and candidate-session fixtures | passed | Real `SubagentRuntime` accepts the bounded/redacted bridge request, observes the exact parent/signal, and exercises missing-provider, failed result, unconfirmed teardown, and parent/candidate-workspace mismatch fail-closed paths. A full real AgentLoop fixture then creates a short-lived canonical candidate parent with durable source-parent lineage, reaches a fixture provider, and proves the parent session is released. Separate failure fixtures prove that a parent-create failure starts no child and an unconfirmed parent teardown retains the writer. The real official provider is separately invoked against a throwing subprocess seam; it receives the canonical candidate cwd once and no process is executed. |
| Official Codex provider registration fixture | passed | Real `@deepseek-ai/dsh-subagent-codex` registers into a real `SubagentRuntime`; native `doctor` observes the provider. A deliberately throwing subprocess seam recorded zero starts, so no App Server/model process ran. |
| `npm run test:codex-provider-profile` | passed | Packages the installed exact official provider, adds it to a disposable headless DSH profile, confirms its `subagent-codex` bundle row, and boots the profile twice. No task or `SubagentRuntime.start()` call is made. |
| `npm run test:launcher` | passed | Official DSH creates a disposable headless profile, installs the current tarball, discovers its bundle via `--dump-config`, then boots it twice with `--help`. A temporary disabled-policy SQLite file proves native `apply()` mounted; no task/model request is supplied. |
| Live Codex + independent model | blocked | A DSH-native candidate parent and the official provider's cwd subprocess seam are covered by native fixtures, but no actual App Server/model process or enforceable sandbox exists; no paid model calls made. |

The demo produced `awaiting_human`, `readyForAcceptance:true`, and
`realModelsUsed:false`. Generated task IDs and fixture paths are local runtime artifacts, not
portable references in this repository. Run demo to obtain fresh paths. Unit tests execute
fixture authors/reviewers as deterministic host code, not as real AI models. The HTTP adapter
test uses an injected transport.

## Coverage against the original acceptance IDs

`partial` below means only the stated subcase was exercised, not full acceptance.

| IDs | Status | Evidence / limit |
|---|---|---|
| A01 | partial | Exact DSH/Cordis/agent-loop/subagent npm packages, types, source paths, ToolRuntime/provider registration fixtures, an offline real AgentLoop session, candidate-bound parent composition and official provider cwd-seam fixture, plus official launcher profile boot checked; no credentialed or remote model session. |
| A02 | partial | Tarball/import and official profile install/config discovery passed; no production profile or live task. |
| A03 | partial | Real published ToolRuntime dispatches doctor/create/status/run/report/cancel/resume; its content-locked `pagination-v1` fixture reaches final acceptance without a model, and doctor detects a registered official Codex provider. An offline real AgentLoop session selects `devkit_doctor`; a separate real AgentLoop fixture creates the candidate-bound parent passed to the provider seam. No live Provider process is used. |
| A04 | partial | ToolRuntime unload/reload, owned cooperative shutdown, bridge disposal semantics, candidate-parent handle disposal and unconfirmed-parent retention, offline AgentLoop cancellation and two launcher boots passed; actual provider-process cancellation remains unverified. |
| A05 | partial | Strict nested input plus actual ToolRuntime invalid-schema rejection; the offline AgentLoop proves native schema presentation and rendered output replay, while a live launcher/provider presentation path remains unverified. |
| B01–B04 | passed (unit/fixture) | Create, same/different idempotency keys, unsupported kinds. |
| B05–B06 | partial | Missing/same-family adapters, unknown authority fields, bounded/redacted Codex task construction, candidate-parent cwd handoff and parent/candidate mismatch are blocked or fixture-tested; full live/prompt-injection testing remains. |
| C01–C03 | passed (fixture) | Dirty source preserved; path variants/symlinks rejected; persistent leases and concurrent run rejection. |
| C04–C08 | partial/blocked | Snapshot mutation, strict live block, candidate-workspace parent composition and official-provider cwd seam tested; OS isolation, network and real credential boundaries not implemented. |
| C09 | partial | Shell-free argv/env test on macOS; Windows not tested. |
| D01–D06 | passed (fixture) | Frozen regression failure/pass, no reproduction, missing/zero/skipped tests, tampering, stale evidence. |
| D07–D09 | passed (fixture) | Verifier mutation, binary/untracked/executable snapshot, incomplete acceptance coverage. |
| E01–E06 | partial | Confirmed/unconfirmed P1, low-priority backlog, malformed/stale/failed HTTP reviews and shared retry budget tested; production evidence adjudication/optional-review behavior absent. |
| E07–E09 | partial | Deterministic fingerprints, same-family block and stale snapshot checks; semantic dedup and full live identity checks remain. |
| F01–F02 | partial | macOS process/cooperative cancellation, native fixture terminal cancellation, offline AgentLoop stream cancellation/preserved text, bridge and candidate-parent disposal proof, candidate-parent create failure, and unproven stop retaining the lease are tested; escaped hostile descendants require sandbox. |
| F03–F05 | blocked | Leases survive reopen and budgets remain, but explicit safe resume/crash reconciliation not implemented. |
| F06–F07 | passed (unit) | Unsupported/corrupt stores preserved; failing event trigger rolls back task state. |
| G01–G02 | passed (fixture) | Distinguishes final acceptance from unresolved human judgement. |
| G03–G04 | partial | No model approval tool, stale host acceptance rejected; authenticated/expiring approval capabilities remain. |
| G05 | passed (fixture) | Patch delivered; dirty source unchanged; no push/merge/deploy. |
| G06 | deferred | No production local commit feature. |
| G07–G08 | partial | Bounds/redaction/env and an honest macOS-only matrix; regex is not complete secret detection. |
| H01–H03 | blocked/fail-closed | No implicit model invocation/fallback; a registered provider still cannot bypass disabled mode or the workspace-binding guard; no live evidence. |

51/51 does not mean the 56 acceptance IDs all pass. M0–M3 are explicitly incomplete.
