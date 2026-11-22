import { englishNumberParts } from './voice-cursor.js';

const recognizerId = 'teleprompter';
const guideId = 'script-guide';
const guideSilence = 6; // 300 ms without speech

function streamState() {
  return { segment: 0, start: 1, pending: [], partial: '' };
}

function scriptGrammar(words) {
  if (words.length < 4 || words.length > 8000) return null;
  const phrases = ['[unk]'];
  for (let start = 0; start < words.length; start += 23) {
    const phrase = words.slice(start, start + 24).flatMap(word =>
      /^[a-z]+(?:'[a-z]+)?$/.test(word) ? [word] : englishNumberParts(word));
    if (phrase.length) phrases.push(phrase.join(' '));
  }
  return JSON.stringify(phrases);
}

export class EnglishStream {
  constructor(runtime, { transcript, failure, behind }, words, frameSize = 800) {
    this.runtime = runtime;
    this.transcript = transcript;
    this.failure = failure;
    this.behind = behind;
    this.unrestricted = streamState();
    this.backlog = 32000 / frameSize;
    this.grammar = scriptGrammar(words);
    this.guide = this.grammar ? streamState() : null;
    this.lastSpeech = -Infinity;
  }

  async start() {
    const worker = new Worker(this.runtime.worker);
    this.worker = worker;
    worker.onmessage = ({ data }) => this.receive(data);
    worker.onerror = () => this.reportError('The English streaming engine could not start in this browser.');
    await new Promise((resolve, reject) => {
      this.loading = { resolve, reject, timer: setTimeout(() => this.reportError('The English streaming model timed out.'), 60_000) };
      worker.postMessage({ action: 'set', key: 'logLevel', value: -1 });
      worker.postMessage({ action: 'load', modelUrl: new URL(this.runtime.model, location.origin).href });
    });
  }

  feed(samples, frame, speaking) {
    if (!this.worker) return;
    if (speaking) this.lastSpeech = frame;
    const pending = this.unrestricted.pending.length;
    if (pending >= 10) this.disableGuide();
    if (pending === this.backlog) this.behind();
    if (pending > 4 * this.backlog) {
      this.failure('This device cannot keep up with the English streaming model.');
      return;
    }
    for (let index = 0; index < samples.length; index++) samples[index] *= 32768;
    if (this.guide) this.send(samples.slice(), frame, guideId, this.guide, frame - this.lastSpeech <= guideSilence);
    this.send(samples, frame, recognizerId, this.unrestricted);
  }

  send(samples, frame, id, stream, recentlySpoke = true) {
    stream.pending.push({ frame, recentlySpoke });
    this.worker.postMessage({
      action: 'audioChunk', recognizerId: id, sampleRate: 16000, data: samples,
    }, [samples.buffer]);
  }

  disableGuide() {
    if (!this.guide) return;
    this.guide = null;
    this.worker.postMessage({ action: 'remove', recognizerId: guideId });
  }

  receive(data) {
    if (!data) return;
    if (data.event === 'error') {
      if (data.recognizerId === guideId) return this.disableGuide();
      this.reportError(data.error || 'The English streaming model reported an error.');
      return;
    }
    if (data.event === 'load' && this.loading) {
      if (!data.result) return this.reportError('The saved English streaming model could not be loaded. Prepare it again.');
      clearTimeout(this.loading.timer);
      this.worker.postMessage({ action: 'create', recognizerId, sampleRate: 16000 });
      if (this.guide) this.worker.postMessage({ action: 'create', recognizerId: guideId, sampleRate: 16000, grammar: this.grammar });
      this.loading.resolve();
      this.loading = null;
      return;
    }
    if (data.event !== 'result' && data.event !== 'partialresult') return;

    const guided = data.recognizerId === guideId;
    const stream = guided ? this.guide : this.unrestricted;
    const received = stream?.pending.shift();
    if (!received) return;
    const { frame: audioEnd, recentlySpoke } = received;
    const partial = data.event === 'partialresult';
    const text = (partial ? data.result.partial : data.result.text)?.trim();
    if (text && recentlySpoke && (!partial || text !== stream.partial)) {
      this.transcript(text, {
        partial, id: data.recognizerId + '-' + stream.segment, streaming: true, guided,
        audioStart: stream.start, audioEnd, behind: this.unrestricted.pending.length >= this.backlog,
      });
    }
    stream.partial = partial ? text : '';
    if (!partial) {
      stream.segment++;
      stream.start = audioEnd + 1;
    }
  }

  reportError(message) {
    if (!this.loading) return this.failure(message);
    clearTimeout(this.loading.timer);
    this.loading.reject(new Error(message));
    this.loading = null;
  }

  stop() {
    this.worker?.terminate();
    this.worker = null;
    if (!this.loading) return;
    clearTimeout(this.loading.timer);
    this.loading.reject(new Error('Voice follow stopped.'));
    this.loading = null;
  }
}
