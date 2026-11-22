import { foldSpeechWord, matchSpeech } from './align.js';

const nearbyBack = 10;
const nearbyAhead = 5;
const recoveryWordsMin = 4;
const recoveryTokensMax = 12;
const localEdits = [[1, 1], [1, 0], [0, 1], [2, 2], [2, 1], [1, 2], [0, 2], [2, 0]];
const units = 'zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen'.split(' ');
const tens = 'twenty thirty forty fifty sixty seventy eighty ninety'.split(' ');

export function englishNumberParts(word) {
  if (/^(0|[1-9][0-9]?)$/.test(word)) {
    const value = Number(word);
    if (value < 20) return [units[value]];
    const ten = tens[Math.floor(value / 10) - 2];
    return value % 10 ? [ten, units[value % 10]] : [ten];
  }
  const [ten, unit, extra] = word.split('-');
  if (!extra && tens.includes(ten) && units.indexOf(unit) > 0 && units.indexOf(unit) < 10) return [ten, unit];
  return [foldSpeechWord(word)];
}

export class VoiceCursor {
  constructor(script, position, language, { resetGuideOnForwardRecovery = true } = {}) {
    this.script = script;
    this.parts = language === 'en' ? englishNumberParts : word => [foldSpeechWord(word)];
    this.folded = [];
    this.wordStarts = new Map();
    this.wordEnds = script.map((word, index) => {
      this.wordStarts.set(this.folded.length, index);
      this.folded.push(...this.parts(word));
      return this.folded.length - 1;
    });
    this.position = Math.floor(position);
    this.shown = this.position;
    this.lastAdvance = null;
    this.recovery = null;
    this.guideAgreements = 0;
    this.resetGuideOnForwardRecovery = resetGuideOnForwardRecovery;
  }

  update(heard, evidence) {
    this.relocated = false;
    if (evidence.guided) {
      this.guide ??= new VoiceCursor(this.script, this.position, 'en');
      const folded = heard.flatMap(this.parts);
      const match = this.guide.matchFollowing(folded, evidence);
      if (match) this.guide.advance(match.next, heard, evidence, folded.slice(0, match.end));
      else if (this.guide.lastAdvance?.id !== evidence.id || folded.length > this.guide.lastAdvance.prefix.length) {
        const nearby = this.guide.matchNearby(folded, true, false);
        if (nearby !== null) this.guide.advance(nearby, heard, evidence, folded);
      }
      return this.showAhead();
    }

    const previous = this.position;
    const next = this.track(heard, evidence);
    if (next === null) return null;
    if (next < previous || this.relocated && this.resetGuideOnForwardRecovery) {
      this.guide = null;
      this.guideAgreements = 0;
      this.shown = next;
      return next;
    }
    if (this.guide) {
      const lead = this.guide.position - next;
      this.guideAgreements = lead >= 0 && lead <= 2 && next - previous <= 3 ? this.guideAgreements + 1 : 0;
      if (lead < 0) this.guide = null;
    }
    return this.showAhead();
  }

  showAhead() {
    // A guide that has repeatedly agreed with recent audio can bridge a short
    // delay in the unrestricted result. A relocation always needs open speech.
    const freshGuide = this.guide?.lastAdvance && this.lastAdvance
      && this.guide.lastAdvance.audioEnd - this.lastAdvance.audioEnd <= 18;
    const lead = this.guideAgreements >= 2 && freshGuide ? 4 : 2;
    const hint = this.recovery ? 0 : Math.min(this.guide?.position ?? 0, this.position + lead, this.script.length - 1);
    const next = Math.max(this.position, hint);
    if (next <= this.shown) return null;
    this.shown = next;
    return next;
  }

