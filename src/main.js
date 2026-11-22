import './style.css';
import {
  createIcons, ArrowUpRight, AudioLines, Bold, Check, ChevronDown, Download, FilePlus2, FileText, FileUp,
  FlipHorizontal2, FlipVertical2, Gauge, Italic, List, Maximize2, Minimize2, Monitor,
  Pause, Play, Radio, RotateCcw, Settings2, SkipBack, SkipForward, Timer, Underline, Undo2, Upload, X,
} from 'lucide';
import { Prompt } from './prompt.js';
import { plainHtml, sanitizeScript, tokenize } from './script.js';
import { DisplaySync, watchDisplay } from './sync.js';
import { Voice } from './voice.js';
import { VoiceCursor } from './voice-cursor.js';
import { VoiceMatch, maxWordLead } from './voice-match.js';
import { VoicePace } from './voice-pace.js';
import { VoicePrediction } from './voice-prediction.js';
import { displayDefaults, normalizeDisplay } from './display-settings.js';
import { touchControls } from './touch-controls.js';

createIcons({
  nameAttr: 'data-icon',
  icons: {
    ArrowUpRight, AudioLines, Bold, Check, ChevronDown, Download, FilePlus2, FileText, FileUp, FlipHorizontal2, FlipVertical2,
    Gauge, Italic, List, Maximize2, Minimize2, Monitor, Pause, Play, Radio, RotateCcw, Settings2,
    SkipBack, SkipForward, Timer, Underline, Undo2, Upload, X,
  },
  attrs: { 'aria-hidden': 'true' },
});
const $ = id => document.getElementById(id);
const stage = $('stage');
const prompt = new Prompt(stage, $('prompt-copy'), $('prompt-motion'), $('guide'));
const params = new URLSearchParams(location.search);
const linkValue = key => /^[a-f0-9]{32}$/.test(params.get(key) || '') ? params.get(key) : '';
const localDisplay = linkValue('display');
const pairedDisplay = linkValue('pair');
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
const voiceScrollBlend = elapsed => reduceMotion.matches ? 1 : 1 - .5 ** (elapsed / .045);
const speedMin = 5;
const speedMax = 1200;

const defaults = {
  speed: 40,
  slow: 20,
  ...displayDefaults,
  wheel: 'speed',
  wheelStep: 20,
  language: 'en',
  model: matchMedia('(pointer:coarse)').matches ? 'tiny' : 'base',
  voiceFollow: 'match',
  wordLead: 1,
  flipX: false,
  flipY: false,
};
const defaultShortcuts = {
  play: 'Space', faster: 'ArrowUp', slower: 'ArrowDown', temporary: 'ShiftLeft', previous: 'ArrowLeft', next: 'ArrowRight',
  first: 'Home', last: 'End', larger: 'Equal', smaller: 'Minus',
};
const shortcutLabels = {
  play: 'Play or pause',
  faster: 'Increase speed',
  slower: 'Decrease speed',
  temporary: 'Hold to slow',
  previous: 'Previous paragraph',
  next: 'Next paragraph',
  first: 'Start of script', last: 'End of script', larger: 'Increase text size', smaller: 'Decrease text size',
};
const displayFields = {
  'shade-opacity': 'shadeOpacity', 'focus-lines': 'focusLines', 'guide-thickness': 'guideThickness',
  'arrow-size': 'arrowSize', 'reading-y': 'readingY', 'reading-x': 'readingX',
  'margin-left': 'marginLeft', 'margin-right': 'marginRight',
  'voice-line-offset': 'voiceLineOffset',
  'voice-scroll-smoothing': 'voiceScrollSmoothing',
};
const sample = {
  title: 'Welcome to Teleprompter',
  html: '<p><strong>Ready when you are.</strong></p><p>The best takes feel like a conversation. Keep your eyes up, take a breath, and speak at your own pace.</p><p>Replace this sample with your own script. When you’re ready, press Space to start scrolling.</p>',
};

