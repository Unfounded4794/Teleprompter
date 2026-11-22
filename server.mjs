import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { extname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { localInterfaces } from './scripts/local-network.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const localHosts = new Set(['localhost', '127.0.0.1']);
const ttl = 60 * 60 * 1000;
const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.wasm': 'application/wasm',
};

export function createTeleprompterServer({ build = resolve(root, 'dist'), data = resolve(root, '.local') } = {}) {
  if (!existsSync(resolve(build, 'index.html'))) throw new Error('The Teleprompter web app is missing. Run the web build first.');
  const sessions = new Map();
  let desktop;
  let phone;
  let interfaces = [];
  let selectedHost = '';
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [id, session] of sessions) {
      if (now - session.updated > ttl) endSession(id, session);
      else for (const client of session.clients) client.write(': local connection\n\n');
    }
  }, 15_000).unref();

  function handler(scheme, hosts) {
    return (req, res) => {
      const host = hostname(req);
      if (!hosts.has(host)) return send(res, 400, { error: 'Unrecognized local address.' });
      const origin = scheme + '://' + req.headers.host;
      let url;
      try { url = new URL(req.url, origin); } catch { return send(res, 400, { error: 'Invalid address.' }); }
      if (url.origin !== origin) return send(res, 400, { error: 'Unrecognized local address.' });
      const response = url.pathname.startsWith('/api/') ? api(req, res, origin, url.pathname) : serveAsset(req, res, url, build, data);
      response.catch(error => {
        if (!res.headersSent) send(res, 500, { error: 'The local server could not complete this request.' });
        else res.destroy();
        if (!['ECONNRESET', 'EPIPE'].includes(error.code)) console.error(error.message);
      });
    };
  }

  async function startDesktop(port = 4173) {
    if (desktop) return state().desktopUrl;
    const server = createHttpServer(handler('http', localHosts));
    desktop = { server, port: await listen(server, port, '127.0.0.1') };
    return state().desktopUrl;
  }

  async function startPhone({ port = 8443, setupPort = 8080, addresses = localInterfaces() } = {}) {
    if (phone) return state();
    const { key, cert, ca, profile } = certificateFiles(data);
    if (![key, cert, ca, profile].every(existsSync)) {
      throw new Error('The local certificate is missing. Use the launcher’s phone setup or run npm run setup:lan.');
    }
    const hosts = new Set([...localHosts, ...addresses.map(item => item.address)]);
    const server = createHttpsServer({ key: readFileSync(key), cert: readFileSync(cert) }, handler('https', hosts));
    const securePort = await listen(server, port, '0.0.0.0');
    const setup = createHttpServer((req, res) => serveSetup(req, res, hosts, securePort, ca, profile));
    try {
      let publicPort;
      try { publicPort = await listen(setup, setupPort, '0.0.0.0'); }
      catch (error) {
        if (error.code !== 'EADDRINUSE') throw error;
        publicPort = await listen(setup, 0, '0.0.0.0');
      }
      interfaces = addresses;
      selectedHost = interfaces[0]?.address || '';
      phone = { server, setup, port: securePort, setupPort: publicPort };
      return state();
    } catch (error) {
      await closeListener(server);
      throw error;
    }
  }

  async function stopPhone() {
    if (!phone) return;
    const old = phone;
    phone = null;
    interfaces = [];
    selectedHost = '';
    for (const [id, session] of sessions) endSession(id, session);
    await Promise.all([closeListener(old.server), closeListener(old.setup)]);
  }

  function selectAddress(address) {
    if (interfaces.some(item => item.address === address)) selectedHost = address;
    return state();
  }

  async function close() {
    clearInterval(timer);
    await stopPhone();
    if (desktop) await closeListener(desktop.server);
    desktop = null;
  }

  function state() {
    return {
      desktopUrl: desktop ? 'http://localhost:' + desktop.port : '',
      phoneEnabled: Boolean(phone),
      selectedHost,
      addresses: phone ? interfaces.map(({ name, address }) => ({
        name, address,
        setupUrl: 'http://' + address + ':' + phone.setupPort,
      })) : [],
    };
  }

  return { startDesktop, startPhone, stopPhone, selectAddress, state, close };

  async function api(req, res, origin, path) {
    if (req.headers.origin && req.headers.origin !== origin) return send(res, 403, { error: 'Origin not allowed.' });
    if (path === '/api/network' && req.method === 'GET') {
      return send(res, 200, {
        lan: Boolean(phone),
        address: phone && ['localhost', '127.0.0.1'].includes(req.headers.host.split(':')[0]) && selectedHost
          ? 'https://' + selectedHost + ':' + phone.port : origin,
        setupAddress: phone ? 'http://' + (localHosts.has(hostname(req)) ? selectedHost : hostname(req)) + ':' + phone.setupPort : '',
      });
    }
    if (path === '/api/session' && req.method === 'POST') {
      if (!phone) return send(res, 409, { error: 'Enable phone setup in the desktop launcher to pair a device.' });
      if (sessions.size >= 24) return send(res, 503, { error: 'End an existing pairing and try again.' });
      const id = randomBytes(16).toString('hex');
      const key = randomBytes(24).toString('hex');
      const code = randomBytes(5).toString('hex');
      sessions.set(id, { code, key: hashKey(key), state: {}, clients: new Set(), controls: [], updated: Date.now() });
      return send(res, 201, { id, key, code: code.toUpperCase() });
    }
    const join = path.match(/^\/api\/join\/([a-f0-9]{10})$/);
    if (join && req.method === 'POST') {
      for (const [id, session] of sessions) {
        if (session.code === join[1]) return send(res, 200, { id, flipX: true, flipY: false });
      }
      return send(res, 404, { error: 'Pairing code not found.' });
    }
    const match = path.match(/^\/api\/session\/([a-f0-9]{32})(\/control)?$/);
    const id = match?.[1];
    const session = sessions.get(id);
    if (!session) return send(res, 404, { error: 'This pairing has ended.' });
    if (match[2] && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 1024) return send(res, 413, { error: 'Control request too large.' });
      }
      let command;
      try { command = JSON.parse(body); } catch { return send(res, 400, { error: 'Invalid control.' }); }
      const action = command?.action;
      const simple = ['play', 'pause', 'toggle', 'first', 'last', 'previous', 'next', 'hold', 'release'].includes(action);
      const seek = action === 'seek' && Number.isFinite(command.position) && command.position >= 0 && command.position <= 1_000_000;
      const adjust = ['speed', 'size'].includes(action) && Number.isFinite(command.amount) && Math.abs(command.amount) <= 800;
      if (!simple && !seek && !adjust) {
        return send(res, 400, { error: 'Invalid control.' });
      }
      const control = { action };
      if (seek) control.position = command.position;
      if (adjust) control.amount = command.amount;
      session.controls.push(control);
      session.controls = session.controls.slice(-20);
      return send(res, 200, { ok: true });
    }
    if (match[2]) return send(res, 405, { error: 'Method not allowed.' });
    if (req.method === 'GET') {
      if (session.clients.size >= 8) return send(res, 503, { error: 'Too many connected displays.' });
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store',
        'Connection': 'keep-alive', 'Cross-Origin-Resource-Policy': 'same-origin',
      });
      session.clients.add(res);
      res.on('close', () => session.clients.delete(res));
      res.write('data: ' + JSON.stringify(session.state) + '\n\n');
      return;
    }
    const key = req.headers['x-teleprompter-key'];
    if (typeof key !== 'string' || !timingSafeEqual(hashKey(key), session.key)) return send(res, 403, { error: 'This link is for viewing only.' });
    if (req.method === 'DELETE') {
      endSession(id, session);
      return send(res, 200, { ok: true });
    }
    if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed.' });
    const chunks = [];
    let bytes = 0;
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > 1_100_000) {
        send(res, 413, { error: 'This script is too large to share live.' });
        return;
      }
      chunks.push(chunk);
    }
    let update;
    try { update = JSON.parse(Buffer.concat(chunks)); } catch { return send(res, 400, { error: 'Invalid display update.' }); }
    if (!validUpdate(update)) return send(res, 400, { error: 'Invalid display update.' });
    session.updated = Date.now();
    session.state = { ...session.state, ...update };
    const packet = 'data: ' + JSON.stringify(update) + '\n\n';
    for (const client of session.clients) {
      if (client.writableLength > 2_000_000) client.destroy();
      else client.write(packet);
    }
    return send(res, 200, { ok: true, viewers: session.clients.size, controls: session.controls.splice(0) });
  }

  function validUpdate(item) {
    return item && typeof item === 'object' && !Array.isArray(item)
      && Number.isFinite(item.position) && item.position >= 0
      && Number.isFinite(item.speed) && item.speed >= 0 && item.speed <= 1200
      && (!('wordRate' in item) || (Number.isFinite(item.wordRate) && item.wordRate >= 0))
      && typeof item.playing === 'boolean' && ['timed', 'voice'].includes(item.mode)
      && (!('html' in item) || (typeof item.html === 'string' && item.html.length < 1_000_000))
      && (!('settings' in item) || Boolean(item.settings && typeof item.settings === 'object'));
  }

  function hashKey(key) {
    return createHash('sha256').update(key).digest();
  }

  function endSession(id, session) {
    sessions.delete(id);
    for (const client of session.clients) client.end('event: end\ndata: {}\n\n');
  }


}

