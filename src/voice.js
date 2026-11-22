import { EnglishStream } from './english-stream.js';

const cacheName = 'teleprompter-models-v2';
const runtimeManifestUrl = '/runtime/manifest.json';
const sessionKey = 'teleprompter-voice-session';
// Whisper receives one 100 ms frame at a time.
const englishTiming = { first: 11, interval: 8, window: 24 };
const hungarianTiming = { first: 14, interval: 10, window: 30 };

function runtimeFiles(runtime, model) {
  const suffix = model === 'turbo' ? '.asyncify' : '';
  return runtime.files.filter(path => path === '/runtime/ort-wasm-simd-threaded' + suffix + '.mjs'
    || path === '/runtime/ort-wasm-simd-threaded' + suffix + '.wasm');
}

async function runtimeManifest() {
  const response = await fetch(runtimeManifestUrl);
  if (!response.ok) throw new Error('Reconnect to the local app to prepare the speech engine.');
  return response.json();
}

export class Voice {
  constructor({ status, transcript, failure, level = () => {}, behind = () => {}, speechFrame = () => {} }) {
    this.status = status;
    this.transcript = transcript;
    this.failure = failure;
    this.level = level;
    this.behind = behind;
    this.speechFrame = speechFrame;
    try {
      this.interrupted = Boolean(sessionStorage.getItem(sessionKey));
      sessionStorage.removeItem(sessionKey);
    } catch {}
    this.jobs = new Map();
    this.serial = 0;
    this.captureId = 0;
    this.running = false;
    this.decodeId = 0;
  }

  async checkSupport(model) {
    if (model !== 'turbo') return;
    const adapter = await navigator.gpu?.requestAdapter();
    if (!adapter?.features.has('shader-f16')) throw new Error('High accuracy needs WebGPU float16. Choose Lightweight on older phones.');
  }

  async prepared(model) {
    if (!('caches' in globalThis)) return null;
    const cache = await caches.open(cacheName);
    if (model === 'live-en') {
      const { streaming } = await runtimeManifest();
      if (!streaming || !await cache.match(streaming.worker) || !await cache.match(streaming.model)) return null;
      return streaming;
    }
    const cached = await cache.match('/models/' + model + '/manifest.json');
    const manifest = await cached?.json();
    if (!manifest) return null;
    for (const path of manifest.files) {
      if (!(await cache.match('/models/' + model + '/' + path))) return null;
    }
    const runtime = await runtimeManifest();
    const stored = await cache.match(runtimeManifestUrl);
    if (!stored || (await stored.json()).version !== runtime.version) return null;
    for (const path of runtimeFiles(runtime, model)) {
      if (!(await cache.match(path))) return null;
    }
    return manifest;
  }

  async prepare(model) {
    await this.checkSupport(model);
    if (!isSecureContext || !('caches' in globalThis)) throw new Error('Open the app from its local HTTPS address before preparing voice follow.');
    const ready = await this.prepared(model);
    if (ready) return ready;
    if (model === 'live-en') return this.prepareStreaming();
    const path = '/models/' + model + '/';
    const cache = await caches.open(cacheName);
    let response;
    try { response = await fetch(path + 'manifest.json'); } catch {
      throw new Error('Connect to the local server to copy the speech model.');
    }
    if (!response.ok) throw new Error('Prepare this voice model in the desktop setup window, then try again.');
    const manifest = await response.json();
    if (manifest.choice !== model || !Array.isArray(manifest.files)) throw new Error('The speech model manifest is invalid.');
    const sourceFiles = manifest.files.map(file => path + file);
    const previous = await cache.match(path + 'manifest.json');
    if (previous && (await previous.json()).revision !== manifest.revision) {
      await Promise.all(sourceFiles.map(file => cache.delete(file)));
      await cache.delete(path + 'manifest.json');
    }
    const runtime = await runtimeManifest();
    const oldRuntime = await cache.match(runtimeManifestUrl);
    if (oldRuntime && (await oldRuntime.json()).version !== runtime.version) {
      await Promise.all(runtime.files.map(file => cache.delete(file)));
      await cache.delete(runtimeManifestUrl);
    }
    const engineFiles = runtimeFiles(runtime, model);
    const assets = [...sourceFiles, ...engineFiles];
    const total = Object.values(manifest.bytes).reduce((sum, size) => sum + size, 0)
      + engineFiles.reduce((sum, path) => sum + (runtime.sizes?.[path] || runtime.bytes / runtime.files.length), 0);
    for (const [index, asset] of assets.entries()) {
      this.status('Saving model files on this device (' + (index + 1) + '/' + assets.length + ' · ' + Math.round(total / 1e6) + ' MB)…');
      if (await cache.match(asset)) continue;
      const file = await fetch(asset);
      if (!file.ok) throw new Error('A speech file could not be copied. Reconnect to the local server and try again.');
      await cache.put(asset, file);
    }
    const headers = { 'Content-Type': 'application/json', 'Cross-Origin-Resource-Policy': 'same-origin' };
    await cache.put(runtimeManifestUrl, new Response(JSON.stringify(runtime), { headers }));
    await cache.put(path + 'manifest.json', new Response(JSON.stringify(manifest), {
      headers: { 'Content-Type': 'application/json', 'Cross-Origin-Resource-Policy': 'same-origin' },
    }));
    return manifest;
  }

