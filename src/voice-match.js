export const maxWordLead = 6;

export class VoiceMatch {
  constructor(length, position, lead) {
    this.length = length;
    this.lead = lead;
    this.reset(position);
  }

  reset(position) {
    this.cue = position;
    this.target = position;
    this.matched = null;
    this.lastStep = -Infinity;
  }

  confirm(position, frame, relocated) {
    this.matched = position;
    this.target = this.offsetPosition(position);
    if (relocated) {
      this.cue = this.target;
      this.lastStep = frame;
    }
    return this.cue;
  }

  setLead(lead) {
    this.lead = lead;
    if (this.matched !== null) this.cue = this.target = this.offsetPosition(this.matched);
    return this.cue;
  }

  offsetPosition(position) {
    if (position === this.length && this.lead > 0) return this.length;
    return Math.max(0, Math.min(this.length - 1, position - 1 + this.lead));
  }

  update(frame) {
    // The recognizer can return a batch. Show intervening script words in order,
    // at most once per 50 ms. Never move beyond the match and the selected lead.
    if (this.cue < this.target && frame - this.lastStep >= 2) {
      this.cue++;
      this.lastStep = frame;
    }
    return this.cue;
  }
}
