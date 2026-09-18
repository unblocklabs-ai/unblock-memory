import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";
import { abortable } from "../src/abortable.js";

test("abortable removes listeners after success, failure and cancellation", async () => {
  const controller = new AbortController();
  assert.equal(await abortable(Promise.resolve(7), controller.signal), 7);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  const error = new Error("failure");
  await assert.rejects(abortable(Promise.reject(error), controller.signal), error);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  const pending = abortable(new Promise<never>(() => {}), controller.signal);
  controller.abort(error);
  await assert.rejects(pending, error);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("abortable rejects already-cancelled and same-tick completion races", async () => {
  const error = new Error("cancelled");
  await assert.rejects(abortable(Promise.resolve(7), AbortSignal.abort(error)), error);
  const controller = new AbortController();
  const pending = abortable(Promise.resolve(7), controller.signal);
  controller.abort(error);
  await assert.rejects(pending, error);
});
