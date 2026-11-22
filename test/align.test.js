import assert from 'node:assert/strict';
import { test } from 'node:test';
import { matchSpeech } from '../src/align.js';

const english = 'welcome to the studio today we are testing our new camera the next sentence will be skipped press the record button when you are ready and keep your eyes on the lens'.split(' ');
const hungarian = 'ma reggel korán elindultunk a hegyekbe aztán megálltunk a tó mellett egy rövid pihenőre utána folytattuk az utat a völgy felé'.split(' ');

test('finds a line after a skipped section', () => {
  const heard = 'press the record button when you are ready'.split(' ');
  assert.equal(matchSpeech(english, heard, 10)?.end, english.indexOf('ready'));
});

test('holds position for an off-script aside', () => {
  const heard = 'can someone please check the sound levels'.split(' ');
  assert.equal(matchSpeech(english, heard, 11), null);
});

test('can rewind on a clearly repeated phrase', () => {
  const heard = 'today we are testing our new camera'.split(' ');
  const match = matchSpeech(english, heard, 22);
  assert.equal(match?.start, english.indexOf('today'));
  assert.equal(match?.end, english.indexOf('camera'));
});

test('matches Hungarian with omitted accents and one extra word', () => {
  const heard = 'aztan megalltunk most a to mellett egy rovid pihenore'.split(' ');
  assert.equal(matchSpeech(hungarian, heard, 5)?.end, hungarian.indexOf('pihenőre'));
});

test('declines ambiguous repetitions when distance cannot distinguish them', () => {
  const script = 'look at the red light then wait as the team gets ready look at the red light and start'.split(' ');
  assert.equal(matchSpeech(script, 'look at the red light'.split(' '), 7), null);
})

test('recovers when recognition splits a name and misspells adjacent Hungarian words', () => {
  const script = 'hongkong nevét a hongkong szigetről kapta és ez a hely sok turista számára'.split(' ');
  const heard = 'hong kong nevidt a hong kong sziketről kapta'.split(' ');
  assert.equal(matchSpeech(script, heard, 0)?.end, script.indexOf('kapta'));
})
