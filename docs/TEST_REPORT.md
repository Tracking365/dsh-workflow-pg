# Test report — 2026-09-22

## Actual environment

Darwin 23.6.0 x86_64; Node v24.14.1; npm 11.11.0; Git 2.53.0. An isolated worktree completed
`npm ci` with the committed lockfile, using TypeScript **5.7.2** and @types/node **22.10.2**.
No `dsh` executable was present; no real model or credential was invoked by these checks.

## Executed

| Command/layer | Result | What it proves |
|---|---|---|
| `npm ci` | passed | Exact committed dependencies installed in an isolated worktree. |
| `npm run check` | passed | Strict TypeScript check with the above locked compiler/types. |
| `npm test` | passed: 36 tests, 0 failures/skips | Original 4 tests plus domain, SQLite, real Git/process fixture and injected HTTP tests. |
| `npm run demo` | passed | Real failing baseline -> fixed candidate -> real TAP pass -> fixture review -> patch/report, awaiting human acceptance. Task `c5643ae1-8ee9-4f9e-99de-e4dae89f24d8`; temporary paths are non-portable. |
| `npm run test:pack` | passed | Tarball includes runtime/native/patch/skill/docs, imports without source tree; definition contract checks. |
| Native DSH fixture | blocked | No actual DSH runtime/profile/registry was executed. |
| Live Codex + independent model | blocked | Codex adapter and enforceable sandbox absent; no paid model calls made. |

The demo used task `0e9ae9d6-1037-42ce-b846-a56754e89f5e` and produced
`awaiting_human`, `readyForAcceptance:true`, `realModelsUsed:false`. Generated fixture
paths are local runtime artifacts, not portable references in this repository. Run demo
to obtain fresh paths. Unit tests execute fixture authors/reviewers as deterministic host
code, not as real AI models. The HTTP adapter test uses an injected transport.

## Coverage against the original acceptance IDs

`partial` below means only the stated subcase was exercised, not full acceptance.

| IDs | Status | Evidence / limit |
|---|---|---|
| A01 | partial | Source/API and environment checked; installed DSH missing. |
| A02 | partial | Tarball/import passed; profile install blocked. |
| A03 | blocked | Real registry dispatch missing. |
| A04 | partial | Owned cooperative shutdown tested; actual DSH unload/reload missing. |
| A05 | partial | Strict nested input tests and definition contracts; actual registry output enforcement missing. |
| B01–B04 | passed (unit/fixture) | Create, same/different idempotency keys, unsupported kinds. |
| B05–B06 | partial | Missing/same-family adapters and unknown authority fields blocked; full live/prompt-injection testing remains. |
| C01–C03 | passed (fixture) | Dirty source preserved; path variants/symlinks rejected; persistent leases and concurrent run rejection. |
| C04–C08 | partial/blocked | Snapshot mutation and strict live block tested; OS isolation, network and real credential boundaries not implemented. |
| C09 | partial | Shell-free argv/env test on macOS; Windows not tested. |
| D01–D06 | passed (fixture) | Frozen regression failure/pass, no reproduction, missing/zero/skipped tests, tampering, stale evidence. |
| D07–D09 | passed (fixture) | Verifier mutation, binary/untracked/executable snapshot, incomplete acceptance coverage. |
| E01–E06 | partial | Confirmed/unconfirmed P1, low-priority backlog, malformed/stale/failed HTTP reviews and shared retry budget tested; production evidence adjudication/optional-review behavior absent. |
| E07–E09 | partial | Deterministic fingerprints, same-family block and stale snapshot checks; semantic dedup and full live identity checks remain. |
| F01–F02 | partial | macOS process/cooperative cancellation, unproven stop retains lease; escaped hostile descendants require sandbox. |
| F03–F05 | blocked | Leases survive reopen and budgets remain, but explicit safe resume/crash reconciliation not implemented. |
| F06–F07 | passed (unit) | Unsupported/corrupt stores preserved; failing event trigger rolls back task state. |
| G01–G02 | passed (fixture) | Distinguishes final acceptance from unresolved human judgement. |
| G03–G04 | partial | No model approval tool, stale host acceptance rejected; authenticated/expiring approval capabilities remain. |
| G05 | passed (fixture) | Patch delivered; dirty source unchanged; no push/merge/deploy. |
| G06 | deferred | No production local commit feature. |
| G07–G08 | partial | Bounds/redaction/env and an honest macOS-only matrix; regex is not complete secret detection. |
| H01–H03 | blocked/fail-closed | No implicit model invocation/fallback; no live evidence. |

36/36 does not mean the 56 acceptance IDs all pass. M0–M3 are explicitly incomplete.
