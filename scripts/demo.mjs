import { writeFileSync } from "node:fs";
import path from "node:path";
import { Devkit } from "../dist/src/index.js";
import { fixture, input, adapters } from "../dist/tests/helpers.js";
const f = fixture();
const runtime = new Devkit(f.policy, adapters());
try {
  const task = runtime.create(input);
  const result = await runtime.run(task.taskId);
  const reportPath = path.join(f.root, "report.json");
  writeFileSync(reportPath, JSON.stringify(runtime.report(task.taskId), null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ evidenceMode: "fixture", realModelsUsed: false, status: result.status, readyForAcceptance: result.readyForAcceptance, taskId: result.taskId, reportPath, patchPath: path.join(f.data, "artifacts", task.taskId, "changes.patch") }, null, 2));
  if (!result.readyForAcceptance) process.exitCode = 1;
} finally { await runtime.close(); }
