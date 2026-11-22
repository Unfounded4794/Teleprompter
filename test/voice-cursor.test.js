import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VoiceCursor } from '../src/voice-cursor.js';

const script = 'paper lanterns illuminate empty streets morning weather looks better already tomorrow we can drive home quickly'.split(' ');
const hear = (cursor, text, evidence = {}) => cursor.update(text.split(' '), {
  id: 1, partial: true, audioStart: 1, audioEnd: 10, ...evidence,
});

test('advances on partial words, holds through revisions, and cues the next unread word', () => {
  const cursor = new VoiceCursor(script, 0, 'en');
  assert.equal(hear(cursor, 'paper', { streaming: true }), 1);
  assert.equal(hear(cursor, 'paper lanterns', { streaming: true }), 2);
  assert.equal(hear(cursor, 'paper lamps', { streaming: true }), null);
  assert.equal(hear(cursor, 'paper lanterns illuminate', { streaming: true }), 3);
  assert.equal(hear(cursor, 'tomorrow we can drive home quickly'), null);
  assert.equal(cursor.position, 3);
});

test('requires distinct audio before rewinding an overlapping Whisper result', () => {
  const cursor = new VoiceCursor(script, 7, 'en');
  assert.equal(hear(cursor, 'morning weather looks better already'), 10);
  const repeat = 'paper lanterns illuminate empty streets';
  assert.equal(hear(cursor, repeat, { id: 2, partial: false, audioStart: 5, audioEnd: 14 }), null);
  assert.equal(hear(cursor, repeat, { id: 3, partial: false, audioStart: 14, audioEnd: 25 }), 5);
});

test('holds through an aside and recovers once a skipped passage is confirmed', () => {
  const cursor = new VoiceCursor(script, 3, 'en');
  assert.equal(hear(cursor, 'the camera battery needs another charging cable', { partial: false }), null);
  assert.equal(hear(cursor, 'tomorrow we can drive home quickly'), null);
  assert.equal(hear(cursor, 'tomorrow we can drive home quickly', { partial: false }), script.length);
});

test('accepts a streamed number as a single script word when all its parts are spoken', () => {
  const cursor = new VoiceCursor('for 25 to 30 years'.split(' '), 1, 'en');
  assert.equal(hear(cursor, 'for twenty', { streaming: true }), null);
  assert.equal(hear(cursor, 'for twenty five', { streaming: true }), 2);
  assert.equal(hear(cursor, 'for twenty-five to thirty', { streaming: true }), 4);
  assert.equal(hear(cursor, 'for twenty five to thirty years', { streaming: true }), 5);
});

test('advances through short words split into separate recognizer fragments', () => {
  const cursor = new VoiceCursor('we can go now'.split(' '), 0, 'en');
  assert.equal(hear(cursor, 'we', { streaming: true, partial: false }), 1);
  assert.equal(hear(cursor, 'can', { id: 2, streaming: true, audioStart: 11, audioEnd: 16, partial: false }), 2);
  assert.equal(hear(cursor, 'go now', { id: 3, streaming: true, audioStart: 17, audioEnd: 24 }), 4);
});

test('uses new words from a growing partial even if the script repeats them', () => {
  const cursor = new VoiceCursor('go go go now'.split(' '), 0, 'en');
  assert.equal(hear(cursor, 'go go', { streaming: true }), 2);
  assert.equal(hear(cursor, 'go go', { streaming: true }), null);
  assert.equal(hear(cursor, 'go go go', { streaming: true }), 3);
  assert.equal(hear(cursor, 'go go go now', { streaming: true }), 4);
});

test('advances when the recognizer emits a burst of correct words at once', () => {
  const cursor = new VoiceCursor(script, 0, 'en');
  assert.equal(hear(cursor, 'paper lanterns illuminate empty streets morning', { streaming: true }), 6);
});

test('finds an earlier passage from a stale saved cue before the recognizer ends the segment', () => {
  const longScript = [...script, ...Array(500).fill('unrelated')];
  const cursor = new VoiceCursor(longScript, 340, 'en');
  assert.equal(hear(cursor, 'paper lanterns illuminate empty', { streaming: true }), null);
  assert.equal(hear(cursor, 'paper lanterns illuminate empty streets', { streaming: true }), 5);
  assert.equal(hear(cursor, 'paper lanterns illuminate empty streets morning', { streaming: true }), 6);
});

test('resumes a nearby passage from a short confirmed segment when first starting', () => {
  const cursor = new VoiceCursor('welcome back everyone to our show'.split(' '), 5, 'en');
  assert.equal(hear(cursor, 'welcome back everyone', { partial: false, streaming: true }), 3);
});

