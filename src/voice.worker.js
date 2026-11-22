import { env, AutoTokenizer, AutoProcessor, WhisperForConditionalGeneration, WhisperTextStreamer } from '@huggingface/transformers';
import { paddedSpeechFeatures } from './voice-features.js';

env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = new URL('/models/', self.location.origin).href;
env.useBrowserCache = false;
// The service worker serves our prepared runtime directly, without a blob import or a second binary buffer.
env.useWasmCache = false;
env.useCustomCache = true;
env.customCache = {
  match: async request => {
    const cache = await caches.open('teleprompter-models-v2');
    return cache.match(new URL(request, env.localModelPath).href);
  },
  put: async () => {},
};
env.backends.onnx.wasm.numThreads = 1;
env.backends.onnx.wasm.proxy = false;

let transcriber;
let loaded;
let work = Promise.resolve();
self.onmessage = ({ data }) => { work = work.then(() => handle(data)); };

async function handle(data) {
  try {
    if (data.type === 'load') {
      if (data.model !== loaded) {
        await transcriber?.dispose();
        transcriber = null;
        loaded = null;
        const device = data.dtype === 'q4f16' ? 'webgpu' : 'wasm';
        env.backends.onnx.wasm.numThreads = device === 'wasm' ? data.threads : 1;
        const suffix = device === 'webgpu' ? '.asyncify' : '';
        env.backends.onnx.wasm.wasmPaths = {
          mjs: new URL('/runtime/ort-wasm-simd-threaded' + suffix + '.mjs', self.location.origin).href,
          wasm: new URL('/runtime/ort-wasm-simd-threaded' + suffix + '.wasm', self.location.origin).href,
        };
        if (device === 'webgpu') {
          const adapter = await self.navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' });
          if (!adapter?.features.has('shader-f16')) {
            throw new Error('High accuracy needs a browser with WebGPU float16. Choose Lightweight on older phones.');
          }
        }
        const options = {
          dtype: data.dtype, device, local_files_only: true,
          session_options: { enableCpuMemArena: false, enableMemPattern: false },
        };
        const [tokenizer, processor] = await Promise.all([
          AutoTokenizer.from_pretrained(data.model, options),
          AutoProcessor.from_pretrained(data.model, options),
        ]);
        const model = await WhisperForConditionalGeneration.from_pretrained(data.model, options);
        transcriber = { model, tokenizer, extractor: processor.feature_extractor, dispose: () => model.dispose() };
        loaded = data.model;
      }
      self.postMessage({ id: data.id, type: 'loaded' });
    }
    if (data.type === 'audio') {
      if (!transcriber) throw new Error('Prepare the local speech model first.');
      const { model, tokenizer, extractor } = transcriber;
      const inputs = await paddedSpeechFeatures(extractor, data.samples);
      let partial = '';
      let lastSent = '';
      const streamer = new WhisperTextStreamer(tokenizer, {
        skip_prompt: true,
        callback_function: fragment => {
          partial += fragment;
          const text = partial.trim();
          if (text && text !== lastSent) {
            lastSent = text;
            self.postMessage({ id: data.id, type: 'partial', text });
          }
        },
      });
      try {
        const result = await model.generate({
          inputs, language: data.language, task: 'transcribe', return_timestamps: false,
          max_new_tokens: 40, num_frames: Math.floor(data.samples.length / extractor.config.hop_length),
          streamer,
        });
        const text = tokenizer.decode(result[0].tolist(), { skip_special_tokens: true }).trim();
        result.dispose();
        self.postMessage({ id: data.id, type: 'transcript', text });
      } finally {
        inputs.dispose();
      }
    }
  } catch (error) {
    console.error(error);
    self.postMessage({ id: data.id, type: 'error', message: error.message || 'Speech recognition failed.' });
  }
}
