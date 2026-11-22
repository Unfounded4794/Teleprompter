import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EnglishStream } from '../src/english-stream.js';

test('ignores a script hint during a pause while accepting unrestricted recognition', () => {
  const results = [];
  const stream = new EnglishStream({}, {
    transcript: (text, evidence) => results.push({ text, guided: evidence.guided }),
  }, ['good', 'morning', 'and', 'welcome']);
  stream.worker = { postMessage() {} };

  for (let frame = 1; frame <= 9; frame++) {
    stream.feed(new Float32Array(1), frame, frame === 2);
    const partial = frame === 9 ? 'good morning and welcome' : 'good morning';
    for (const recognizerId of ['script-guide', 'teleprompter']) {
      stream.receive({ event: 'partialresult', recognizerId, result: { partial } });
    }
  }

  assert.deepEqual(results, [
    { text: 'good morning', guided: false },
    { text: 'good morning and welcome', guided: false },
  ]);
});
