import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { cp, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

const version = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;

export default defineConfig({
  build: { target: 'safari16.4', assetsInlineLimit: 0, chunkSizeWarningLimit: 1800 },
  worker: { format: 'es' },
  plugins: [{
    name: 'local-assets-and-offline-cache',
    transformIndexHtml: html => html.replaceAll('%APP_VERSION%', version),
    async closeBundle() {
      const dist = resolve('dist');
      for (const directory of ['cmaps', 'iccs', 'standard_fonts', 'wasm']) {
        await cp(resolve('node_modules/pdfjs-dist', directory), resolve(dist, 'pdf', directory), { recursive: true });
      }
      const runtime = resolve(dist, 'runtime');
      await mkdir(runtime, { recursive: true });
      const streaming = await buildStreamingRuntime(runtime);
      const ort = resolve('node_modules/onnxruntime-web/dist');
      const runtimeFiles = [];
      const runtimeSizes = {};
      const runtimeHash = createHash('sha256');
      let runtimeBytes = 0;
      for (const file of await readdir(ort)) {
        if (/^ort-wasm-.*\.(mjs|wasm)$/.test(file)) {
          await cp(resolve(ort, file), resolve(runtime, file));
          const bytes = await readFile(resolve(runtime, file));
          runtimeHash.update(bytes);
          runtimeBytes += bytes.length;
          runtimeFiles.push('/runtime/' + file);
          runtimeSizes['/runtime/' + file] = bytes.length;
        }
      }
      await writeFile(resolve(runtime, 'manifest.json'), JSON.stringify({
        version: runtimeHash.digest('hex').slice(0, 16), files: runtimeFiles, bytes: runtimeBytes, sizes: runtimeSizes, streaming,
      }));
      const assets = (await readdir(dist, { recursive: true, withFileTypes: true }))
        .filter(entry => entry.isFile())
        .map(entry => resolve(entry.parentPath, entry.name).slice(dist.length).replaceAll('\\', '/'))
        .sort();
      const hash = createHash('sha256');
      for (const asset of assets) hash.update(await readFile(dist + asset));
      const template = await readFile('src/service-worker.js', 'utf8');
      const content = template.replace('__VERSION__', hash.digest('hex').slice(0, 16))
        .replace('["__ASSETS__"]', JSON.stringify(assets));
      await writeFile(resolve(dist, 'sw.js'), content);
    },
  }],
});

async function buildStreamingRuntime(runtime) {
  const model = 'vosk-en-0.15.tar.gz';
  const source = resolve('.local/streaming', model);
  const info = await stat(source).catch(() => null);
  if (!info?.isFile()) return null;

  // Use the pinned package's worker directly, so the compiler glue runs under
  // a separate policy and the application's pages retain their existing CSP.
  const library = await readFile('node_modules/vosk-browser/dist/vosk.js', 'utf8');
  const marker = "var WorkerFactory = createBase64WorkerFactory('";
  const offset = library.indexOf(marker);
  if (offset < 0) throw new Error('Could not find the packaged Vosk worker.');
  const start = offset + marker.length;
  const encoded = library.slice(start, library.indexOf("'", start));
  if (encoded.length < 100_000) throw new Error('The packaged Vosk worker is incomplete.');
  const worker = 'vosk-worker-0.0.8.js';
  await writeFile(resolve(runtime, worker), Buffer.from(encoded, 'base64'));
  await cp(source, resolve(runtime, model));
  const apacheLicense = await readFile('node_modules/@huggingface/transformers/LICENSE', 'utf8');
  await writeFile(resolve(runtime, 'vosk-license.txt'),
    'Vosk Browser 0.0.8 by Ciaran O’Reilly (https://github.com/ccoreilly/vosk-browser).\n'
    + 'Vosk small US English model 0.15 by Alpha Cephei and contributors (https://alphacephei.com/vosk/models).\n'
    + 'Both are distributed under the Apache License, Version 2.0.\n\n' + apacheLicense);
  return { worker: '/runtime/' + worker, model: '/runtime/' + model, bytes: info.size };
}
