import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DOM_QUIESCENCE_SAMPLE_MS,
  DOM_QUIESCENCE_STABLE_SAMPLES,
  waitForDomQuiescence,
  type DomQuiescenceProbe,
} from '../e2e/helpers/dom-quiescence';

/**
 * #7837 — the cold-load probe records a settled-page sample alongside the
 * asserted first-paint one. These pin the two properties that make the recorded
 * number worth reading (it waits for the page to stop growing AND for traffic
 * to drain) and the one that keeps it off the required gate (a slow runner
 * yields `quiesced: false`, it does not throw).
 */

function probeOf(state: { elements: number; inflight: number }): DomQuiescenceProbe {
  return {
    waitForTimeout: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    elementCount: async () => state.elements,
    inflight: () => state.inflight,
  };
}

test('quiescence absorbs a late DOM bump instead of freezing on the first quiet sample (#7837)', async () => {
  const state = { elements: 3000, inflight: 0 };
  const pending = waitForDomQuiescence(probeOf(state));
  // Lands after the first quiet sample. A fixed sleep, or a wait that returned
  // on one unchanged reading, would report 3,000 for a page that grew to 3,400.
  setTimeout(() => {
    state.elements = 3400;
  }, DOM_QUIESCENCE_SAMPLE_MS + 50);

  const result = await pending;
  assert.equal(result.quiesced, true);
  assert.equal(result.elements, 3400);
  assert.equal(result.stableSamples, DOM_QUIESCENCE_STABLE_SAMPLES);
});

test('quiescence waits for in-flight requests to drain even when the DOM is already still (#7837)', async () => {
  // The element count never changes, so only the in-flight check can hold the
  // wait open — a page mid-fetch has not settled just because it looks quiet.
  const state = { elements: 3000, inflight: 2 };
  const pending = waitForDomQuiescence(probeOf(state));
  // Lands strictly between the third and fourth sample, so the drain is first
  // observed on sample four and the wait cannot return before sample six.
  setTimeout(() => {
    state.inflight = 0;
  }, DOM_QUIESCENCE_SAMPLE_MS * 3 + 50);

  const result = await pending;
  assert.equal(result.quiesced, true);
  assert.equal(result.inflight, 0);
  assert.ok(
    result.waitedMs >= DOM_QUIESCENCE_SAMPLE_MS * (3 + DOM_QUIESCENCE_STABLE_SAMPLES),
    `expected the wait to outlast the drain, got ${result.waitedMs}ms`,
  );
});

test('quiescence reports a timeout instead of throwing so the recorded sample never reds the gate (#7837)', async () => {
  // A page that keeps growing past the budget. The cold-load probe still takes
  // its sample and records `quiesced: false`; the asserted first-paint budget
  // is unaffected.
  const state = { elements: 3000, inflight: 0 };
  const timer = setInterval(() => {
    state.elements += 10;
  }, DOM_QUIESCENCE_SAMPLE_MS / 2);

  try {
    const result = await waitForDomQuiescence(probeOf(state), {
      timeout: DOM_QUIESCENCE_SAMPLE_MS * 6,
    });
    assert.equal(result.quiesced, false);
    assert.ok(result.stableSamples < DOM_QUIESCENCE_STABLE_SAMPLES);
    assert.ok(result.waitedMs >= DOM_QUIESCENCE_SAMPLE_MS * 6);
  } finally {
    clearInterval(timer);
  }
});
