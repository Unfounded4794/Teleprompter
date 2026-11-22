const framesPerSecond = 20;
const startPace = 4.7;
const minDwell = 2;
const maxUnconfirmedTime = 1.65 * framesPerSecond;

function wordWeight(word) {
  const vowels = word.match(/[aeiouy]+/g)?.length ?? 1;
  return Math.min(1.75, .8 + .14 * vowels + .025 * word.length);
}

export class VoicePace {
  constructor(words, position = 0, pauses = []) {
    // Prefix weights let a batch of matches update the pace in constant time.
    this.weights = [0];
    for (const word of words) this.weights.push(this.weights.at(-1) + wordWeight(word));
    this.length = words.length;
    this.pauses = new Set(pauses);
    this.speechFrames = new Int32Array(128);
    this.speechTime = 0;
    this.latestFrame = 0;
    this.reset(position);
  }

  reset(position) {
    this.cue = position;
    this.anchor = { position, frame: null };
    this.pace = startPace;
    this.voiced = 0;
    this.lastVoice = -Infinity;
    this.lastStep = -Infinity;
    this.waitingForMatch = false;
  }

  confirm(position, frame, relocated = false) {
    const elapsed = frame - this.anchor.frame;
    const distance = position - this.anchor.position;
    const plausibleProgress = this.anchor.frame !== null && distance <= 3 + elapsed / Math.max(2, this.pace * .55);
    if (distance < 0 || relocated && !plausibleProgress) this.reset(position);
    const previous = this.anchor;
    if (previous.frame !== null && position > previous.position && frame > previous.frame) {
      const span = this.weights[position] - this.weights[previous.position];
      const measured = this.elapsedSpeech(previous.frame, frame) / span;
      if (measured >= 2 && measured <= 12) {
        const adjustment = measured < this.pace ? .35 : .12;
        this.pace += (Math.min(measured, this.pace * 1.5) - this.pace) * adjustment;
      }
    }
    this.anchor = { position, frame: Math.max(frame, previous.frame ?? frame) };
    this.waitingForMatch = false;
    return this.cue;
  }

  elapsedSpeech(from, to) {
    if (to > this.latestFrame || this.latestFrame - from >= this.speechFrames.length) return to - from;
    return this.speechFrames[to % this.speechFrames.length] - this.speechFrames[from % this.speechFrames.length];
  }

  waitForMatch() {
    this.waitingForMatch = true;
  }

  update(frame, speaking) {
    if (speaking) {
      if (frame - this.lastVoice > 2) this.voiced = 0;
      this.voiced++;
      this.lastVoice = frame;
    }
    if (frame - this.lastVoice <= 2) this.speechTime++;
    this.latestFrame = frame;
    this.speechFrames[frame % this.speechFrames.length] = this.speechTime;
    if (this.cue >= this.length || this.waitingForMatch) return this.cue;

    const following = this.anchor.frame !== null;
    const active = this.voiced >= 2 && frame - this.lastVoice <= 1;
    const fresh = following && frame - this.anchor.frame <= maxUnconfirmedTime;
    const fast = this.pace < 4.2;
    const lead = fresh ? fast ? 8 : 6 : following ? 0 : 1;
    const limit = active && lead ? Math.max(this.anchor.position,
      Math.min(this.length - 1, this.anchor.position + lead)) : this.anchor.position;
    if (this.cue >= limit) return this.cue;

    // Recognition changes the pace and how far the guide can run. The cue
    // itself always steps through the words at their on-screen reading rhythm.
    const reading = Math.max(0, this.cue - 1);
    const weight = this.weights[reading + 1] - this.weights[reading];
    // The word match typically arrives after it was spoken. Keep the guide
    // slightly ahead of that match and ease back to the reader's usual pace.
    const lag = this.anchor.position + (fast ? 3 : 2) - this.cue;
    const catchUp = lag >= 3 ? .43 : lag === 2 ? .59 : lag === 1 ? .73 : lag === 0 ? .94 : 1.15;
    const pause = this.pauses.has(this.cue) && this.cue > this.anchor.position + 1 ? (fast ? 3 : 6) : 0;
    const dwell = Math.max(minDwell, pause, Math.round(this.pace * weight * catchUp));
    if (frame - this.lastStep >= dwell) {
      this.cue++;
      this.lastStep = frame;
    }
    return this.cue;
  }
}
