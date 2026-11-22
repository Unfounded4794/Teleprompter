export const displayDefaults = {
  size: 42, font: 'sans', guide: true, highlightWords: true, shade: 'gradient', shadeOpacity: 85,
  focusLines: 3, guideThickness: 1, arrowSize: 8, readingY: 50, readingX: 0, tapPause: true,
  marginLeft: 10, marginRight: 10,
  voiceScroll: false, voiceLineOffset: 0, voiceScrollSmoothing: 60,
};

const limits = {
  size: [20, 160], shadeOpacity: [0, 100], focusLines: [1, 12], guideThickness: [0, 8],
  arrowSize: [0, 28], readingY: [10, 90], readingX: [-25, 25], marginLeft: [0, 40], marginRight: [0, 40],
  voiceLineOffset: [-2, 2], voiceScrollSmoothing: [0, 100],
};

export function normalizeDisplay(value = {}) {
  const result = { ...displayDefaults };
  for (const [key, [min, max]] of Object.entries(limits)) {
    if (Number.isFinite(value[key])) result[key] = Math.min(max, Math.max(min, value[key]));
  }
  if (['sans', 'serif', 'mono'].includes(value.font)) result.font = value.font;
  if (['none', 'gradient', 'mask'].includes(value.shade)) result.shade = value.shade;
  result.guide = value.guide !== false;
  result.highlightWords = value.highlightWords !== false;
  result.voiceScroll = value.voiceScroll === true;
  result.tapPause = value.tapPause !== false;
  return result;
}