function initStudio() {
  const editor = $('editor');
  const title = $('script-title');
  const playButton = $('play');
  const speedSlider = $('speed');
  const seek = $('seek');
  const pairDialog = $('pair-dialog');
  const selection = document.getSelection();
  const saved = readStorage('teleprompter-studio');
  const script = {
    title: typeof saved.title === 'string' ? saved.title : sample.title,
    html: sanitizeScript(typeof saved.html === 'string' ? saved.html : sample.html),
  };
  const settings = normalizedSettings(saved.settings);
  const shortcuts = { ...defaultShortcuts, ...saved.shortcuts };
  let mode = saved.mode === 'voice' ? 'voice' : 'timed';
  let position = finite(saved.position, 0);
  let running = false;
  let starting = false;
  let preparingVoice = false;
  let hold = false;
  let scriptVersion = 0;
  let pendingSelection = null;
  let binding = null;
  let voiceStatusToken = 0;
  let timer = null;
  let nextPublish = 0;
  let nextKeepAlive = 0;
  let lastFrame = performance.now();
  let lastMotionState = '';
  let voiceCursor = null;
  let voiceGuide = null;
  let pacedCue = null;
  let lastCueAdvance = 0;
  let lastSpeech = -Infinity;
  let publishedSpeaking = false;
  let voiceSeek = 0;
  let monitorWindow;
  let pairing = false;
  let startingPair = false;
  let view = 'edit';
  const voice = new Voice({
    status: message => { $('voice-status').textContent = message; },
    level: value => { $('mic-level').value = value; },
    transcript: followSpeech,
    speechFrame: advanceVoiceCue,
    behind: () => { $('voice-status').textContent = 'This model is falling behind. A lighter model may follow faster.'; },
    failure: message => {
      pause();
      $('voice-status').textContent = message;
      toast(message);
    },
  });
  if (voice.interrupted) {
    settings.model = 'tiny';
    $('voice-recovery').hidden = false;
    $('voice-recovery').textContent = 'The previous voice session was interrupted. Lightweight is selected to reduce memory use. Timed prompting is available at any time.';
  }
  const sync = new DisplaySync((error, ended) => {
    const changed = $('pair-status').textContent !== error;
    $('pair-status').textContent = error;
    if (!pairDialog.open && pairing && changed) toast(error);
    if (ended) {
      pairing = false;
      showPairState();
    }
  }, applyControl, count => {
    $('pair-status').textContent = count ? count + (count === 1 ? ' display connected.' : ' displays connected.') : 'Waiting for a display to join with this code.';
  });

  title.value = script.title;
  editor.innerHTML = script.html;
  $('voice-language').value = settings.language;
  updateVoiceLanguage();
  $('voice-model').value = settings.model;
  syncFollowFields();
  speedSlider.value = settings.speed;
  syncDisplayFields();
  renderScript(false);
  updateControls();
  refreshVoiceStatus();
  requestAnimationFrame(tick);
  // Keep a paused session responsive even when a second-monitor window has focus.
  setInterval(() => {
    const now = performance.now();
    if (running && now - lastFrame > 300) updatePlayback(now);
    if (pairing && now >= nextKeepAlive) publish();
    if (monitorWindow?.closed) {
      monitorWindow = null;
      showPairState();
    }
  }, 500);

  function renderScript(reset) {
    if (reset) position = 0;
    if (running || starting) pause();
    prompt.setScript(script.html);
    position = clamp(position, 0, prompt.words.length);
    voiceCursor = null;
    scriptVersion++;
    seek.max = Math.max(1, prompt.words.length);
    $('word-count').textContent = prompt.words.length + (prompt.words.length === 1 ? ' word' : ' words');
    updateAppearance();
    tickProgress();
    updateControls();
    publish();
  }

  function updateAppearance() {
    prompt.appearance(settings, settings.flipX, settings.flipY);
    for (const axis of ['x', 'y']) {
      const active = axis === 'x' ? settings.flipX : settings.flipY;
      $('flip-' + axis).setAttribute('aria-pressed', String(active));
      $('display-flip-' + axis).setAttribute('aria-pressed', String(active));
    }
  }

  function switchView(next, focus = false) {
    if (next === 'edit' && (running || starting)) pause();
    view = next;
    $('edit-view').hidden = next !== 'edit';
    $('prompt-view').hidden = next !== 'prompt';
    $('edit-tab').setAttribute('aria-pressed', String(next === 'edit'));
    $('prompt-tab').setAttribute('aria-pressed', String(next === 'prompt'));
    if (next === 'prompt') {
      updateAppearance();
      prompt.render(pacedCue ?? position, mode === 'voice' && (running || position > 0));
      tickProgress();
      if (focus) stage.focus({ preventScroll: true });
    }
  }

  function tick(now) {
    updatePlayback(now);
    requestAnimationFrame(tick);
  }

  function updatePlayback(now) {
    const elapsed = Math.max(0, (now - lastFrame) / 1000);
    lastFrame = now;
    if (running && mode === 'timed') {
      position = prompt.advance(position, effectiveSpeed() * elapsed);
      if (position >= prompt.words.length) pause();
    }
    const highlight = mode === 'voice' && (running || position > 0);
    const displayed = pacedCue ?? position;
    const continuous = mode === 'voice' && settings.voiceScroll;
    const speaking = continuous && voiceSpeaking(now);
    const key = displayed.toFixed(3) + ':' + highlight;
    if (continuous) prompt.renderVoiceScroll(displayed, position, speaking, now, highlight);
    else if (key !== lastMotionState || prompt.needsFrame || prompt.voiceMatch !== null) {
      prompt.render(displayed, highlight, mode === 'voice' ? voiceScrollBlend(elapsed) : 1);
    }
    if (key !== lastMotionState) {
      tickProgress();
      lastMotionState = key;
    }
    if (running && (now >= nextPublish || speaking !== publishedSpeaking)) publish();
  }

  function voiceSpeaking(now) {
    return running && mode === 'voice' && now - lastSpeech < 300;
  }

  function tickProgress() {
    const displayed = pacedCue ?? position;
    const elapsed = asTime(prompt.distance(displayed) / settings.speed);
    const duration = asTime(prompt.distance(prompt.words.length) / settings.speed);
    seek.value = displayed;
    paintRange(seek);
    $('current-time').textContent = elapsed;
    $('stage-position').textContent = elapsed;
    $('duration').textContent = duration;
  }

  function effectiveSpeed() {
    return hold ? Math.min(settings.speed, settings.slow) : settings.speed;
  }

  function updateControls() {
    const selectedVoice = mode === 'voice';
    const speed = effectiveSpeed();
    speedSlider.value = settings.speed;
    paintRange(speedSlider);
    $('speed-value').replaceChildren(document.createTextNode(speed + ' '), makeSmall('px/s'));
    $('timed-mode').setAttribute('aria-pressed', String(!selectedVoice));
    $('voice-mode').setAttribute('aria-pressed', String(selectedVoice));
    $('timed-controls').hidden = selectedVoice;
    $('voice-controls').hidden = !selectedVoice;
    $('microphone-feedback').hidden = !selectedVoice || !running;
    playButton.classList.toggle('playing', running || starting);
    playButton.disabled = prompt.words.length === 0 || (selectedVoice && preparingVoice);
    $('play-label').textContent = starting ? 'Cancel' : running ? 'Pause' : selectedVoice ? 'Start listening' : 'Start prompting';
    $('expanded-play').disabled = playButton.disabled;
    $('expanded-play').classList.toggle('playing', running || starting);
    $('expanded-play').setAttribute('aria-label', $('play-label').textContent);
    $('expanded-play').title = $('play-label').textContent;
    $('stage-status').classList.toggle('live', running);
    $('stage-label').textContent = starting ? 'STARTING' : running ? (selectedVoice ? 'LISTENING' : 'PROMPTING') : (position > 0 && position < prompt.words.length ? 'PAUSED' : 'READY');
    $('play-hint').textContent = keyName(shortcuts.play);
    $('slower-hint').textContent = keyName(shortcuts.slower);
    $('faster-hint').textContent = keyName(shortcuts.faster);
  }

  function publish() {
    const now = performance.now();
    nextPublish = now + 230;
    nextKeepAlive = now + 1000;
    publishedSpeaking = settings.voiceScroll && voiceSpeaking(now);
    sync.publish({
      type: 'state', html: script.html, position: pacedCue ?? position, speed: effectiveSpeed(), playing: running, mode,
      wordRate: mode === 'timed' ? (prompt.advance(position, effectiveSpeed() * .23) - position) / .23 : 0,
      voiceMatch: position, voiceSpeaking: publishedSpeaking, voiceSeek,
      settings: { ...normalizeDisplay(settings), wheel: settings.wheel, wheelStep: settings.wheelStep },
      shortcuts,
    }, scriptVersion);
  }

  async function toggle() {
    if (running || starting) return pause();
    if (!prompt.words.length || (mode === 'voice' && preparingVoice)) return;
    if (view !== 'prompt') switchView('prompt', true);
    if (position >= prompt.words.length) setPosition(0);
    if (mode === 'voice') {
      starting = true;
      voiceCursor = null;
      lastSpeech = -Infinity;
      voiceGuide = createVoiceGuide(Math.floor(position));
      pacedCue = voiceGuide?.cue ?? null;
      lastCueAdvance = performance.now();
      $('voice-heard').textContent = '';
      updateControls();
      try {
        const ready = await voice.start(settings.model, settings.language, prompt.words, settings.voiceFollow === 'match');
        if (!ready) return;
      } catch (error) {
        starting = false;
        voiceGuide = null;
        pacedCue = null;
        updateControls();
        $('voice-status').textContent = error.message;
        toast(error.message);
        return;
      }
      starting = false;
    }
    lastFrame = performance.now();
    running = true;
    requestWakeLock();
    updateControls();
    publish();
  }

  function createVoiceGuide(start) {
    if (settings.model !== 'live-en') return null;
    if (settings.voiceFollow === 'predictive') return new VoicePrediction(prompt.words, start);
    if (settings.voiceFollow === 'paced') return new VoicePace(prompt.words, start, prompt.pauses);
    return new VoiceMatch(prompt.words.length, start, settings.wordLead);
  }

  function pause() {
    if (mode === 'voice') voice.stop();
    starting = false;
    running = false;
    hold = false;
    voiceCursor = null;
    voiceGuide = null;
    pacedCue = null;
    lastSpeech = -Infinity;
    releaseWakeLock();
    updateControls();
    save();
    publish();
  }

  function setMode(next) {
    if (mode === next) return;
    const resumeTimed = next === 'timed' && running;
    pause();
    mode = next;
    if (resumeTimed) {
      running = true;
      lastFrame = performance.now();
      requestWakeLock();
    }
    updateControls();
    if (next === 'voice') refreshVoiceStatus();
    save();
    publish();
  }

  function setPosition(next) {
    voiceCursor = null;
    position = clamp(next, 0, prompt.words.length);
    voiceGuide?.reset(Math.floor(position));
    pacedCue = voiceGuide?.cue ?? null;
    voiceSeek++;
    prompt.resetVoiceScroll();
    if (mode === 'voice' && settings.voiceScroll) {
      prompt.renderVoiceScroll(pacedCue ?? position, position, false, performance.now(), running || position > 0);
    } else {
      prompt.render(position, mode === 'voice' && (running || position > 0));
    }
    tickProgress();
    updateControls();
    save();
    publish();
  }

  function jump(delta) {
    const blocks = prompt.paragraphs;
    const current = Math.max(0, blocks.findLastIndex(start => start <= position));
    setPosition(blocks[clamp(current + delta, 0, blocks.length - 1)] ?? 0);
  }

  function setSpeed(value) {
    settings.speed = clamp(Math.round(value), speedMin, speedMax);
    updateControls();
    tickProgress();
    save();
    publish();
  }

  function changeSize(value) {
    settings.size = normalizeDisplay({ size: Math.round(value) }).size;
    $('prompt-size').value = settings.size;
    $('prompt-size-range').value = settings.size;
    paintRange($('prompt-size-range'));
    updateAppearance();
    tickProgress();
    updateControls();
    save();
    publish();
  }

  function applyControl({ action, position: destination, amount }) {
    if (action === 'pause') pause();
    if (action === 'play' && !running && !starting) toggle();
    if (action === 'toggle') toggle();
    if (action === 'seek') setPosition(destination);
    if (action === 'first' || action === 'last') {
      if (running || starting) pause();
      setPosition(action === 'first' ? 0 : prompt.words.length);
    }
    if (action === 'previous' || action === 'next') jump(action === 'next' ? 1 : -1);
    if (action === 'speed') setSpeed(settings.speed + amount);
    if (action === 'size') changeSize(settings.size + amount);
    if (action === 'hold' && !hold && mode === 'timed') { hold = true; updateControls(); publish(); }
    if (action === 'release') clearHold();
  }

  function followSpeech(text, evidence) {
    if (!evidence.guided) $('voice-heard').textContent = 'Heard: ' + text;
    voiceCursor ??= new VoiceCursor(prompt.words, position, settings.language, {
      resetGuideOnForwardRecovery: settings.voiceFollow !== 'predictive',
    });
    const next = voiceCursor.update(tokenize(text), evidence);
    if (next === null) {
      if (voiceGuide && !evidence.guided && voiceCursor.recovery) {
        if (settings.voiceFollow === 'predictive') showPacedCue(voiceGuide.reset());
        if (settings.voiceFollow === 'paced' && voiceCursor.recovery.next < voiceCursor.position) voiceGuide.waitForMatch();
      }
      if (!evidence.guided && !evidence.partial && !evidence.behind && performance.now() - lastCueAdvance > 1800) {
        $('voice-status').textContent = 'Listening for words that match the script…';
      }
      return;
    }
    lastCueAdvance = performance.now();
    if (!evidence.behind) $('voice-status').textContent = 'Following the script';
    const previousCue = pacedCue;
    position = next;
    if (!voiceGuide) renderVoiceCue();
    else if (settings.voiceFollow === 'predictive' && next > voiceCursor.position + 2) showPacedCue(voiceGuide.reset(next));
    else showPacedCue(voiceGuide.confirm(next, evidence.audioEnd, voiceCursor.relocated));
    if (settings.voiceScroll && voiceGuide && pacedCue === previousCue) publish();
    scheduleSave();
  }

  function advanceVoiceCue(frame, speaking, rms) {
    const now = performance.now();
    if (speaking && (rms >= .007 || now - lastCueAdvance < 250)) lastSpeech = now;
    if (voiceGuide) showPacedCue(voiceGuide.update(frame, speaking));
  }

  function showPacedCue(next) {
    if (pacedCue === next) return;
    pacedCue = next;
    renderVoiceCue();
  }

  function renderVoiceCue() {
    if (!settings.voiceScroll) prompt.render(pacedCue ?? position, true, reduceMotion.matches ? 1 : 0);
    tickProgress();
    publish();
  }

  function save() {
    clearTimeout(timer);
    timer = null;
    const ok = writeStorage('teleprompter-studio', { ...script, position, settings, mode, shortcuts });
    $('save-label').textContent = ok ? 'Saved on this device' : 'Storage full. Save a copy.';
  }

  function scheduleSave() {
    clearTimeout(timer);
    $('save-label').textContent = 'Saving…';
    timer = setTimeout(save, 250);
  }

  function updateEditor() {
    const next = sanitizeScript(editor.innerHTML);
    if (next === script.html) return;
    script.html = next;
    renderScript(false);
    scheduleSave();
  }

  function confirmReplace(label) {
    const dialog = $('replace-dialog');
    dialog.returnValue = '';
    $('replace-title').textContent = label;
    dialog.showModal();
    return new Promise(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'replace'), { once: true }));
  }

  async function loadFile(file) {
    if (!file) return;
    try {
      toast('Opening ' + file.name + '…');
      const { readScript } = await import('./imports.js');
      const next = await readScript(file);
      const sampleOrEmpty = (script.title === sample.title && script.html === sample.html) || !prompt.words.length;
      if (!sampleOrEmpty && !(await confirmReplace('Replace the current script?'))) {
        hideToast();
        return;
      }
      setScript(next);
      toast('Imported ' + file.name);
    } catch (error) {
      toast(error.message || 'This file could not be opened.');
    }
  }

  function setScript(next) {
    switchView('edit');
    if (running || starting) pause();
    script.title = next.title;
    script.html = next.html;
    title.value = script.title;
    editor.innerHTML = script.html;
    pendingSelection = null;
    renderScript(true);
    save();
  }

  function exportScript() {
    const doc = document.implementation.createHTMLDocument(script.title || 'Script');
    const charset = doc.createElement('meta');
    charset.setAttribute('charset', 'utf-8');
    doc.head.prepend(charset);
    const style = doc.createElement('style');
    style.textContent = '[data-font=sans]{font-family:Arial,sans-serif}[data-font=serif]{font-family:Georgia,serif}[data-font=mono]{font-family:monospace}[data-size="2"]{font-size:.84em}[data-size="4"]{font-size:1.2em}[data-size="5"]{font-size:1.45em}';
    doc.head.append(style);
    doc.body.innerHTML = script.html;
    const href = URL.createObjectURL(new Blob(['<!doctype html>\n', doc.documentElement.outerHTML], { type: 'text/html;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = href;
    link.download = (script.title.trim().replace(/[\\/:*?"<>|]/g, '-').slice(0, 110) || 'script') + '.html';
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(href), 1500);
  }

  async function refreshVoiceStatus() {
    const token = ++voiceStatusToken;
    const model = settings.model;
    $('voice-status').textContent = 'Checking this device…';
    const manifest = await voice.prepared(model).catch(() => null);
    if (token !== voiceStatusToken) return;
    $('voice-status').textContent = manifest ? 'Model saved on this device' : 'Prepare a model over local Wi‑Fi before you go offline.';
  }

  async function prepareVoice() {
    const button = $('prepare-voice');
    const choice = settings.model;
    preparingVoice = true;
    updateControls();
    button.disabled = true;
    $('voice-model').disabled = true;
    try {
      requestPersistence();
      await voice.prepare(choice);
      $('voice-status').textContent = 'Model ready on this device';
      toast('Speech model is ready for offline use.');
    } catch (error) {
      $('voice-status').textContent = error.message || 'The speech model could not be prepared.';
      toast($('voice-status').textContent);
    } finally {
      preparingVoice = false;
      updateControls();
      button.disabled = false;
      $('voice-model').disabled = false;
    }
  }

  function editCommand(command, value) {
    editor.focus();
    if (pendingSelection && editor.contains(pendingSelection.commonAncestorContainer)) {
      selection.removeAllRanges();
      selection.addRange(pendingSelection);
    }
    document.execCommand('styleWithCSS', false, false);
    document.execCommand(command, false, value);
    updateEditor();
    updateFormatting();
  }

  function updateFormatting() {
    if (!selection.rangeCount || !editor.contains(selection.anchorNode)) return;
    pendingSelection = selection.getRangeAt(0).cloneRange();
    for (const button of document.querySelectorAll('[data-format]')) {
      if (button.dataset.format === 'undo') continue;
      button.setAttribute('aria-pressed', String(document.queryCommandState(button.dataset.format)));
    }
  }

  function openSettings() {
    $('slow-speed').value = settings.slow;
    $('wheel-action').value = settings.wheel;
    $('wheel-step').value = settings.wheelStep;
    $('tap-pause').checked = settings.tapPause;
    showShortcuts();
    $('settings-dialog').showModal();
  }

  function syncDisplayFields() {
    $('prompt-size').value = settings.size;
    $('prompt-size-range').value = settings.size;
    paintRange($('prompt-size-range'));
    $('prompt-font').value = settings.font;
    $('show-guide').checked = settings.guide;
    $('highlight-words').checked = settings.highlightWords;
    $('voice-scroll').checked = settings.voiceScroll;
    syncVoiceScrollFields();
    $('shade-mode').value = settings.shade;
    for (const [id, key] of Object.entries(displayFields)) {
      $(id).value = settings[key];
      $(id + '-range').value = settings[key];
      paintRange($(id + '-range'));
    }
  }

  function syncVoiceScrollFields() {
    $('voice-line-offset-control').hidden = !settings.voiceScroll;
    $('voice-scroll-smoothing-control').hidden = !settings.voiceScroll;
  }

  function syncFollowFields() {
    $('english-follow-options').hidden = settings.model !== 'live-en';
    $('voice-follow-style').value = settings.voiceFollow;
    $('word-lead-control').hidden = settings.voiceFollow !== 'match';
    const slider = $('word-lead');
    slider.value = settings.wordLead;
    $('word-lead-value').value = String(settings.wordLead);
    paintRange(slider);
  }

  function showShortcuts() {
    $('shortcut-list').replaceChildren(...Object.entries(shortcutLabels).map(([key, label]) => {
      const row = document.createElement('div');
      row.className = 'shortcut-row';
      const text = document.createElement('span');
      text.textContent = label;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'button outline';
      button.dataset.shortcut = key;
      button.textContent = binding === key ? 'Press a key…' : keyName(shortcuts[key]);
      button.setAttribute('aria-label', 'Bind ' + label + ', currently ' + keyName(shortcuts[key]));
      button.classList.toggle('listening', binding === key);
      button.addEventListener('click', () => {
        binding = key;
        $('shortcut-status').textContent = 'Press a key or remote button.';
        showShortcuts();
        $('shortcut-list').querySelector('[data-shortcut="' + key + '"]').focus();
      });
      row.append(text, button);
      return row;
    }));
  }

  function toggleFlip(axis) {
    const preference = axis === 'x' ? 'flipX' : 'flipY';
    settings[preference] = !settings[preference];
    updateAppearance();
    save();
  }

  function expand(expanded) {
    document.body.classList.toggle('expanded', expanded);
    if (expanded) {
      $('prompt-view').hidden = false;
      // Request native fullscreen in the click handler before measuring the script.
      stage.requestFullscreen?.().catch(() => {});
    }
    if (expanded) switchView('prompt');
    updateAppearance();
    tickProgress();
    if (expanded) {
      showDisplayControls();
      stage.focus({ preventScroll: true });
    } else {
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      $('open-display').focus({ preventScroll: true });
    }
  }

  function showPairState() {
    $('start-pair').hidden = pairing || !$('retry-pair').hidden;
    $('start-pair').disabled = startingPair;
    $('workspace-role').hidden = !pairing && !monitorWindow;
    $('stage-role').hidden = !pairing && !monitorWindow;
    $('stage-role').textContent = 'Operator';
    for (const id of ['pair-code-row', 'pair-link-details', 'stop-pair']) $(id).hidden = !pairing;
  }

  function selectPairRole(role) {
    for (const name of ['control', 'display']) {
      $('pair-' + name + '-role').setAttribute('aria-pressed', String(role === name));
      $('pair-' + name + '-panel').hidden = role !== name;
    }
  }

  async function startPair() {
    if (startingPair || pairing) return;
    startingPair = true;
    showPairState();
    $('pair-status').textContent = 'Connecting to the local server…';
    $('retry-pair').hidden = true;
    try {
      const { url, code } = await sync.startPair(true, false);
      pairing = true;
      $('pair-url').value = url;
      $('pair-code').value = code.slice(0, 5) + ' ' + code.slice(5);
      $('pair-status').textContent = 'Waiting for a display to join with this code.';
      publish();
      $('pair-qr').hidden = true;
      import('qrcode').then(async ({ default: qr }) => {
        if ($('pair-url').value !== url || !pairing) return;
        $('pair-qr').src = await qr.toDataURL(url, { width: 180, margin: 2 });
        $('pair-qr').hidden = false;
      }).catch(() => {});
    } catch (error) {
      $('pair-status').textContent = error.message || 'Could not start pairing over the local network.';
      $('retry-pair').hidden = false;
    } finally {
      startingPair = false;
      showPairState();
    }
  }

  function clearHold() {
    if (!hold) return;
    hold = false;
    updateControls();
    publish();
  }

  $('open-settings').addEventListener('click', openSettings);
  $('footer-settings').addEventListener('click', openSettings);
  $('edit-tab').addEventListener('click', () => switchView('edit'));
  $('prompt-tab').addEventListener('click', () => switchView('prompt', true));
  $('open-display').addEventListener('click', () => {
    expand(true);
  });
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement && document.body.classList.contains('expanded')) expand(false);
  });
  $('exit-expanded').addEventListener('click', () => expand(false));
  $('back-to-script').addEventListener('click', () => expand(false));
  for (const id of ['start-pair', 'retry-pair']) $(id).addEventListener('click', startPair);
  touchControls(stage, {
    enabled: () => document.body.classList.contains('expanded') && mode === 'timed',
    position: () => position, seek: setPosition, pause, toggle,
    tapEnabled: () => settings.tapPause, scrub: (delta, start) => prompt.positionAfterDrag(delta, start),
  });
  $('share-display').addEventListener('click', () => pairDialog.showModal());
  $('pair-control-role').addEventListener('click', () => selectPairRole('control'));
  $('pair-display-role').addEventListener('click', () => selectPairRole('display'));
  $('second-monitor').addEventListener('click', () => {
    switchView('prompt');
    publish();
    monitorWindow = sync.openDisplay(true, false);
    if (monitorWindow) showPairState();
    else toast('Allow pop-ups for Teleprompter to open a second-monitor window.');
  });
  $('join-pair').addEventListener('submit', async event => {
    event.preventDefault();
    const button = event.submitter;
    const code = $('join-code').value.toLowerCase().replace(/[\s-]/g, '');
    if (!/^[a-f0-9]{10}$/.test(code)) {
      $('join-status').textContent = 'Enter the 10 characters shown on the controlling device.';
      return;
    }
    button.disabled = true;
    $('join-status').textContent = 'Looking for the controlling device…';
    try {
      const response = await fetch('/api/join/' + code, { method: 'POST', signal: AbortSignal.timeout(5000) });
      if (response.status === 404) {
        $('join-status').textContent = 'Code not found. Check the code and make sure both devices use the same desktop setup.';
        return;
      }
      if (!response.ok) throw new Error();
      const { id, flipX, flipY } = await response.json();
      if (!pairDialog.open || $('pair-display-panel').hidden) return;
      location.assign('/?' + new URLSearchParams({ pair: id, x: flipX ? '1' : '0', y: flipY ? '1' : '0' }));
    } catch {
      $('join-status').textContent = 'Could not reach the desktop setup. Check the local network and try again.';
    } finally {
      button.disabled = false;
    }
  });
  $('copy-pair').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('pair-url').value); toast('Display link copied.'); }
    catch { $('pair-url').select(); toast('Select and copy the display link.'); }
  });
  $('stop-pair').addEventListener('click', async () => {
    pairing = false;
    const ending = sync.endPair();
    $('pair-status').textContent = 'Pairing ended.';
    showPairState();
    await ending;
  });
  playButton.addEventListener('click', () => { stage.focus({ preventScroll: true }); toggle(); });
  $('expanded-play').addEventListener('click', () => { stage.focus({ preventScroll: true }); toggle(); });
  $('timed-mode').addEventListener('click', () => setMode('timed'));
  $('voice-mode').addEventListener('click', () => setMode('voice'));
  $('restart').addEventListener('click', () => setPosition(0));
  $('previous').addEventListener('click', () => jump(-1));
  $('next').addEventListener('click', () => jump(1));
  for (const axis of ['x', 'y']) {
    $('flip-' + axis).addEventListener('click', () => toggleFlip(axis));
    $('display-flip-' + axis).addEventListener('click', () => toggleFlip(axis));
  }
  speedSlider.addEventListener('input', () => setSpeed(Number(speedSlider.value)));
  seek.addEventListener('input', () => setPosition(Number(seek.value)));
  $('prepare-voice').addEventListener('click', prepareVoice);
  $('voice-language').addEventListener('change', event => {
    if (running || starting) pause();
    settings.language = event.target.value;
    updateVoiceLanguage();
    syncFollowFields();
    save();
    refreshVoiceStatus();
  });

  function updateVoiceLanguage() {
    const liveEnglish = $('voice-model').querySelector('[value="live-en"]');
    liveEnglish.disabled = settings.language !== 'en';
    liveEnglish.hidden = liveEnglish.disabled;
    if (liveEnglish.disabled && settings.model === 'live-en') {
      settings.model = defaults.model;
      $('voice-model').value = settings.model;
    }
  }
  $('voice-model').addEventListener('change', event => {
    if (running || starting) pause();
    settings.model = event.target.value;
    syncFollowFields();
    save();
    refreshVoiceStatus();
  });
  $('voice-follow-style').addEventListener('change', event => {
    if (running || starting) pause();
    settings.voiceFollow = event.target.value;
    syncFollowFields();
    save();
    refreshVoiceStatus();
  });
  $('word-lead').addEventListener('input', event => {
    settings.wordLead = event.target.valueAsNumber;
    syncFollowFields();
    if (voiceGuide instanceof VoiceMatch) showPacedCue(voiceGuide.setLead(settings.wordLead));
    scheduleSave();
  });

  $('prompt-size').addEventListener('change', event => changeSize(finite(event.target.valueAsNumber, settings.size)));
  $('prompt-size-range').addEventListener('input', event => changeSize(event.target.valueAsNumber));
  for (const [id, key] of Object.entries(displayFields)) {
    const number = $(id);
    const slider = $(id + '-range');
    const adjust = event => {
      if (!Number.isFinite(event.target.valueAsNumber)) return;
      settings[key] = normalizeDisplay({ [key]: event.target.valueAsNumber })[key];
      slider.value = settings[key];
      paintRange(slider);
      if (event.target === slider) number.value = settings[key];
      updateAppearance();
      tickProgress();
      scheduleSave();
      publish();
    };
    number.addEventListener('input', adjust);
    number.addEventListener('change', () => { number.value = settings[key]; });
    slider.addEventListener('input', adjust);
  }
  $('shade-mode').addEventListener('change', event => {
    settings.shade = event.target.value;
    updateAppearance(); save(); publish();
  });
  $('tap-pause').addEventListener('change', event => {
    settings.tapPause = event.target.checked;
    save(); publish();
  });
  $('prompt-font').addEventListener('change', event => {
    settings.font = event.target.value;
    updateAppearance();
    save();
    publish();
  });
  for (const [id, key] of [['show-guide', 'guide'], ['highlight-words', 'highlightWords'], ['voice-scroll', 'voiceScroll']]) {
    $(id).addEventListener('change', event => {
      settings[key] = event.target.checked;
      if (key === 'voiceScroll') syncVoiceScrollFields();
      updateAppearance();
      save();
      publish();
    });
  }
  $('slow-speed').addEventListener('change', event => {
    settings.slow = clamp(finite(event.target.valueAsNumber, settings.slow), speedMin, speedMax);
    event.target.value = settings.slow;
    updateControls();
    save();
    publish();
  });
  $('wheel-step').addEventListener('change', event => {
    settings.wheelStep = clamp(Math.round(finite(event.target.valueAsNumber, settings.wheelStep)), 1, 200);
    event.target.value = settings.wheelStep;
    save();
    publish();
  });
  $('wheel-action').addEventListener('change', event => { settings.wheel = event.target.value; save(); publish(); });
  $('reset-shortcuts').addEventListener('click', () => {
    Object.assign(shortcuts, defaultShortcuts);
    binding = null;
    $('shortcut-status').textContent = '';
    updateControls();
    showShortcuts();
    save();
  });
  $('settings-dialog').addEventListener('close', () => { binding = null; $('shortcut-status').textContent = ''; });
  title.addEventListener('input', () => { script.title = title.value; scheduleSave(); });
  editor.addEventListener('input', updateEditor);
  editor.addEventListener('paste', event => {
    const clipboard = event.clipboardData;
    if (!clipboard) return;
    event.preventDefault();
    const html = clipboard.getData('text/html');
    document.execCommand('insertHTML', false, html ? sanitizeScript(html) : plainHtml(clipboard.getData('text/plain')));
    updateEditor();
  });
  editor.addEventListener('drop', event => {
    // Files are handled by the script panel. Block the browser from inserting
    // dragged HTML directly into the editor.
    event.preventDefault();
  });
  document.addEventListener('selectionchange', updateFormatting);
  document.querySelectorAll('[data-format]').forEach(button => {
    button.addEventListener('mousedown', event => event.preventDefault());
    button.addEventListener('click', () => editCommand(button.dataset.format));
  });
  for (const [id, command] of [['edit-font', 'fontName'], ['edit-size', 'fontSize']]) {
    $(id).addEventListener('change', event => {
      if (event.target.value) editCommand(command, event.target.value);
      event.target.value = '';
    });
  }
  $('import-script').addEventListener('click', () => $('file-input').click());
  $('drop-zone').addEventListener('click', () => $('file-input').click());
  $('file-input').addEventListener('change', event => {
    const file = event.target.files[0];
    event.target.value = '';
    loadFile(file);
  });
  const panel = $('script-panel');
  panel.addEventListener('dragover', event => {
    if (!event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault();
    $('drop-zone').classList.add('dragging');
  });
  panel.addEventListener('dragleave', event => {
    if (!panel.contains(event.relatedTarget)) $('drop-zone').classList.remove('dragging');
  });
  panel.addEventListener('drop', event => {
    event.preventDefault();
    $('drop-zone').classList.remove('dragging');
    loadFile(event.dataTransfer?.files[0]);
  });
  $('export-script').addEventListener('click', exportScript);
  $('new-script').addEventListener('click', async () => {
    if (prompt.words.length && !(await confirmReplace('Start a new script?'))) return;
    setScript({ title: '', html: '' });
    title.focus();
  });
  enableWheel(() => mode === 'timed' && settings.wheel === 'speed', steps => setSpeed(settings.speed + steps * settings.wheelStep));

  document.addEventListener('keydown', event => {
    const code = event.code || event.key;
    if (binding) {
      event.preventDefault();
      if (code === 'Escape') {
        binding = null;
        $('shortcut-status').textContent = '';
      } else {
        const duplicate = Object.entries(shortcuts).find(([key, existing]) => key !== binding && code === existing)?.[0];
        if (duplicate) {
          $('shortcut-status').textContent = keyName(code) + ' is already bound to ' + shortcutLabels[duplicate].toLowerCase() + '.';
          return;
        }
        const target = binding;
        shortcuts[target] = code;
        binding = null;
        $('shortcut-status').textContent = shortcutLabels[target] + ' bound to ' + keyName(code) + '.';
        updateControls();
        save();
        publish();
      }
      showShortcuts();
      return;
    }
    if (code === 'Escape') {
      const dialog = document.querySelector('dialog[open]');
      if (dialog) {
        event.preventDefault();
        dialog.close('cancel');
      } else if (document.body.classList.contains('expanded')) {
        event.preventDefault();
        expand(false);
      } else if (running || starting) {
        pause();
      } else if (view === 'prompt') {
        switchView('edit');
        $('edit-tab').focus();
      } else if (document.activeElement !== document.body) {
        document.activeElement.blur();
      }
      return;
    }
    if (!document.querySelector('dialog[open]')) handleShortcut(event, shortcuts, applyControl);
  });
  document.addEventListener('keyup', event => { if ((event.code || event.key) === shortcuts.temporary) clearHold(); });
  window.addEventListener('blur', clearHold);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      clearHold();
      if (mode === 'voice' && (running || starting)) pause();
      else save();
    } else if (running) requestWakeLock();
  });
  window.addEventListener('pagehide', () => { voice.stop(); save(); });
}

