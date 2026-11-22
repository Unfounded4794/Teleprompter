class TeleprompterPcm extends AudioWorkletProcessor {
  constructor({ processorOptions }) {
    super();
    this.step = sampleRate / 16000;
    this.next = 0;
    this.previous = 0;
    this.frameSize = processorOptions.frameSize;
    this.frame = new Float32Array(this.frameSize);
    this.index = 0;
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input?.length) return true;
    while (this.next < input.length - 1) {
      const left = Math.floor(this.next);
      const part = this.next - left;
      const first = left < 0 ? this.previous : input[left];
      this.frame[this.index++] = first + ((input[left + 1] ?? first) - first) * part;
      if (this.index === this.frame.length) {
        this.port.postMessage(this.frame, [this.frame.buffer]);
        this.frame = new Float32Array(this.frameSize);
        this.index = 0;
      }
      this.next += this.step;
    }
    this.next -= input.length;
    this.previous = input[input.length - 1];
    return true;
  }
}
registerProcessor('teleprompter-pcm', TeleprompterPcm);
