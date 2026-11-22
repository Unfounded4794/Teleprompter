import { createWriteStream } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { resolve, dirname, relative, isAbsolute } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

export const voiceModels = {
  tiny: { repo: 'whisper-tiny', dtype: 'q8', suffix: 'quantized', label: 'Lightweight', size: '42 MB' },
  base: { repo: 'whisper-base', dtype: 'q8', suffix: 'quantized', label: 'Compact', size: '80 MB' },
  small: { repo: 'whisper-small', dtype: 'q8', suffix: 'quantized', label: 'Balanced', size: '252 MB' },
  turbo: { repo: 'whisper-large-v3-turbo', dtype: 'q4f16', suffix: 'q4f16', label: 'High accuracy', size: '568 MB' },
};

function modelConfig(choice) {
  if (!Object.hasOwn(voiceModels, choice)) throw new Error('Choose Lightweight, Compact, Balanced, or High accuracy.');
  const model = voiceModels[choice];
  return {
    ...model,
    files: [
      'config.json', 'generation_config.json', 'preprocessor_config.json', 'tokenizer.json', 'tokenizer_config.json',
      'onnx/encoder_model_' + model.suffix + '.onnx',
      'onnx/decoder_model_merged_' + model.suffix + '.onnx',
    ],
  };
}

export async function preparedVoice(directory, choice) {
  const { dtype, files, repo } = modelConfig(choice);
  const root = resolve(directory, choice);
  const manifest = await readFile(resolve(root, 'manifest.json'), 'utf8').then(JSON.parse).catch(() => null);
  if (manifest?.choice !== choice || manifest.dtype !== dtype || manifest.repo !== 'onnx-community/' + repo
    || !/^[a-f0-9]{40}$/.test(manifest.revision) || !Array.isArray(manifest.files)
    || manifest.files.length !== files.length || !files.every(file => manifest.files.includes(file))) return null;
  const realRoot = await realpath(root);
  const available = await Promise.all(files.map(async file => {
    const path = resolve(root, file);
    const [info, canonical] = await Promise.all([lstat(path).catch(() => null), realpath(path).catch(() => null)]);
    if (!info?.isFile() || !canonical || !info.size || info.size !== manifest.bytes?.[file]) return false;
    const nested = relative(realRoot, canonical);
    return Boolean(nested) && !nested.startsWith('..') && !isAbsolute(nested);
  }));
  return available.every(Boolean) ? manifest : null;
}

export async function installVoiceFromFolder(source, directory, choice, progress = () => {}) {
  const manifest = await preparedVoice(source, choice);
  if (!manifest) return false;
  const current = await preparedVoice(directory, choice);
  if (current?.revision === manifest.revision) return true;
  const destination = resolve(directory, choice);
  await mkdir(destination, { recursive: true });
  await rm(resolve(destination, 'manifest.json'), { force: true });
  for (const [index, file] of manifest.files.entries()) {
    const target = resolve(destination, file);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(resolve(source, choice, file), target);
    await progress({ file, completed: index + 1, total: manifest.files.length, bytes: manifest.bytes[file] });
  }
  await placeManifest(destination, manifest);
  return true;
}

export async function downloadVoice(directory, choice, { progress = () => {}, signal } = {}) {
  const prior = await preparedVoice(directory, choice);
  if (prior) return prior;
  const { files, dtype, repo } = modelConfig(choice);
  const output = resolve(directory, choice);
  const origin = 'https://huggingface.co/onnx-community/' + repo;
  const metadata = await (await request('https://huggingface.co/api/models/onnx-community/' + repo, {}, signal)).json();
  const revision = metadata.sha;
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('Could not resolve the model revision.');

  await mkdir(output, { recursive: true });
  await rm(resolve(output, 'manifest.json'), { force: true });
  const entries = [];
  for (const [index, file] of files.entries()) {
    const target = resolve(output, file);
    const partial = target + '.' + revision + '.download';
    await mkdir(dirname(target), { recursive: true });
    let downloaded = 0;
    for (let attempt = 0; attempt < 3; attempt++) {
      signal?.throwIfAborted();
      const url = origin + '/resolve/' + revision + '/' + file + '?download=true&attempt=' + attempt;
      downloaded = (await lstat(partial).catch(() => null))?.size || 0;
      try {
        const response = await request(url, downloaded ? { Range: 'bytes=' + downloaded + '-' } : {}, signal);
        const range = response.headers.get('content-range');
        const append = downloaded > 0 && response.status === 206 && range?.startsWith('bytes ' + downloaded + '-');
        if (response.status === 206 && !append) throw new Error('Unexpected size for ' + file);
        const length = Number(append ? range.split('/')[1] : response.headers.get('content-length'));
        let last = 0;
        let bytes = append ? downloaded : 0;
        await pipeline(response.body, async function* (chunks) {
          for await (const chunk of chunks) {
            signal?.throwIfAborted();
            bytes += chunk.length;
            const now = Date.now();
            if (now - last > 650) {
              await progress({ file, completed: index, total: files.length, percent: length ? Math.floor(bytes / length * 100) : null });
              last = now;
            }
            yield chunk;
          }
        }, createWriteStream(partial, { flags: append ? 'a' : 'w' }));
        const result = (await lstat(partial)).size;
        if (!result || (length && result !== length)) throw new Error('Incomplete download for ' + file);
        await rename(partial, target);
        downloaded = result;
        break;
      } catch (error) {
        if (signal?.aborted || attempt === 2) throw error;
        if (error.status === 416) await rm(partial, { force: true });
      }
    }
    entries.push([file, downloaded]);
    await progress({ file, completed: index + 1, total: files.length, bytes: downloaded });
  }
  const manifest = { choice, dtype, repo: 'onnx-community/' + repo, revision, files, bytes: Object.fromEntries(entries) };
  await placeManifest(output, manifest);
  return manifest;
}

async function placeManifest(output, manifest) {
  const manifestPath = resolve(output, 'manifest.json');
  await writeFile(manifestPath + '.tmp', JSON.stringify(manifest, null, 2));
  await rename(manifestPath + '.tmp', manifestPath);
}

async function request(url, headers, signal) {
  const timeout = AbortSignal.timeout(300_000);
  const response = await fetch(url, { headers, signal: signal ? AbortSignal.any([timeout, signal]) : timeout });
  if (!response.ok) {
    const reason = new Error('The voice download returned HTTP ' + response.status + '.');
    reason.status = response.status;
    throw reason;
  }
  return response;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const choice = process.argv[2] || 'base';
  try {
    await downloadVoice(resolve('.local', 'models'), choice, {
      progress: ({ file, bytes }) => {
        if (bytes) console.log(file + ' · ' + Math.max(1, Math.round(bytes / 1e6)) + ' MB');
      },
    });
    console.log('Ready. Open Voice follow and select Prepare on this device.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