function initDisplay() {
  document.body.classList.add('display-view');
  $('prompt-view').hidden = false;
  $('stage-role').textContent = 'Display';
  $('stage-role').hidden = false;
  if (localDisplay) {
    document.title = 'Teleprompter Display';
    $('display-fullscreen').title = 'Full screen on this monitor';
  }
  let state = { position: 0, speed: 0, playing: false, mode: 'timed', settings: defaults, html: '' };
  let anchor = performance.now();
  let lastAnimation = anchor;
  let connected = false;
  let releaseCode;
  const orientation = readStorage('teleprompter-display-orientation');
  let flipX = typeof orientation.flipX === 'boolean' ? orientation.flipX : params.get('x') === '1';
  let flipY = typeof orientation.flipY === 'boolean' ? orientation.flipY : params.get('y') === '1';
  prompt.setScript('');
  appearance();
  showDisplayControls();
  const connection = watchDisplay(localDisplay, pairedDisplay, packet => {
    if (!packet || !Number.isFinite(packet.position)) return;
    const changed = typeof packet.html === 'string' && packet.html !== state.html;
    const visual = packet.settings && JSON.stringify(packet.settings) !== JSON.stringify(state.settings);
    if (packet.voiceSeek !== state.voiceSeek) prompt.resetVoiceScroll();
    state = { ...state, ...packet };
    anchor = performance.now();
    if (changed) prompt.setScript(state.html);
    if (visual) appearance();
    $('expanded-play').classList.toggle('playing', state.playing);
    $('expanded-play').setAttribute('aria-label', state.playing ? 'Pause' : 'Start prompting');
  }, (message, lost = false) => {
    $('display-status').textContent = message;
    if (lost) {
      state.playing = false;
      state.position = prompt.position;
      showDisplayControls();
    }
    connected = !lost;
  });
  requestAnimationFrame(function animate(now) {
    const active = connected && state.playing && state.mode === 'timed';
    const elapsed = Math.max(0, (now - anchor) / 1000);
    const rate = state.wordRate ?? state.speed / 60;
    const progress = clamp(state.position + (active ? rate * Math.min(elapsed, 1) : 0), 0, prompt.words.length);
    const voiceMode = state.mode === 'voice';
    const blend = voiceMode ? voiceScrollBlend(Math.max(0, now - lastAnimation) / 1000) : reduceMotion.matches ? 1 : .22;
    lastAnimation = now;
    const highlight = voiceMode && (state.playing || progress > 0);
    if (voiceMode && state.settings.voiceScroll && Number.isFinite(state.voiceMatch)) {
      const speaking = connected && state.playing && state.voiceSpeaking === true && elapsed < .5;
      prompt.renderVoiceScroll(progress, state.voiceMatch, speaking, now, highlight);
    } else {
      prompt.render(progress, highlight, blend);
    }
    requestAnimationFrame(animate);
  });
  $('display-flip-x').addEventListener('click', () => { flipX = !flipX; storeAppearance(); });
  $('display-flip-y').addEventListener('click', () => { flipY = !flipY; storeAppearance(); });
  function leaveDisplay() {
    releaseHold();
    connection.close();
    if (localDisplay && window.opener) window.close();
    else location.replace('/');
  }
  $('back-to-script').addEventListener('click', leaveDisplay);
  function control(command) {
    state.position = prompt.position;
    if (command.action === 'seek') state.position = command.position;
    state.playing = command.action === 'play';
    anchor = performance.now();
    prompt.render(state.position, state.mode === 'voice');
    connection.send(command);
  }
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      else leaveDisplay();
      return;
    }
    if (!connected) return;
    handleShortcut(event, state.shortcuts || defaultShortcuts, command => {
      if (command.action === 'hold') releaseCode = event.code || event.key;
      connection.send(command);
    });
  });
  const releaseHold = () => {
    if (!releaseCode) return;
    releaseCode = null;
    connection.send({ action: 'release' });
  };
  document.addEventListener('keyup', event => { if ((event.code || event.key) === releaseCode) releaseHold(); });
  window.addEventListener('blur', releaseHold);
  window.addEventListener('pagehide', releaseHold);
  enableWheel(() => connected && state.mode === 'timed' && state.settings.wheel !== 'off',
    steps => connection.send({ action: 'speed', amount: steps * (state.settings.wheelStep || defaults.wheelStep) }));
  $('expanded-play').addEventListener('click', () => control({ action: state.playing ? 'pause' : 'play' }));
  touchControls(stage, {
    enabled: () => state.mode === 'timed',
    position: () => prompt.position,
    seek: position => control({ action: 'seek', position }),
    pause: () => control({ action: 'pause' }),
    toggle: () => control({ action: state.playing ? 'pause' : 'play' }),
    tapEnabled: () => state.settings.tapPause !== false,
    scrub: (delta, start) => prompt.positionAfterDrag(delta, start),
  });
  $('display-fullscreen').addEventListener('click', async () => {
    if (document.fullscreenElement) return document.exitFullscreen();
    try {
      if (stage.requestFullscreen) await stage.requestFullscreen();
      else toast('For a full-screen view on iPhone, open the app from the Home Screen.');
      requestWakeLock();
    } catch { toast('This browser keeps its controls visible.'); }
  });
  stage.addEventListener('pointerdown', requestWakeLock);
  window.addEventListener('resize', appearance);
  function appearance() {
    prompt.appearance(normalizedSettings(state.settings), flipX, flipY);
    $('display-flip-x').setAttribute('aria-pressed', String(flipX));
    $('display-flip-y').setAttribute('aria-pressed', String(flipY));
  }
  function storeAppearance() {
    writeStorage('teleprompter-display-orientation', { flipX, flipY });
    appearance();
  }
}