  track(heard, evidence) {
    const { partial, id, streaming } = evidence;
    if (!heard.length || !this.script.length) return null;
    const folded = heard.flatMap(this.parts);
    const following = this.matchFollowing(folded, evidence);
    if (following) return this.advance(following.next, heard, evidence, folded.slice(0, following.end));

    const nearby = this.matchNearby(folded, partial, streaming);
    if (nearby !== null && nearby > this.position) return this.advance(nearby, heard, evidence, folded);

    // Consider only newly spoken words when a hypothesis still includes old audio.
    const prior = this.lastAdvance;
    const consumed = prior?.id === id ? this.heardStart(folded, evidence) ?? prior.tokenCount : 0;
    const fresh = folded.slice(consumed);
    const exact = this.matchPassage(fresh, streaming || !prior && !partial ? 3 : recoveryWordsMin);
    if (exact && this.canRecover(exact.next, evidence, fresh.length)) {
      const previous = this.recovery;
      this.recovery = { ...exact, id, length: fresh.length, audioEnd: evidence.audioEnd };
      const growingMatch = previous?.id === id && exact.next > previous.next && exact.start <= previous.next
        && fresh.length > previous.length && evidence.audioEnd >= previous.audioEnd;
      const strongMatch = streaming && exact.next - exact.start >= 5;
      if (!partial || growingMatch || strongMatch) return this.recover(exact, heard, evidence, folded);
    } else {
      this.recovery = null;
    }
    if (partial || heard.length < 4) return null;

    // Leave fuzzy passage changes to completed results.
    let recoveryWords = heard;
    if (this.lastAdvance?.id === id) {
      if (!streaming || this.lastAdvance.length + 4 > heard.length) return null;
      recoveryWords = heard.slice(this.lastAdvance.length);
    }
    const match = matchSpeech(this.script, recoveryWords, Math.max(0, this.position - 1), { requireTail: true });
    if (!match || match.score < .78) return null;
    const next = match.end + 1;
    if (!this.canRecover(next, evidence)) return null;
    return this.recover({ start: match.start, next }, heard, evidence, folded);
  }

  recover({ start, next }, heard, evidence, folded) {
    this.relocated = next < this.position || start > this.position + nearbyAhead;
    return this.advance(next, heard, evidence, folded);
  }

  heardStart(heard, { id, streaming, audioStart }) {
    const prior = this.lastAdvance;
    if (prior?.id !== id) return prior && audioStart < prior.audioEnd - 1 ? null : 0;
    const prefix = prior.prefix;
    if (!prefix) return null;
    if (prefix.every((part, index) => heard[index] === part)) return prefix.length;
    if (!streaming || prefix.length < 2) return null;

    // Streaming hypotheses can rewrite earlier words. Reuse only the recent
    // context, and reject repeated anchors that could replay consumed audio.
    const anchor = prefix.slice(-3);
    const first = Math.max(0, prefix.length - anchor.length - 2);
    const last = Math.min(prefix.length - anchor.length + 2, heard.length - anchor.length);
    let end = null;
    for (let index = first; index <= last; index++) {
      if (!anchor.every((part, offset) => heard[index + offset] === part)) continue;
      if (end !== null) return null;
      end = index + anchor.length;
    }
    return end;
  }

  matchFollowing(heard, evidence) {
    const start = this.heardStart(heard, evidence);
    if (start === null) return null;
    const token = this.position ? this.wordEnds[this.position - 1] + 1 : 0;
    let match = this.matchRun(heard, start, token, this.position);

    if (evidence.streaming && !evidence.guided) {
      // Cross a short misread only when the words after it identify the local
      // reading path. A later, independent misread gets its own anchor.
      for (let attempt = 0; attempt < 2 && match.heardIndex < heard.length; attempt++) {
        const resumed = this.matchAfterEdit(heard, match, start);
        if (!resumed) break;
        match = resumed;
      }
    }

    const steps = match.next - this.position;
    if (!steps) return null;
    // A complete short word must work, including at the start of a new fragment.
    if (steps === 1 && evidence.partial && !evidence.streaming && this.lastAdvance?.id !== evidence.id) return null;
    return match;
  }

