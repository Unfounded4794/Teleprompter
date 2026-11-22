import { Tensor } from '@huggingface/transformers';

export async function paddedSpeechFeatures(extractor, audio) {
  const { hop_length: hop, n_fft: fft, n_samples: fullSamples, nb_max_frames: fullFrames } = extractor.config;
  // A few zero samples beyond the FFT window give us the same silence value as
  // a full waveform pad, without running the FFT over the rest of the 30 seconds.
  const length = Math.min(fullSamples, Math.ceil((audio.length + fft + hop) / hop) * hop);
  const { input_features: signal } = await extractor(audio, { max_length: length });
  const [, bands, frames] = signal.dims;
  if (frames >= fullFrames) return signal;
  const data = new Float32Array(bands * fullFrames);
  for (let band = 0; band < bands; band++) {
    const start = band * frames;
    const output = band * fullFrames;
    data.set(signal.data.subarray(start, start + frames), output);
    data.fill(signal.data[start + frames - 1], output + frames, output + fullFrames);
  }
  signal.dispose();
  return new Tensor('float32', data, [1, bands, fullFrames]);
}