document.querySelectorAll('button[data-close]').forEach(button => {
  button.addEventListener('click', () => button.closest('dialog').close());
});
for (const dialog of document.querySelectorAll('dialog')) {
  const outside = event => {
    const bounds = dialog.getBoundingClientRect();
    return event.target === dialog && (event.clientX < bounds.left || event.clientX > bounds.right
      || event.clientY < bounds.top || event.clientY > bounds.bottom);
  };
  let beganOutside = false;
  dialog.addEventListener('pointerdown', event => { beganOutside = outside(event); });
  dialog.addEventListener('click', event => {
    if (beganOutside && outside(event)) dialog.close('cancel');
    beganOutside = false;
  });
}

function handleShortcut(event, shortcuts, send) {
  if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
  if (event.target.closest?.('input, select, textarea, [contenteditable=true]')) return;
  const code = event.code || event.key;
  const aliases = { NumpadAdd: 'Equal', NumpadSubtract: 'Minus' };
  const intent = Object.keys(shortcuts).find(key => shortcuts[key] === code)
    || Object.keys(shortcuts).find(key => shortcuts[key] === aliases[code])
    || (event.key === '+' && shortcuts.larger === 'Equal' ? 'larger' : null)
    || (event.key === '-' && shortcuts.smaller === 'Minus' ? 'smaller' : null);
  if (!intent || (intent === 'play' && event.target.closest?.('button, a'))) return;
  event.preventDefault();
  if (event.repeat && !['faster', 'slower', 'larger', 'smaller'].includes(intent)) return;
  if (intent === 'faster' || intent === 'slower') {
    send({ action: 'speed', amount: intent === 'faster' ? 10 : -10 });
  } else if (intent === 'larger' || intent === 'smaller') {
    send({ action: 'size', amount: intent === 'larger' ? 2 : -2 });
  } else {
    send({ action: ({ play: 'toggle', temporary: 'hold' })[intent] || intent });
  }
}

