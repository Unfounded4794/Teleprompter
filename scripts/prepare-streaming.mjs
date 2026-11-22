import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import JSZip from 'jszip';

const upstreamName = 'vosk-model-small-en-us-0.15';
const checksum = '30f26242c4eb449f948e42cb302dd7a686cb29a3423a8367f99ff41780942498';
const directory = resolve('.local/streaming');
const destination = resolve(directory, 'vosk-en-0.15.tar.gz');
await mkdir(directory, { recursive: true });

const input = process.argv[2];
const data = input ? await readFile(input) : await download();
if (createHash('sha256').update(data).digest('hex') !== checksum) {
  throw new Error('The English streaming model download did not match the expected checksum.');
}

const zip = await JSZip.loadAsync(data);
const work = await mkdtemp(resolve(directory, 'repack-'));
try {
  for (const entry of Object.values(zip.files)) {
    if (entry.dir) continue;
    const file = resolve(work, entry.name);
    if (!file.startsWith(resolve(work, upstreamName) + sep)) {
      throw new Error('Unexpected member in the English speech model.');
    }
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, await entry.async('nodebuffer'));
  }
  const packed = resolve(work, 'model.tar.gz');
  execFileSync('tar', ['-czf', packed, '-C', work, upstreamName]);
  await rename(packed, destination);
  console.log('Prepared the offline English streaming model at ' + destination);
} finally {
  if (dirname(await realpath(work)) === await realpath(directory)) await rm(work, { recursive: true, force: true });
}

async function download() {
  const response = await fetch('https://alphacephei.com/vosk/models/' + upstreamName + '.zip', { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error('Could not download the English streaming model: HTTP ' + response.status);
  return Buffer.from(await response.arrayBuffer());
}