async function serveAsset(req, res, url, build, local) {
  if (!['GET', 'HEAD'].includes(req.method)) return send(res, 405, { error: 'Method not allowed.' });
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch { return send(res, 400, { error: 'Invalid address.' }); }
  if (pathname.includes('\\') || pathname.includes('\0')) return send(res, 400, { error: 'Invalid address.' });
  let allowedRoot = build;
  if (pathname.startsWith('/models/')) {
    if (!/^\/models\/(tiny|base|small|turbo)\/(?:[a-z_]+\.json|onnx\/[a-z0-9_]+\.onnx)$/.test(pathname)) {
      return send(res, 404, { error: 'Voice model asset unavailable.' });
    }
    allowedRoot = resolve(local, 'models');
    pathname = pathname.slice('/models'.length);
  }
  const path = resolve(allowedRoot, '.' + (pathname === '/' ? '/index.html' : pathname));
  const fromRoot = relative(allowedRoot, path);
  if (!fromRoot || fromRoot.startsWith('..')) return send(res, 404, { error: 'Not found.' });
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) return send(res, 404, { error: 'Not found on this computer.' });

  res.writeHead(200, {
    'Content-Type': types[extname(path)] || 'application/octet-stream',
    'Content-Length': info.size,
    'Cache-Control': pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Content-Security-Policy': pathname === '/runtime/vosk-worker-0.0.8.js'
      ? "default-src 'none'; script-src 'unsafe-eval'; connect-src 'self'; frame-ancestors 'none'; sandbox allow-same-origin allow-scripts"
      : "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; worker-src 'self' blob:; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  if (req.method === 'HEAD') return res.end();
  const stream = createReadStream(path);
  res.on('close', () => stream.destroy());
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

function hostname(req) {
  return req.headers.host?.split(':')[0];
}

function certificateFiles(data) {
  const directory = resolve(data, 'certs');
  return {
    key: resolve(directory, 'server-key.pem'),
    cert: resolve(directory, 'server.pem'),
    ca: resolve(directory, 'teleprompter-ca.cer'),
    profile: resolve(directory, 'teleprompter-ca.mobileconfig'),
  };
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve(server.address().port);
    });
  });
}