test('continues from recent words after recognition revises the beginning of a partial', () => {
  const cursor = new VoiceCursor('the camera setup feels ready to use'.split(' '), 0, 'en');
  const streaming = { streaming: true };
  assert.equal(hear(cursor, 'the camera setup feels', streaming), 4);
  assert.equal(hear(cursor, 'a camera setup feels ready', streaming), 5);
  assert.equal(hear(cursor, 'a camera setup feels ready to', streaming), 6);
});

test('follows through a substituted word once two nearby words agree', () => {
  const cursor = new VoiceCursor('put a heavy blanket on the wall behind you'.split(' '), 0, 'en');
  const streaming = { streaming: true };
  assert.equal(hear(cursor, 'put a', streaming), 2);
  assert.equal(hear(cursor, 'put a thick blanket', streaming), null);
  assert.equal(hear(cursor, 'put a thick blanket on', streaming), 5);
  assert.equal(hear(cursor, 'put a thick blanket on the', streaming), 6);
});

test('script hints can advance a short distance while normal speech is still decoding', () => {
  const cursor = new VoiceCursor(script, 0, 'en');
  const hint = { id: 'guide', streaming: true, guided: true };
  assert.equal(hear(cursor, 'paper', hint), 1);
  assert.equal(hear(cursor, 'paper lanterns illuminate empty', hint), 2);
  assert.equal(hear(cursor, 'paper lanterns', { streaming: true }), 4);
  assert.equal(hear(cursor, 'paper lanterns illuminate empty streets', hint), null);
});

test('script hints cannot end the script or cause a rewind', () => {
  const cursor = new VoiceCursor('we can go now'.split(' '), 0, 'en');
  const hint = { id: 'guide', streaming: true, guided: true };
  assert.equal(hear(cursor, 'we can go now', hint), 2);
  assert.equal(hear(cursor, 'we can', { streaming: true }), 3);
  assert.equal(hear(cursor, 'we can go now', { streaming: true }), 4);
  assert.equal(hear(cursor, 'we can go now', { ...hint, id: 'next-guide', audioStart: 11 }), null);
});

test('rewinds a distinctive repeated line in a growing streaming result', () => {
  const cursor = new VoiceCursor(script, 0, 'en');
  const passage = script.slice(0, 10).join(' ');
  assert.equal(hear(cursor, passage, { streaming: true, audioEnd: 15 }), 10);
  assert.equal(hear(cursor, passage + ' paper lanterns illuminate', { streaming: true, audioEnd: 27 }), null);
  assert.equal(hear(cursor, passage + ' paper lanterns illuminate empty', { streaming: true, audioEnd: 32 }), 4);
  assert.equal(hear(cursor, passage + ' paper lanterns illuminate empty streets', { streaming: true, audioEnd: 38 }), 5);
});

test('a transcript revision with no newly heard words cannot cause a rewind', () => {
  const cursor = new VoiceCursor(script, 0, 'en');
  assert.equal(hear(cursor, script.slice(0, 10).join(' '), { streaming: true, audioEnd: 16 }), 10);
  assert.equal(hear(cursor, 'paper lanterns illuminate empty', { streaming: true, audioEnd: 19 }), null);
  assert.equal(hear(cursor, 'paper lanterns illuminate empty streets', { streaming: true, audioEnd: 22 }), null);
});

test('resumes across a pair of wrong words once three nearby words agree', () => {
  const cursor = new VoiceCursor('good morning welcome back to our home studio today'.split(' '), 0, 'en');
  const heard = 'good morning walnut bake to our home';
  assert.equal(hear(cursor, heard, { streaming: true }), 7);
  assert.equal(hear(cursor, heard + ' studio today', { streaming: true }), 9);
});

test('script hints bridge a delayed transcript after two recent agreements', () => {
  const cursor = new VoiceCursor(script, 0, 'en');
  const hint = { id: 'guide', streaming: true, guided: true };
  const speech = { streaming: true };
  assert.equal(hear(cursor, 'paper', { ...hint, audioEnd: 7 }), 1);
  assert.equal(hear(cursor, 'paper', { ...speech, audioEnd: 8 }), null);
  assert.equal(hear(cursor, 'paper lanterns', { ...hint, audioEnd: 12 }), 2);
  assert.equal(hear(cursor, 'paper lanterns', { ...speech, audioEnd: 13 }), null);
  assert.equal(hear(cursor, script.slice(0, 6).join(' '), { ...hint, audioEnd: 29 }), 6);
});