  async prepareStreaming() {
    const { streaming } = await runtimeManifest();
    if (!streaming) throw new Error('The English streaming model is missing from this installation.');
    const cache = await caches.open(cacheName);
    this.status('Saving Live English (' + Math.round(streaming.bytes / 1e6) + ' MB)…');
    for (const path of [streaming.worker, streaming.model]) {
      if (await cache.match(path)) continue;
      const response = await fetch(path);
      if (!response.ok) throw new Error('Reconnect to the local server to prepare Live English.');
      await cache.put(path, response);
    }
    return streaming;
  }

  async start(model, language, words, wordMatch = false) {
    if (!navigator.mediaDevices?.getUserMedia || !globalThis.AudioContext) {
      throw new Error('Microphone access requires the app’s local HTTPS address.');
    }
    const id = ++this.captureId;
    this.language = language;
    this.timing = language === 'hu' ? hungarianTiming : englishTiming;
    const frameSize = model === 'live-en' ? wordMatch ? 400 : 800 : 1600;
    const activation = new AudioContext({ latencyHint: 'interactive' });
    this.context = activation;
    const resumed = activation.resume().then(() => null, error => error);
    try {
      await this.checkSupport(model);
      const manifest = await this.prepared(model);
      if (!manifest) throw new Error('Prepare this speech model on this device before starting voice follow.');
      this.status('Starting the local model…');
      const resumeError = await resumed;
      if (resumeError) throw resumeError;
      if (id !== this.captureId) return false;
      try { sessionStorage.setItem(sessionKey, model); } catch {}
      if (model === 'live-en') {
        if (language !== 'en') throw new Error('Live English supports English speech.');
        this.streaming = new EnglishStream(manifest, {
          transcript: this.transcript, failure: this.failure, behind: this.behind,
        }, wordMatch ? [] : words, frameSize);
        await this.streaming.start();
      } else {
        const desktop = matchMedia('(pointer: fine)').matches && !navigator.maxTouchPoints;
        const threads = desktop && crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
        await this.request({ type: 'load', model, dtype: manifest.dtype, threads });
      }
      if (id !== this.captureId) return false;
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      if (id !== this.captureId) {
        stream.getTracks().forEach(track => track.stop());
        return false;
      }
      this.stream = stream;
      await activation.audioWorklet.addModule(new URL('./pcm.worklet.js', import.meta.url));
      if (id !== this.captureId) return false;
      const worklet = new AudioWorkletNode(activation, 'teleprompter-pcm', {
        processorOptions: { frameSize },
      });
      const mute = activation.createGain();
      mute.gain.value = 0;
      const source = activation.createMediaStreamSource(stream);
      source.connect(worklet).connect(mute).connect(activation.destination);
      worklet.port.onmessage = ({ data }) => this.acceptFrame(data);
      for (const track of stream.getAudioTracks()) track.addEventListener('ended', () => {
        if (this.running && id === this.captureId) this.failure('The microphone disconnected.');
      });
      this.clearAudio();
      this.heardAudio = false;
      this.startedAt = performance.now();
      this.running = true;
      this.status('Listening on this device');
      return true;
    } catch (error) {
      if (id !== this.captureId) return false;
      this.stop();
      if (error.name === 'NotAllowedError') throw new Error('Allow microphone access in Safari or in the Home Screen app, then try again.');
      throw error;
    }
  }

  stop() {
    this.captureId++;
    this.running = false;
    this.stream?.getTracks().forEach(track => track.stop());
    this.stream = null;
    this.context?.close().catch(() => {});
    this.context = null;
    this.disposeWorker(new Error('Voice follow stopped.'));
    this.streaming?.stop();
    this.streaming = null;
    try { sessionStorage.removeItem(sessionKey); } catch {}
    this.level(0);
    this.clearAudio();
  }