function enableWheel(enabled, adjust) {
  let previousEvent = -Infinity;
  let previousStep = -Infinity;
  let previousDirection = 0;
  stage.addEventListener('wheel', event => {
    if (!enabled() || !event.deltaY || event.ctrlKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
    event.preventDefault();
    const now = performance.now();
    const direction = -Math.sign(event.deltaY);
    const burst = event.deltaMode === 0 && now - previousEvent < 25;
    previousEvent = now;
    if (burst && direction === previousDirection && now - previousStep < 65) return;
    previousDirection = direction;
    previousStep = now;
    adjust(direction);
  }, { passive: false });
}
let controlsTimer;
stage.addEventListener('pointermove', showDisplayControls);
stage.addEventListener('pointerdown', showDisplayControls);
function showDisplayControls() {
  clearTimeout(controlsTimer);
  stage.classList.add('display-controls-visible');
  controlsTimer = setTimeout(() => stage.classList.remove('display-controls-visible'), 3600);
}

function initOffline() {
  const label = $('offline-label');
  const detail = $('offline-detail');
  const button = $('offline-info');
  const version = $('app-version');
  const safeContext = isSecureContext && 'serviceWorker' in navigator;
  let ready = false;
  let hadController = Boolean(navigator.serviceWorker?.controller);
  let updated = false;
  let failure = '';
  const update = () => {
    button.classList.toggle('ready', ready);
    label.textContent = updated ? 'Update available' : ready ? 'Offline ready' : failure ? 'Offline setup' : 'Preparing offline';
    detail.textContent = updated ? 'An updated app is saved. Finish your take, then use the button below to reload. Your script and settings will be kept.' : ready ? 'The app files are saved for offline launch on this device.' : failure || 'Saving the app files on this device.';
    $('apply-update').hidden = !updated;
    version.classList.toggle('update-ready', updated);
    version.title = updated ? 'Update available' : 'App version and offline status';
  };
  function openStatus() {
    $('offline-dialog').showModal();
    if (ready) requestPersistence();
    if (safeContext) navigator.serviceWorker.getRegistration().then(registration => registration?.update()).catch(() => {});
  }
  button.addEventListener('click', openStatus);
  version.addEventListener('click', openStatus);
  if (!safeContext) {
    failure = 'Open the app from its trusted local HTTPS address to enable offline launch.';
    return update();
  }
  function check() {
    const worker = navigator.serviceWorker.controller;
    if (!worker) return;
    const channel = new MessageChannel();
    channel.port1.onmessage = event => {
      ready = Boolean(event.data?.coreAssets);
      failure = ready ? '' : 'Reconnect to the local server to finish offline setup.';
      update();
      channel.port1.close();
    };
    worker.postMessage('offline-status', [channel.port2]);
  }
  const time = setTimeout(() => {
    if (!ready) {
      failure = 'Reconnect to the local server and reopen the app to finish saving its files.';
      update();
    }
  }, 20_000);
  $('apply-update').addEventListener('click', () => location.reload());
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    updated = hadController;
    hadController = true;
    check();
  });
  navigator.serviceWorker.register('/sw.js').then(() => {
    check();
    return navigator.serviceWorker.ready;
  }).then(() => {
    check();
    clearTimeout(time);
  }).catch(() => {
    failure = 'Offline setup could not finish. Reopen the app on its local HTTPS address.';
    update();
  });
}

