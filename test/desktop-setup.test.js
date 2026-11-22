import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { get } from 'node:https';
import { X509Certificate } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { createTeleprompterServer } from '../server.mjs';
import { writeLanProfile } from '../scripts/lan-profile.mjs';

const require = createRequire(import.meta.url);
const { prepareCertificates } = require('../desktop/certificates.cjs');

test('GUI certificate setup reuses trust and serves desktop, phone install, and pairing', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'teleprompter-setup-test-'));
  const data = join(directory, 'data');
  const certs = join(data, 'certs');
  const server = createTeleprompterServer({ data });
  t.after(async () => {
    await server.close();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    await rm(directory, { recursive: true, force: true });
  });
  await prepareCertificates(certs, ['127.0.0.1'], writeLanProfile);
  const ca = await readFile(join(certs, 'ca.pem'));
  const root = new X509Certificate(ca);
  assert.equal(root.ca, true);
  const firstProfile = await readFile(join(certs, 'teleprompter-ca.mobileconfig'), 'utf8');
  assert.ok(firstProfile.includes(root.raw.toString('base64')));
  await prepareCertificates(certs, ['127.0.0.1', '10.20.30.40'], writeLanProfile);
  assert.deepEqual(await readFile(join(certs, 'ca.pem')), ca);
  assert.equal(await readFile(join(certs, 'teleprompter-ca.mobileconfig'), 'utf8'), firstProfile);
  assert.ok(new X509Certificate(await readFile(join(certs, 'server.pem'))).checkIP('10.20.30.40'));

  const desktop = await server.startDesktop(0);
  assert.equal((await fetch(desktop)).status, 200);
  const state = await server.startPhone({ port: 0, setupPort: 0, addresses: [{ name: 'Test network', address: '127.0.0.1' }] });
  assert.equal(state.phoneEnabled, true);
  const setup = state.addresses[0].setupUrl;
  const html = await (await fetch(setup)).text();
  assert.match(html, /Download the certificate profile/);
  const address = html.match(/https:\/\/127\.0\.0\.1:\d+\//)[0];
  await new Promise((resolve, reject) => get(address, { ca }, response => {
    assert.equal(response.statusCode, 200);
    response.resume();
    response.on('end', resolve);
  }).on('error', reject));
  const created = await (await fetch(desktop + '/api/session', { method: 'POST' })).json();
  assert.match(created.code, /^[A-F0-9]{10}$/);
  const joined = await fetch(desktop + '/api/join/' + created.code.toLowerCase(), { method: 'POST' });
  assert.deepEqual(await joined.json(), { id: created.id, flipX: true, flipY: false });
  const update = { position: 2, playing: true, speed: 120, mode: 'timed', html: '<p>Hello</p>' };
  const result = await fetch(desktop + '/api/session/' + created.id, {
    method: 'POST', headers: { 'X-Teleprompter-Key': created.key }, body: JSON.stringify(update),
  });
  assert.equal(result.status, 200);
  const network = await (await fetch(desktop + '/api/network')).json();
  assert.equal(network.setupAddress, setup);
  const onboarding = await (await fetch(setup + '/display/' + created.id + '?x=1&y=0')).text();
  assert.ok(onboarding.includes(address + '?pair=' + created.id + '&amp;x=1&amp;y=0'));
  const controlUrl = desktop + '/api/session/' + created.id + '/control';
  assert.equal((await fetch(controlUrl, { method: 'POST', body: JSON.stringify({ action: 'seek', position: -1 }) })).status, 400);
  assert.equal((await fetch(controlUrl, { method: 'POST', body: JSON.stringify({ action: 'pause' }) })).status, 200);
  assert.equal((await fetch(controlUrl, { method: 'POST', body: JSON.stringify({ action: 'speed', amount: 25 }) })).status, 200);
  assert.equal((await fetch(desktop + '/api/session/' + created.id, { method: 'POST', body: JSON.stringify(update) })).status, 403);
  const drainControls = () => fetch(desktop + '/api/session/' + created.id, {
    method: 'POST', headers: { 'X-Teleprompter-Key': created.key }, body: JSON.stringify(update),
  }).then(response => response.json());
  assert.deepEqual((await drainControls()).controls, [{ action: 'pause' }, { action: 'speed', amount: 25 }]);
  assert.deepEqual((await drainControls()).controls, []);
  await server.stopPhone();
  assert.equal((await fetch(desktop + '/api/join/' + created.code.toLowerCase(), { method: 'POST' })).status, 404);
  assert.equal(server.state().phoneEnabled, false);
  assert.equal((await fetch(desktop)).status, 200);
  assert.equal((await fetch(desktop + '/api/session/' + created.id)).status, 404);
});

test('a port conflict leaves the GUI server available for retry', async t => {
  const blocker = createServer();
  await new Promise(resolve => blocker.listen(0, '127.0.0.1', resolve));
  const server = createTeleprompterServer();
  t.after(async () => { blocker.close(); await server.close(); });
  const port = blocker.address().port;
  await assert.rejects(server.startDesktop(port), { code: 'EADDRINUSE' });
  assert.equal(server.state().desktopUrl, '');
  await new Promise(resolve => blocker.close(resolve));
  assert.ok(await server.startDesktop(port));
});
