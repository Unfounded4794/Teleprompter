import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeDisplay } from '../src/display-settings.js';
import { VoiceScroll } from '../src/voice-scroll.js';

function step(scroll, match, speaking, now, smoothing) {
  return scroll.update(match * 60, 0, 720, 60, speaking, now, smoothing);
}

function cruising(smoothing = 60) {
  const scroll = new VoiceScroll();
  for (let now = 0; now <= 640; now += 16) step(scroll, Math.floor(now / 160) * .25, true, now, smoothing);
  return scroll;
}

test('voice scrolling is opt-in and both adjustments are bounded', () => {
  assert.equal(normalizeDisplay().voiceScroll, false);
  assert.equal(normalizeDisplay().voiceLineOffset, 0);
  assert.equal(normalizeDisplay().voiceScrollSmoothing, 60);
  assert.equal(normalizeDisplay({ voiceLineOffset: 7, voiceScrollSmoothing: 110 }).voiceLineOffset, 2);
  assert.equal(normalizeDisplay({ voiceScrollSmoothing: 110 }).voiceScrollSmoothing, 100);
});

test('keeps a running pixel velocity between batches', () => {
  const scroll = new VoiceScroll();
  assert.equal(step(scroll, 0, false, 0), 0);
  for (let now = 16; now <= 1600; now += 16) {
    const before = scroll.position;
    const speed = scroll.velocity;
    const next = step(scroll, now < 320 ? 0 : 1.1, true, now);
    assert.ok(next > before && next - before < 3);
    assert.ok(Math.abs(scroll.velocity - speed) < 10);
  }
  assert.ok(scroll.position > 60);
});

test('waiting silently does not build momentum before speech begins', () => {
  const scroll = new VoiceScroll();
  step(scroll, 2, false, 0);
  assert.equal(step(scroll, 2, false, 7984), 120);
  assert.ok(step(scroll, 2, true, 8000) < 120.1);
  assert.ok(scroll.velocity > 0 && scroll.velocity < 4);
});

test('brakes progressively for most of a second and restarts with a small first step', () => {
  const scroll = cruising();
  const moving = scroll.velocity;
  assert.ok(moving > 10);
  for (let now = 656; now <= 1040; now += 16) {
    const previous = scroll.velocity;
    step(scroll, 1.1, false, now);
    assert.ok(scroll.velocity < previous && scroll.velocity > 0);
  }
  assert.ok(Math.abs(scroll.velocity - moving / 2) < .001);
  for (let now = 1056; now <= 1440; now += 16) step(scroll, 1.1, false, now);
  const stopped = scroll.position;
  assert.ok(scroll.velocity < .001);
  assert.equal(step(scroll, 1.2, false, 1456), stopped);
  const resumed = step(scroll, 1.4, true, 1472);
  assert.ok(resumed > stopped && resumed - stopped < 1);
});

test('higher smoothing slows the speed ramp and lengthens the coast', () => {
  const low = cruising(0);
  const high = cruising(100);
  assert.ok(low.velocity > high.velocity);
  for (let now = 656; now <= 960; now += 16) {
    step(low, 1.1, false, now, 0);
    step(high, 1.1, false, now, 100);
  }
  assert.equal(low.velocity, 0);
  assert.ok(high.velocity > 5);
});

test('corrects a rewind smoothly and resets immediately on a manual seek', () => {
  const scroll = new VoiceScroll();
  step(scroll, 6, false, 0);
  const rewound = step(scroll, 3, true, 16);
  assert.ok(rewound < 360 && rewound > 359);
  for (let now = 32; now <= 1600; now += 16) step(scroll, 3, true, now);
  assert.ok(scroll.position < 230);
  scroll.reset();
  assert.equal(step(scroll, 10, true, 1616), 600);
});
