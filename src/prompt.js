import { markWords, sanitizeScript } from './script.js';
import { normalizeDisplay } from './display-settings.js';
import { VoiceScroll } from './voice-scroll.js';

const fonts = {
  sans: '"Inter Variable", Inter, sans-serif',
  serif: 'Georgia, serif',
  mono: 'ui-monospace, monospace',
};

export class Prompt {
  constructor(stage, content, motion, guide) {
    this.stage = stage;
    this.content = content;
    this.readingArea = motion.parentElement;
    this.motion = motion;
    this.guide = guide;
    this.elements = [];
    this.words = [];
    this.paragraphs = [];
    this.pauses = [];
    this.lines = [];
    this.lineByWord = [];
    this.position = 0;
    this.y = null;
    this.active = -1;
    this.voiceScroll = new VoiceScroll();
    this.voiceMatch = null;
    this.resizeObserver = new ResizeObserver(() => this.measure());
    this.resizeObserver.observe(stage);
    this.resizeObserver.observe(this.readingArea);
    this.resizeObserver.observe(content);
    document.fonts.ready.then(() => this.measure());
  }

  setScript(html) {
    this.resetVoiceScroll();
    this.content.innerHTML = sanitizeScript(html);
    const { elements, words, paragraphs, pauses } = markWords(this.content);
    this.elements = elements;
    this.words = words;
    this.paragraphs = paragraphs;
    this.pauses = pauses;
    this.lines = [];
    this.lineByWord = [];
    this.active = -1;
    this.y = null;
    if (!words.length) {
      const message = document.createElement('p');
      message.className = 'prompt-empty';
      message.textContent = 'Your script appears here.';
      this.content.replaceChildren(message);
    }
    this.measure();
  }

  appearance(settings, flipX, flipY) {
    this.settings = normalizeDisplay(settings);
    settings = this.settings;
    this.stage.style.setProperty('--flip-x', flipX ? -1 : 1);
    this.stage.style.setProperty('--flip-y', flipY ? -1 : 1);
    this.stage.style.setProperty('--guide-thickness', settings.guideThickness + 'px');
    this.stage.style.setProperty('--arrow-size', settings.arrowSize + 'px');
    const left = settings.marginLeft + Math.max(0, 2 * settings.readingX);
    const right = settings.marginRight + Math.max(0, -2 * settings.readingX);
    const scale = Math.min(1, 85 / (left + right));
    this.motion.style.left = (flipX ? right : left) * scale + '%';
    this.motion.style.right = (flipX ? left : right) * scale + '%';
    this.stage.style.setProperty('--prompt-font', fonts[settings.font] || fonts.sans);
    this.stage.style.setProperty('--prompt-font-size', settings.size + 'px');
    this.guide.hidden = !settings.guide;
    this.measure();
  }

  measure() {
    if (!this.stage.clientWidth) return;
    const voiceWord = this.voiceMatch === null ? null : this.positionAtCenter(this.voiceScroll.position);
    const previousMatch = this.voiceMatch === null ? null : this.positionAtCenter(this.voiceScroll.match);
    const contentRect = this.content.getBoundingClientRect();
    const reversed = this.stage.style.getPropertyValue('--flip-y') === '-1';
    const lines = [];
    const lineByWord = [];
    const size = parseFloat(getComputedStyle(this.content).fontSize) || 40;
    this.lineHeight = parseFloat(getComputedStyle(this.content).lineHeight) || size * 1.34;
    for (const [index, word] of this.elements.entries()) {
      const rect = word.getBoundingClientRect();
      const center = reversed
        ? contentRect.bottom - (rect.top + rect.height / 2)
        : rect.top + rect.height / 2 - contentRect.top;
      const line = lines.at(-1);
      if (!line || center - line.center > size * .61) {
        lines.push({ center, start: index, end: index });
      } else {
        line.end = index;
      }
      lineByWord[index] = lines.length - 1;
    }
    this.lines = lines;
    this.lineByWord = lineByWord;
    this.updateShade();
    if (voiceWord !== null) {
      const target = this.voiceCenter(this.voiceMatch);
      const offsetChange = target - this.centerAt(previousMatch, false);
      const first = this.lines[0]?.center ?? 0;
      const last = this.lines.at(-1)?.center ?? first;
      const center = Math.min(last, Math.max(first, this.centerAt(voiceWord, false) + offsetChange));
      this.voiceScroll.reframe(center, target, performance.now());
      this.render(this.position, Boolean(this.highlight), 1, this.voiceScroll.position);
    } else {
      this.render(this.position, Boolean(this.highlight));
    }
  }

  updateShade() {
    const settings = this.settings || normalizeDisplay();
    const height = this.readingArea.clientHeight;
    this.readingHeight = height;
    const lineHeight = parseFloat(getComputedStyle(this.content).lineHeight) || settings.size * 1.34;
    const middle = height * settings.readingY / 100;
    this.guide.style.top = this.readingArea.offsetTop + middle + 'px';
    const halfWindow = lineHeight * settings.focusLines / 2;
    this.stage.dataset.shade = settings.shade;
    this.stage.style.setProperty('--shade-opacity', settings.shadeOpacity / 100);
    this.stage.style.setProperty('--focus-top', Math.max(0, middle - halfWindow) + 'px');
    this.stage.style.setProperty('--focus-bottom', Math.min(height, middle + halfWindow) + 'px');
    this.stage.style.setProperty('--fade-top', Math.max(0, middle - halfWindow - lineHeight * 1.5) + 'px');
    this.stage.style.setProperty('--fade-bottom', Math.min(height, middle + halfWindow + lineHeight * 1.5) + 'px');
  }

