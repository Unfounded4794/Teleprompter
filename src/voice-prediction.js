const quietFrames = 7;
const maxFrameAge = 14;
const predictionExpiry = 17;

function wordWeight(word) {
  const vowels = word.match(/[aeiouy]+/g)?.length ?? 1;
  return Math.min(1.75, .75 + .18 * vowels + .025 * word.length);
}

// The v0.5.3 speaking-pace prediction remains selectable for comparison.
export class VoicePrediction {
  constructor(words, position) {
    this.weights = words.map(wordWeight);
    this.voiced = 0;
    this.quiet = 0;
    this.reset(position);
  }

  reset(position = this.cue) {
    this.cue = position;
    this.anchor = null;
    this.pace = 0;
    this.samples = 0;
    this.prediction = null;
    return this.cue;
  }

  confirm(position, frame) {
    const previous = this.anchor;
    frame = Math.max(frame, previous?.frame ?? frame);
    if (previous && position > previous.position && position <= previous.position + 3) {
      const elapsed = frame - previous.frame;
      const weight = this.weights.slice(previous.position, position).reduce((sum, word) => sum + word, 0);
      const interval = elapsed / weight;
      if (interval >= 2 && interval <= maxFrameAge) {
        this.pace = this.samples ? this.pace * .7 + interval * .3 : interval;
        this.samples++;
      }
    } else {
      this.reset();
    }
    this.cue = position;
    this.anchor = { position, frame };
    this.prediction = null;
    return this.cue;
  }

  update(frame, speaking) {
    this.voiced = speaking ? this.voiced + 1 : 0;
    this.quiet = speaking ? 0 : this.quiet + 1;
    if (this.quiet === quietFrames) this.reset();
    const anchor = this.anchor;
    if (this.prediction !== null && frame - anchor.frame <= predictionExpiry) return this.prediction;
    this.prediction = null;
    if (!anchor || this.samples < 2 || this.voiced < 2 || anchor.position >= this.weights.length - 1) return this.cue;

    const age = frame - anchor.frame;
    const wait = Math.max(3, Math.round(this.pace * this.weights[anchor.position] * .85));
    if (age >= wait && age <= Math.min(wait + 3, maxFrameAge)) this.prediction = anchor.position + 1;
    return this.prediction ?? this.cue;
  }
}
