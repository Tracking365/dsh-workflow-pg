import test from "node:test";
import assert from "node:assert/strict";
import { validateTaskInput, assertTransition, readyForAcceptance, resolveWithin, rejectModelAuthority } from "../src/index.js";

const task = { kind: "bugfix", title: "fix", description: "x", repositoryRef: "fixture", verificationProfile: "default", reproduction: { steps: ["run"], expected: "1", actual: "0" }, acceptanceCriteria: [{ id: "A1", description: "works" }] };

test("validates only executable bugfix tasks", () => { assert.equal(validateTaskInput(task).kind, "bugfix"); assert.throws(() => validateTaskInput({ ...task, kind: "feature" }), /UNSUPPORTED_TASK_KIND/); });
test("rejects invalid state transitions", () => { assert.throws(() => assertTransition("completed", "running"), /INVALID_TRANSITION/); assert.doesNotThrow(() => assertTransition("queued", "running")); });
test("completion gate requires every independent condition", () => { assert.equal(readyForAcceptance({ reproduced: true, verificationPassed: true, requiredReviewPassed: true, blockingFindings: 0, sideEffectsProvenStopped: true }), true); assert.equal(readyForAcceptance({ reproduced: true, verificationPassed: false, requiredReviewPassed: true, blockingFindings: 0, sideEffectsProvenStopped: true }), false); });
test("enforces path and model authority boundaries", () => { assert.equal(resolveWithin("/tmp/work", "src/a.ts"), "/tmp/work/src/a.ts"); assert.throws(() => resolveWithin("/tmp/work", "../secret"), /PATH_OUTSIDE/); assert.throws(() => rejectModelAuthority({ approved: true }), /MODEL_CANNOT/); });