function normalizedSettings(input) {
  const value = input || {};
  const oldSpeed = value.speedUnit !== 'px/s';
  const migrate = (number, fallback) => Number.isFinite(number) ? Math.round(number / (oldSpeed ? 3 : 1)) : fallback;
  return {
    ...normalizeDisplay(value),
    speedUnit: 'px/s',
    speed: clamp(migrate(value.speed, defaults.speed), speedMin, speedMax),
    slow: clamp(migrate(value.slow, defaults.slow), speedMin, speedMax),
    size: clamp(finite(value.size, defaults.size), 20, 160),
    font: ['sans', 'serif', 'mono'].includes(value.font) ? value.font : defaults.font,
    guide: value.guide !== false,
    wheel: value.wheel === 'off' ? 'off' : 'speed',
    wheelStep: clamp(finite(value.wheelStep, defaults.wheelStep), 1, 200),
    language: value.language === 'hu' ? 'hu' : 'en',
    model: ['live-en', 'tiny', 'base', 'small', 'turbo'].includes(value.model) ? value.model : defaults.model,
    voiceFollow: ['match', 'predictive', 'paced'].includes(value.voiceFollow) ? value.voiceFollow : defaults.voiceFollow,
    wordLead: clamp(Math.round(finite(value.wordLead, defaults.wordLead)), 0, maxWordLead),
    flipX: value.flipX === true,
    flipY: value.flipY === true,
  };
}

