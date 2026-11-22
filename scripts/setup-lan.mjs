import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isIPv4 } from 'node:net';
import { localInterfaces } from './local-network.mjs';
import { writeLanProfile } from './lan-profile.mjs';

const base = resolve('.local', 'certs');
mkdirSync(base, { recursive: true, mode: 0o700 });
const gitOpenSSL = 'C:\\Program Files\\Git\\usr\\bin\\openssl.exe';
const openssl = process.env.TELEPROMPTER_OPENSSL || (process.platform === 'win32' && existsSync(gitOpenSSL) ? gitOpenSSL : 'openssl');
const extra = process.argv.slice(2);
if (extra.some(value => !isIPv4(value))) throw new Error('Use IPv4 addresses such as 192.168.1.30.');
const localAddresses = localInterfaces().map(item => item.address);
const addresses = [...new Set(['127.0.0.1', ...localAddresses, ...extra])];
const ca = resolve(base, 'ca.pem');
const key = resolve(base, 'ca-key.pem');
if (!existsSync(ca) || !existsSync(key)) {
  run('req', '-x509', '-newkey', 'rsa:3072', '-nodes', '-sha256', '-days', '1825', '-keyout', key, '-out', ca,
    '-subj', '/CN=Teleprompter Local CA',
    '-addext', 'basicConstraints=critical,CA:true,pathlen:0',
    '-addext', 'keyUsage=critical,keyCertSign,cRLSign');
}
const publicCertificate = resolve(base, 'teleprompter-ca.cer');
run('x509', '-in', ca, '-outform', 'der', '-out', publicCertificate);
writeLanProfile(base, readFileSync(publicCertificate));
const extensions = resolve(base, 'server.ext');
const names = ['DNS:localhost', ...addresses.map(ip => 'IP:' + ip)];
writeFileSync(extensions, [
  'basicConstraints=critical,CA:false',
  'keyUsage=critical,digitalSignature,keyEncipherment',
  'extendedKeyUsage=serverAuth',
  'subjectAltName=' + names.join(','),
  '',
].join('\n'));
const csr = resolve(base, 'server.csr');
run('req', '-new', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-keyout', resolve(base, 'server-key.pem'), '-out', csr,
  '-subj', '/CN=Teleprompter Local');
run('x509', '-req', '-in', csr, '-CA', ca, '-CAkey', key, '-CAcreateserial', '-days', '365',
  '-sha256', '-extfile', extensions, '-out', resolve(base, 'server.pem'));
console.log('Local HTTPS is ready for ' + addresses.join(', ') + '. Start it with npm run lan.');

function run(...args) {
  const result = spawnSync(openssl, args, { encoding: 'utf8', windowsHide: true });
  if (result.error) throw new Error('OpenSSL is required. Use Git for Windows or set TELEPROMPTER_OPENSSL to the OpenSSL executable.', { cause: result.error });
  if (result.status !== 0) throw new Error(result.stderr || 'OpenSSL failed.');
}