  matchAfterEdit(heard, match, start) {
    let best = null;
    let fewestEdits = Infinity;
    for (const [heardSkip, scriptSkip] of localEdits) {
      const edits = Math.max(heardSkip, scriptSkip);
      if (edits > fewestEdits) break;
      if (edits === 2 && match.heardIndex === start) continue;
      const tokenIndex = match.tokenIndex + scriptSkip;
      if (tokenIndex >= this.folded.length) continue;
      let word = match.next;
      while (tokenIndex > this.wordEnds[word]) word++;
      const run = this.matchRun(heard, match.heardIndex + heardSkip, tokenIndex, word);
      if (run.next - word < edits + 1) continue;
      if (best && (best.next !== run.next || best.end !== run.end)) return null;
      best = run;
      fewestEdits = edits;
    }
    return best;
  }

  matchRun(heard, heardIndex, tokenIndex, next) {
    let end = heardIndex;
    while (heardIndex < heard.length && heard[heardIndex] === this.folded[tokenIndex]) {
      if (tokenIndex === this.wordEnds[next]) {
        next++;
        end = heardIndex + 1;
      }
      heardIndex++;
      tokenIndex++;
    }
    return { next, end, heardIndex, tokenIndex };
  }

  matchPassage(heard, minimum) {
    if (heard.length < minimum) return null;
    const tail = heard.slice(-recoveryTokensMax);
    let longest = 0;
    let candidate = null;
    for (let word = 0; word < this.wordEnds.length; word++) {
      const end = this.wordEnds[word];
      let length = 0;
      while (length < tail.length && length <= end && this.folded[end - length] === tail[tail.length - 1 - length]) length++;
      while (length && !this.wordStarts.has(end - length + 1)) length--;
      if (!length) continue;
      const start = this.wordStarts.get(end - length + 1);
      if (word - start + 1 < minimum) continue;
      if (length > longest) {
        longest = length;
        candidate = { start, next: word + 1 };
      } else if (length === longest) {
        candidate = null;
      }
    }
    return candidate;
  }

  canRecover(next, { partial, id, streaming, audioStart, audioEnd }, freshLength = 0) {
    if (next === this.position) return false;
    if (next > this.position || !this.lastAdvance) return true;
    const prior = this.lastAdvance;
    if (streaming && freshLength >= 3) return this.position - next >= 2 && audioEnd > prior.audioEnd;
    return !partial && this.position - next >= 4 && prior.id !== id
      && (streaming ? audioEnd > prior.audioEnd : audioStart >= prior.audioEnd - 1);
  }

  matchNearby(heard, partial, streaming) {
    const position = this.position;
    const first = Math.max(0, position - nearbyBack);
    const last = Math.min(this.script.length - 1, position + nearbyAhead - 1);
    let longest = 0;
    let candidates = [];
    for (let word = first; word <= last; word++) {
      const end = this.wordEnds[word];
      let length = 0;
      while (length < heard.length && end >= length
        && this.folded[end - length] === heard[heard.length - 1 - length]) length++;
      if (length > longest) {
        longest = length;
        candidates = [word + 1];
      } else if (length && length === longest) {
        candidates.push(word + 1);
      }
    }
    if (candidates.length !== 1) return null;
    const next = candidates[0];
    if (next <= position) return null;
    const steps = next - position;
    if (longest >= Math.max(2, steps)) return next;
    // A distinctive single word can advance one step, but cannot skip ahead.
    const lastWord = heard.at(-1);
    if (steps === 1 && lastWord.length >= 5 && (!partial || streaming)) return next;
    return null;
  }

  advance(position, heard, { id, audioEnd }, prefix = null) {
    this.position = position;
    this.lastAdvance = { id, audioEnd, length: heard.length, tokenCount: prefix?.length ?? heard.length, prefix };
    this.recovery = null;
    return position;
  }
}