function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }
function finite(value, otherwise) { return Number.isFinite(value) ? value : otherwise; }
function asTime(seconds) {
  const rounded = Math.max(0, Math.round(seconds));
  return String(Math.floor(rounded / 60)).padStart(2, '0') + ':' + String(rounded % 60).padStart(2, '0');
}
function keyName(code) {
  return ({ Space: 'Space', ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓', ShiftLeft: 'Left Shift', ShiftRight: 'Right Shift', Equal: '+', Minus: '−', NumpadAdd: 'Numpad +', NumpadSubtract: 'Numpad −' })[code]
    || String(code || 'None').replace(/^(Key|Digit)/, '');
}
function makeSmall(text) {
  const item = document.createElement('small');
  item.textContent = text;
  return item;
}
function paintRange(input) {
  const minimum = Number(input.min);
  const fill = (Number(input.value) - minimum) / (Number(input.max) - minimum);
  input.style.setProperty('--range-progress', (fill * 100).toFixed(2) + '%');
}

let wakeLock;
async function requestWakeLock() {
  if (wakeLock && !wakeLock.released) return;
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* Browser controls display sleep. */ }
}
function releaseWakeLock() {
  wakeLock?.release().catch(() => {});
  wakeLock = null;
}
function requestPersistence() {
  navigator.storage?.persist?.().catch(() => {});
}

let toastTimer;
function toast(message) {
  clearTimeout(toastTimer);
  $('toast').textContent = message;
  $('toast').hidden = false;
  toastTimer = setTimeout(hideToast, 5100);
}
function hideToast() {
  clearTimeout(toastTimer);
  $('toast').hidden = true;
}
function readStorage(key) {
  try { return JSON.parse(localStorage.getItem(key)) || {}; } catch { return {}; }
}
function writeStorage(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
}

if (localDisplay || pairedDisplay) initDisplay();
else initStudio();
initOffline();
