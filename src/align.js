const MAX_WORDS = 15;

export function foldSpeechWord(word) {
  return word.normalize('NFD').replace(/\p{M}/gu, '').replace(/[-']/g, '');
}

function spellingCost(left, right) {
  if (left === right) return 0;
  const length = Math.max(left.length, right.length);
  const limit = Math.floor(length * .36);
  if (Math.min(left.length, right.length) < 4 || Math.abs(left.length - right.length) > limit) return 1;
  let row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let index = 0; index < left.length; index++) {
    const next = [index + 1];
    for (let col = 1; col <= right.length; col++) {
      next.push(Math.min(row[col] + 1, next[col - 1] + 1, row[col - 1] + Number(left[index] !== right[col - 1])));
    }
    row = next;
  }
  return row[right.length] <= limit ? .28 + .85 * row[right.length] / length : 1;
}

function distance(costs, mergedSpeech, mergedScript, start, length) {
  const rows = [Array.from({ length: length + 1 }, (_, index) => index)];
  for (let index = 0; index < costs.length; index++) {
    const row = rows[index];
    const next = [index + 1];
    for (let col = 1; col <= length; col++) {
      const word = start + col - 1;
      let cost = Math.min(row[col] + 1, next[col - 1] + 1, row[col - 1] + costs[index][word]);
      if (index > 0) cost = Math.min(cost, rows[index - 1][col - 1] + mergedSpeech[index][word]);
      if (col > 1) cost = Math.min(cost, row[col - 2] + mergedScript[index][word]);
      next.push(cost);
    }
    rows.push(next);
  }
  return rows.at(-1)[length];
}

export function matchSpeech(script, transcript, position, { requireTail = false } = {}) {
  const heard = transcript.slice(-MAX_WORDS);
  if (heard.length < 2 || !script.length) return null;
  const nearby = Math.round(position);
  const first = Math.max(0, nearby - 100);
  const last = Math.min(script.length, nearby + 190);
  const reference = script.slice(first, last);
  const referenceFolded = reference.map(foldSpeechWord);
  const heardFolded = heard.map(foldSpeechWord);
  const costs = heard.map((word, row) => reference.map((expected, col) => {
    if (word === expected) return 0;
    if (heardFolded[row] === referenceFolded[col]) return .16;
    return spellingCost(heardFolded[row], referenceFolded[col]);
  }));
  const mergedSpeech = heardFolded.map((word, row) => referenceFolded.map(expected =>
    row ? .16 + spellingCost(heardFolded[row - 1] + word, expected) : Infinity,
  ));
  const mergedScript = heardFolded.map(word => referenceFolded.map((expected, col) =>
    col ? .16 + spellingCost(word, referenceFolded[col - 1] + expected) : Infinity,
  ));
  const tolerance = Math.min(4, Math.floor(heard.length / 3));
  const candidates = [];
  for (let length = Math.max(2, heard.length - tolerance); length <= heard.length + tolerance; length++) {
    for (let start = first; start + length <= last; start++) {
      const end = start + length - 1;
      if (heard.length === 2 && (start < nearby - 3 || start > nearby + 6)) continue;
      if (requireTail && costs.at(-1)[end - first] > .48
        && mergedSpeech.at(-1)[end - first] > .48
        && mergedScript.at(-1)[end - first] > .48) continue;
      const score = 1 - distance(costs, mergedSpeech, mergedScript, start - first, length) / Math.max(heard.length, length);
      const distancePenalty = Math.min(.18, Math.abs(start - nearby) / 600);
      candidates.push({ start, end, score, rank: score - distancePenalty });
    }
  }
  candidates.sort((a, b) => b.rank - a.rank);
  const best = candidates[0];
  if (!best) return null;
  const minimum = heard.length <= 3 ? .86 : best.start < nearby - 6 ? .76 : .62;
  if (best.score < minimum) return null;
  const rival = candidates.find(candidate => Math.abs(candidate.end - best.end) >= Math.max(4, heard.length / 2));
  if (rival && best.rank - rival.rank < .055) return null;
  // Window overlap can repeat a word or two. Rewind only after distinct evidence.
  if (best.end < nearby && (nearby - best.end < 3 || heard.length < 4)) return null;
  return best;
}
