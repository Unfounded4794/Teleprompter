import { plainHtml, sanitizeScript } from './script.js';

const MAX_FILE_BYTES = 50 * 1024 * 1024;

export async function readScript(file) {
  if (file.size > MAX_FILE_BYTES) throw new Error('Choose a script file under 50 MB.');
  const extension = file.name.split('.').at(-1)?.toLowerCase();
  let html;
  if (extension === 'docx') {
    const mammoth = (await import('mammoth/mammoth.browser.js')).default;
    const result = await mammoth.convertToHtml({ arrayBuffer: await file.arrayBuffer() }, {
      convertImage: mammoth.images.imgElement(() => ({ src: '' })),
    });
    html = result.value;
  } else if (extension === 'pdf') {
    html = plainHtml(await extractPdf(file));
  } else if (['md', 'markdown'].includes(extension)) {
    const { marked } = await import('marked');
    html = marked.parse(await decodeText(file));
  } else if (['html', 'htm'].includes(extension)) {
    const source = new DOMParser().parseFromString(await decodeText(file), 'text/html');
    html = source.body.innerHTML;
  } else if (extension === 'rtf') {
    html = plainHtml(extractRtf(await decodeText(file)));
  } else if (extension === 'txt' || file.type === 'text/plain') {
    html = plainHtml(await decodeText(file));
  } else {
    throw new Error('Choose TXT, Markdown, Word (.docx), PDF, RTF, or HTML.');
  }
  html = sanitizeScript(html);
  const check = document.createElement('template');
  check.innerHTML = html;
  if (!check.content.textContent.trim()) throw new Error('This file contains no readable script text.');
  return { title: file.name.replace(/\.[^.]+$/, '').slice(0, 150), html };
}

async function decodeText(file) {
  const data = new Uint8Array(await file.arrayBuffer());
  const encoding = data[0] === 0xff && data[1] === 0xfe ? 'utf-16le'
    : data[0] === 0xfe && data[1] === 0xff ? 'utf-16be' : 'utf-8';
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(data);
  } catch {
    return new TextDecoder('windows-1250').decode(data);
  }
}

async function extractPdf(file) {
  const [pdf, worker] = await Promise.all([
    import('pdfjs-dist/legacy/build/pdf.mjs'),
    import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'),
  ]);
  pdf.GlobalWorkerOptions.workerSrc = worker.default;
  const task = pdf.getDocument({
    data: await file.arrayBuffer(),
    isEvalSupported: false,
    useSystemFonts: true,
    cMapUrl: '/pdf/cmaps/',
    cMapPacked: true,
    standardFontDataUrl: '/pdf/standard_fonts/',
    wasmUrl: '/pdf/wasm/',
    iccUrl: '/pdf/iccs/',
  });
  try {
    const document = await task.promise;
    const pages = [];
    for (let number = 1; number <= document.numPages; number++) {
      const page = await document.getPage(number);
      const content = await page.getTextContent();
      let text = '';
      let lastBaseline;
      for (const item of content.items) {
        if (!('str' in item)) continue;
        const baseline = item.transform[5];
        if (lastBaseline !== undefined && Math.abs(baseline - lastBaseline) > Math.max(3, item.height * .45) && !text.endsWith('\n')) {
          text = text.trimEnd() + '\n';
        }
        text += item.str + (item.hasEOL ? '\n' : ' ');
        lastBaseline = baseline;
      }
      pages.push(text.trim());
      page.cleanup();
    }
    const extracted = pages.filter(Boolean).join('\n\n');
    if (!extracted) throw new Error('This PDF has no selectable text. Use a text export or an OCR copy.');
    return extracted;
  } finally {
    await task.destroy();
  }
}

function extractRtf(rtf) {
  const pieces = rtf.match(/\\'[0-9a-fA-F]{2}|\\[a-z]+-?\d* ?|\\[^a-z]|[{}]|[^{}\\]+/g) || [];
  const ignored = new Set(['fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'object', 'header', 'footer', 'listtable', 'listoverridetable']);
  const levels = [{ ignore: false, skip: 1 }];
  let fallback = 0;
  let codePage = 'windows-1252';
  let result = '';
  for (const token of pieces) {
    const level = levels.at(-1);
    if (token === '{') { levels.push({ ...level }); continue; }
    if (token === '}') { if (levels.length > 1) levels.pop(); continue; }
    if (token === '\\*') { level.ignore = true; continue; }
    const control = token.match(/^\\([a-z]+)(-?\d*) ?$/);
    if (control) {
      const [, name, parameter] = control;
      if (ignored.has(name)) level.ignore = true;
      if (level.ignore) continue;
      if (name === 'ansicpg' && ['1250', '1252'].includes(parameter)) codePage = 'windows-' + parameter;
      if (name === 'uc') level.skip = Math.max(0, Number(parameter));
      if (name === 'u') {
        result += String.fromCharCode(Number(parameter) & 0xffff);
        fallback = level.skip;
      }
      if (name === 'par' || name === 'line') result += '\n';
      if (name === 'tab') result += '\t';
      if (name === 'emdash') result += '—';
      if (name === 'endash') result += '–';
      continue;
    }
    if (level.ignore) continue;
    let text = token.replace(/[\r\n]/g, '');
    if (token.startsWith("\\'")) text = new TextDecoder(codePage).decode(Uint8Array.of(parseInt(token.slice(2), 16)));
    else if (token.startsWith('\\')) text = token === '\\~' ? ' ' : '{}\\'.includes(token[1]) ? token[1] : '';
    const skipped = Math.min(fallback, text.length);
    fallback -= skipped;
    result += text.slice(skipped);
  }
  return result.trim();
}
