import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VoicePace } from '../src/voice-pace.js';

const words = 'we can go to the next room and read this line again'.split(' ');

test('leads at the onset of speech and holds if the reader pauses', () => {
  const pace = new VoicePace(words);
  assert.equal(pace.update(1, false), 0);
  assert.equal(pace.update(2, true), 0);
  assert.equal(pace.update(3, true), 1);
  assert.equal(pace.confirm(1, 5), 1);
  for (let frame = 6; frame < 40; frame++) assert.equal(pace.update(frame, false), 1);
});

test('a burst of matches shows every word in order', () => {
  const pace = new VoicePace(words);
  assert.equal(pace.confirm(8, 20), 0);
  let previous = 0;
  for (let frame = 21; frame < 35; frame++) {
    const next = pace.update(frame, true);
    assert.ok(next === previous || next === previous + 1);
    previous = next;
  }
  assert.ok(previous >= 6);
});

test('continues during brief decoding gaps and limits unconfirmed progress', () => {
  const pace = new VoicePace(words, 2);
  pace.confirm(4, 12);
  pace.confirm(5, 16);
  let cue;
  for (let frame = 17; frame <= 55; frame++) cue = pace.update(frame, true);
  assert.equal(cue, 11);
});

test('a confirmed relocation moves straight to the new passage', () => {
  const pace = new VoicePace(words, 8);
  pace.waitForMatch();
  for (let frame = 20; frame < 30; frame++) assert.equal(pace.update(frame, true), 8);
  assert.equal(pace.confirm(3, 30, true), 3);
  assert.equal(pace.confirm(words.length, 50), 3);
  for (let frame = 51; frame < 100; frame++) pace.update(frame, false);
  assert.equal(pace.cue, words.length);
});

test('holds the last word until it is confirmed', () => {
  const pace = new VoicePace(words, words.length - 2);
  pace.confirm(words.length - 1, 10);
  for (let frame = 11; frame < 40; frame++) pace.update(frame, true);
  assert.equal(pace.cue, words.length - 1);
});

test('a delayed match within the distance the reader could have covered stays sequential', () => {
  const pace = new VoicePace(words, 1);
  pace.confirm(2, 10);
  assert.equal(pace.confirm(11, 34, true), 1);
  assert.equal(pace.update(35, true), 2);
});

test('a sentence boundary makes the guide dwell before continuing', () => {
  const pace = new VoicePace(words, 0, [4]);
  pace.confirm(2, 10);
  let boundary;
  for (let frame = 11; frame <= 32; frame++) {
    const cue = pace.update(frame, true);
    if (cue === 4 && boundary === undefined) boundary = frame;
    if (cue === 5) {
      assert.ok(frame - boundary >= 6);
      return;
    }
  }
  assert.fail('The guide stalled at the sentence boundary');
});