  clearAudio() {
    this.frames = [];
    this.frameNumber = 0;
    this.firstSpeechFrame = null;
    this.lastDecodeFrame = null;
    this.newSpeech = 0;
    this.quietFrames = 0;
    this.activeDecode = null;
    this.lagging = false;
  }

  acceptFrame(frame) {
    if (!this.running) return;
    let power = 0;
    for (const sample of frame) power += sample * sample;
    const rms = Math.sqrt(power / frame.length);
    this.level(Math.min(1, rms * 12));
    const speaking = rms > .003;
    if (speaking) this.heardAudio = true;
    if (!this.heardAudio && performance.now() - this.startedAt > 8000) {
      this.status('The microphone is quiet. Check the microphone level and speak closer to it.');
    }
    this.frameNumber++;
    this.speechFrame(this.frameNumber, speaking, rms);
    if (this.streaming) {
      this.streaming.feed(frame, this.frameNumber, speaking);
      return;
    }
    this.frames.push(frame);
    if (this.frames.length > this.timing.window) this.frames.shift();
    if (speaking) {
      this.firstSpeechFrame ??= this.frameNumber;
      this.newSpeech++;
      this.quietFrames = 0;
    } else {
      this.quietFrames++;
    }
    if (this.quietFrames >= 5 && this.newSpeech < 3) {
      this.frames = this.frames.slice(-3);
      this.newSpeech = 0;
      this.firstSpeechFrame = null;
      this.lastDecodeFrame = null;
    }
    if (this.activeDecode && this.newSpeech >= 4 && performance.now() - this.activeDecode.startedAt > 1800 && !this.lagging) {
      this.lagging = true;
      this.behind();
    }
    this.decodeLatest();
  }

  async decodeLatest() {
    if (!this.running || this.activeDecode || this.newSpeech < 3) return;
    const paused = this.quietFrames >= 3;
    const elapsed = this.frameNumber - (this.lastDecodeFrame ?? this.firstSpeechFrame) + 1;
    const minimum = this.lastDecodeFrame === null ? this.timing.first : this.timing.interval;
    if (!paused && elapsed < minimum) return;

    // If the model is busy, keep gathering the latest audio instead of queuing old windows.
    const captureId = this.captureId;
    const frames = this.frames.slice();
    const decode = {
      id: ++this.decodeId,
      startedAt: performance.now(),
      audioStart: this.frameNumber - frames.length + 1,
      audioEnd: this.frameNumber,
    };
    this.activeDecode = decode;
    this.lastDecodeFrame = this.frameNumber;
    this.newSpeech = 0;
    const audio = new Float32Array(frames.length * frames[0].length);
    for (const [index, frame] of frames.entries()) audio.set(frame, index * frame.length);
    const deliver = (text, partial) => {
      if (!this.running || captureId !== this.captureId || !text) return;
      this.transcript(text, { partial, id: decode.id, audioStart: decode.audioStart, audioEnd: decode.audioEnd, behind: this.lagging });
    };
    try {
      const { text } = await this.request(
        { type: 'audio', samples: audio, language: this.language }, [audio.buffer], text => deliver(text, true),
      );
      if (captureId === this.captureId && performance.now() - decode.startedAt < 1400) this.lagging = false;
      deliver(text, false);
    } catch (error) {
      if (this.running && captureId === this.captureId) this.failure(error.message);
    } finally {
      if (this.activeDecode === decode) {
        this.activeDecode = null;
        this.decodeLatest();
      }
    }
  }

  request(message, transfer = [], onPartial) {
    if (!this.worker) {
      const worker = new Worker(new URL('./voice.worker.js', import.meta.url), { type: 'module' });
      worker.onmessage = ({ data }) => {
        const job = this.jobs.get(data.id);
        if (!job) return;
        if (data.type === 'partial') {
          job.onPartial?.(data.text);
          return;
        }
        clearTimeout(job.timeout);
        this.jobs.delete(data.id);
        if (data.type === 'error') job.reject(new Error(data.message));
        else job.resolve(data);
      };
      worker.onerror = () => this.disposeWorker(new Error('The local speech engine could not start on this browser.'));
      this.worker = worker;
    }
    const id = ++this.serial;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => this.disposeWorker(new Error('The local speech engine timed out on this device.')), 120_000);
      this.jobs.set(id, { resolve, reject, timeout, onPartial });
      this.worker.postMessage({ ...message, id }, transfer);
    });
  }

  disposeWorker(error) {
    this.worker?.terminate();
    this.worker = null;
    for (const job of this.jobs.values()) {
      clearTimeout(job.timeout);
      job.reject(error);
    }
    this.jobs.clear();
  }
}
