import DOMPurify from 'dompurify';

const allowedTags = ['p', 'div', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'font', 'span', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'hr'];
const fontValues = [['arial', 'sans'], ['georgia', 'serif'], ['courier', 'mono'], ['mono', 'mono'], ['serif', 'serif']];
const sizes = ['2', '3', '4', '5'];
const wordPattern = /[\p{L}\p{N}][\p{L}\p{M}\p{N}]*(?:[’'-][\p{L}\p{N}][\p{L}\p{M}\p{N}]*)*/gu;

export function tokenize(text) {
  return (text.normalize('NFC').match(wordPattern) || []).map(word => word.toLowerCase().replaceAll('’', "'"));
}

export function sanitizeScript(html) {
  const fragment = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: allowedTags,
    ALLOWED_ATTR: ['face', 'size', 'style', 'data-font', 'data-size'],
    ALLOW_DATA_ATTR: false,
    RETURN_DOM_FRAGMENT: true,
  });
  for (const element of fragment.querySelectorAll('*')) {
    const face = (element.getAttribute('face') || element.style.fontFamily || '').toLowerCase();
    const sourceFont = element.getAttribute('data-font');
    const font = ['sans', 'serif', 'mono'].includes(sourceFont) ? sourceFont : fontValues.find(([name]) => face.includes(name))?.[1];
    const size = element.getAttribute('size') || element.getAttribute('data-size') || sizeFromStyle(element.style.fontSize);
    element.removeAttribute('style');
    element.removeAttribute('face');
    element.removeAttribute('size');
    element.removeAttribute('data-font');
    element.removeAttribute('data-size');
    if (font) element.dataset.font = font;
    if (sizes.includes(size)) element.dataset.size = size;
  }
  for (const element of fragment.querySelectorAll('font')) {
    const span = document.createElement('span');
    if (element.dataset.font) span.dataset.font = element.dataset.font;
    if (element.dataset.size) span.dataset.size = element.dataset.size;
    span.append(...element.childNodes);
    element.replaceWith(span);
  }
  const host = document.createElement('div');
  host.append(fragment);
  return host.innerHTML;
}

function sizeFromStyle(size) {
  if (!size) return '';
  const pixels = size.endsWith('px') ? parseFloat(size) : size.endsWith('pt') ? parseFloat(size) * 4 / 3 : NaN;
  if (Number.isFinite(pixels)) return pixels < 14 ? '2' : pixels < 19 ? '3' : pixels < 25 ? '4' : '5';
  return { small: '2', medium: '3', large: '4', 'x-large': '5' }[size] || '';
}

export function plainHtml(text) {
  const block = document.createElement('div');
  for (const line of text.replaceAll('\r', '').split('\n')) {
    const paragraph = document.createElement('p');
    paragraph.textContent = line;
    if (!line) paragraph.append(document.createElement('br'));
    block.append(paragraph);
  }
  return block.innerHTML;
}

export function markWords(host) {
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
  const textNodes = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode);
  const elements = [];
  const words = [];
  const paragraphs = [];
  const pauses = [];
  let lastBlock;
  let gap = '';
  for (const node of textNodes) {
    const fragment = document.createDocumentFragment();
    let offset = 0;
    for (const match of node.data.matchAll(wordPattern)) {
      const separator = node.data.slice(offset, match.index);
      fragment.append(separator);
      gap += separator;
      const word = document.createElement('span');
      word.className = 'word';
      word.textContent = match[0];
      const block = node.parentElement.closest('p, div, li, h1, h2, h3, h4, h5, h6, blockquote, pre');
      if (block !== lastBlock || words.length === 0) {
        paragraphs.push(words.length);
        lastBlock = block;
        if (words.length) pauses.push(words.length);
      } else if (/[.!?…]["'”’)]*\s+$/u.test(gap)) {
        pauses.push(words.length);
      }
      elements.push(word);
      words.push(tokenize(match[0])[0]);
      fragment.append(word);
      offset = match.index + match[0].length;
      gap = '';
    }
    gap += node.data.slice(offset);
    if (offset) {
      fragment.append(node.data.slice(offset));
      node.replaceWith(fragment);
    }
  }
  return { elements, words, paragraphs, pauses };
}
