import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VoiceMatch } from '../src/voice-match.js';

test('shows the last matched word or an exact number of words ahead', () => {
  const match = new VoiceMatch(10, 0, 1);
  assert.equal(match.setLead(4), 0);
  assert.equal(match.confirm(3, 4, false), 0);
  assert.equal(match.setLead(0), 2);
  assert.equal(match.setLead(1), 3);
  assert.equal(match.setLead(4), 6);
  for (let frame = 4; frame <= 100; frame++) assert.equal(match.update(frame), 6);
});

test('displays a batch in order at one word per 50 ms', () => {
  const match = new VoiceMatch(10, 0, 1);
  assert.equal(match.confirm(4, 4, false), 0);
  assert.deepEqual(Array.from({ length: 9 }, (_, i) => match.update(i + 5)), [1, 1, 2, 2, 3, 3, 4, 4, 4]);
});

test('clamps a lead at the end and honors a recognized rewind', () => {
  const match = new VoiceMatch(8, 0, 3);
  assert.equal(match.confirm(6, 20, true), 7);
  assert.equal(match.confirm(3, 32, true), 5);
  assert.equal(match.confirm(8, 80, false), 5);
  assert.equal(match.setLead(1), 8);
  assert.equal(match.setLead(0), 7);
});