function closeListener(server) {
  return new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections();
  });
}

function serveSetup(req, res, hosts, securePort, ca, profile) {
  const host = hostname(req);
  if (!hosts.has(host) || req.method !== 'GET') return send(res, 400, { error: 'Open this setup page using the PC’s local address.' });
  if (req.url === '/teleprompter-ca.mobileconfig') {
    return sendFile(res, profile, 'application/x-apple-aspen-config');
  }
  if (req.url === '/teleprompter-ca.cer') return sendFile(res, ca, 'application/x-x509-ca-cert');
  const setupUrl = new URL(req.url, 'http://' + req.headers.host);
  const pairingId = setupUrl.pathname.match(/^\/display\/([a-f0-9]{32})$/)?.[1];
  if (setupUrl.pathname !== '/' && !pairingId) return send(res, 404, { error: 'Not found.' });
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
  let appUrl = 'https://' + host + ':' + securePort + '/';
  if (pairingId) appUrl += '?pair=' + pairingId + '&amp;x=' + (setupUrl.searchParams.get('x') === '1' ? '1' : '0') + '&amp;y=' + (setupUrl.searchParams.get('y') === '1' ? '1' : '0');
  res.end('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Install Teleprompter</title><style>body{margin:0;background:#101118;color:#f3efff;font:16px/1.55 system-ui,sans-serif}main{max-width:34em;margin:auto;padding:2em 1.1em}li{margin:1em 0}a{color:#c8b7ff}h1{letter-spacing:-.05em;line-height:1.1}</style><main><h1>Teleprompter setup</h1><p><a href="' + appUrl + '"><strong>Open Teleprompter</strong></a>. On a new device, first follow the certificate steps below. On a computer, import the public certificate into its browser or system trust store.</p><ol><li><a href="/teleprompter-ca.mobileconfig"><strong>Download the certificate profile</strong></a> for this computer.</li><li>In Settings, tap <strong>Profile Downloaded</strong> and install <strong>Teleprompter Local CA</strong>.</li><li>Under <strong>Settings → General → About → Certificate Trust Settings</strong>, enable full trust for Teleprompter Local CA.</li><li><a href="' + appUrl + '"><strong>Open Teleprompter in Safari</strong></a>, then tap <strong>Share → Add to Home Screen</strong>.</li><li>Launch it from the Home Screen once and wait for <strong>Offline ready</strong>.</li></ol><p><a href="/teleprompter-ca.cer">Public certificate for a desktop browser</a></p></main></html>');
}

function sendFile(res, path, type) {
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  const stream = createReadStream(path);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

function send(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const lan = process.argv.includes('--lan');
  try {
    const server = createTeleprompterServer();
    if (lan) {
      const state = await server.startPhone({
        port: Number(process.env.TELEPROMPTER_PORT || 8443),
        setupPort: Number(process.env.TELEPROMPTER_SETUP_PORT || 8080),
      });
      for (const { name, setupUrl } of state.addresses) {
        console.log('One-time certificate setup (' + name + '): ' + setupUrl);
      }
    } else {
      console.log('Local: ' + await server.startDesktop(Number(process.env.TELEPROMPTER_PORT || 4173)));
    }
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
