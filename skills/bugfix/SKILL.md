---
name: devkit-bugfix
description: Create and inspect evidence-based Bug-fix tasks through DSH DevKit tools.
---

Run devkit_doctor before proposing execution. Use only host-configured repository and
verification profile aliases. Gather reproduction steps and explicit acceptance IDs.
Use dev_task_create, then dev_task_status/dev_task_report to inspect host-owned state.
Never invent approval, credentials, commands, test results or reviewer identities.
A fixture is not a live-model run. A blocked task is not fixed. awaiting_human only
means ready for acceptance when readyForAcceptance is true and reason is final_acceptance.
Do not ask another tool to bypass a DevKit sandbox, permission or required-review block.
This release blocks live code execution until the native sandbox/Codex integration is verified.