  centerAt(position, highlight = this.highlight) {
    const word = Math.max(0, Math.min(this.words.length - 1, Math.floor(position)));
    const lineIndex = this.lineByWord[word];
    const line = this.lines[lineIndex];
    if (!line) return 0;
    const next = this.lines[lineIndex + 1];
    const advance = next ? next.center - line.center : this.lineHeight;
    const progress = Math.min(1, Math.max(0, (position - line.start) / (line.end - line.start + 1)));
    if (!highlight) return line.center + advance * progress;
    if (this.settings?.focusLines === 1 || this.settings?.highlightWords === false) return line.center;

    // Move a fraction of a line per confirmed word. Keep the active line by
    // the guide and avoid drifting into the whitespace between paragraphs.
    const middle = (word - line.start + .5) / (line.end - line.start + 1) - .5;
    const previous = this.lines[lineIndex - 1];
    const span = middle < 0 ? previous && line.center - previous.center : next && advance;
    return line.center + middle * Math.min(span || 0, this.lineHeight * .72);
  }

  positionAfterDrag(delta, start) {
    const direction = this.stage.style.getPropertyValue('--flip-y') === '-1' ? -1 : 1;
    return this.positionAtCenter(this.centerAt(start, false) - delta * direction);
  }

  advance(position, pixels) {
    return this.positionAtCenter(this.centerAt(position, false) + pixels);
  }

  distance(position) {
    return this.centerAt(position, false) - (this.lines[0]?.center ?? 0);
  }

  positionAtCenter(center) {
    if (!this.lines.length) return 0;
    let index = 0;
    let end = this.lines.length;
    while (index + 1 < end) {
      const middle = Math.floor((index + end) / 2);
      if (this.lines[middle].center <= center) index = middle;
      else end = middle;
    }
    const line = this.lines[index];
    const advance = this.lines[index + 1] ? this.lines[index + 1].center - line.center : this.lineHeight;
    const fraction = Math.min(1, Math.max(0, (center - line.center) / advance));
    return Math.min(this.words.length, line.start + fraction * (line.end - line.start + 1));
  }

  lineAtWord(position) {
    const index = this.lineByWord[Math.min(this.words.length - 1, Math.max(0, Math.floor(position)))];
    if (index === undefined) return 0;
    const line = this.lines[index];
    return Math.min(this.lines.length - 1, index + (position - line.start) / (line.end - line.start + 1));
  }

  renderVoiceScroll(position, match, speaking, now, highlight = true) {
    this.voiceMatch = match;
    const first = this.lines[0]?.center ?? 0;
    const last = this.lines.at(-1)?.center ?? first;
    const smoothing = this.settings?.voiceScrollSmoothing ?? 60;
    const center = this.voiceScroll.update(this.voiceCenter(match), first, last, this.lineHeight || 40, speaking, now, smoothing);
    this.render(position, highlight, 1, center);
  }

  voiceCenter(match) {
    const lastLine = Math.max(0, this.lines.length - 1);
    const offset = this.settings?.voiceLineOffset ?? 0;
    const line = Math.max(0, Math.min(lastLine, this.lineAtWord(match) + offset));
    const first = this.lines[Math.floor(line)]?.center ?? 0;
    const next = this.lines[Math.ceil(line)]?.center ?? first;
    return first + (next - first) * (line % 1);
  }

  resetVoiceScroll() {
    this.voiceScroll.reset();
    this.voiceMatch = null;
  }

  render(position, highlight, smoothing = 1, lineCenter = null) {
    if (lineCenter === null && this.voiceMatch !== null) this.resetVoiceScroll();
    this.position = position;
    this.highlight = highlight;
    const word = Math.max(0, Math.min(this.words.length - 1, Math.floor(position)));
    const center = lineCenter ?? this.centerAt(position);
    const settings = this.settings || normalizeDisplay();
    const height = this.readingHeight || 0;
    const physicalAnchor = height * settings.readingY / 100;
    const reversed = this.stage.style.getPropertyValue('--flip-y') === '-1';
    const targetY = (reversed ? height - physicalAnchor : physicalAnchor) - center;
    const gap = targetY - this.y;
    const reposition = highlight && Math.abs(gap) > this.lineHeight * 1.75;
    this.y = this.y === null || reposition ? targetY : this.y + gap * smoothing;
    this.needsFrame = Math.abs(this.y - targetY) > .1;
    this.motion.style.transform = 'translate3d(0,' + this.y.toFixed(2) + 'px,0)';
    const nextActive = highlight && settings.highlightWords && position < this.words.length ? word : -1;
    if (this.active !== nextActive) {
      this.elements[this.active]?.classList.remove('active');
      this.elements[nextActive]?.classList.add('active');
      this.active = nextActive;
    }
  }
}
