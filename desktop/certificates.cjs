const { X509Certificate, createPrivateKey, createPublicKey, generateKeyPair, randomBytes } = require('node:crypto');
const { mkdir, readFile, writeFile } = require('node:fs/promises');
const { join } = require('node:path');
const { promisify } = require('node:util');
const forge = require('node-forge');

const generate = promisify(generateKeyPair);
const { pki } = forge;
const day = 86_400_000;

async function prepareCertificates(directory, addresses, writeProfile) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const rootPath = join(directory, 'ca.pem');
  const rootKeyPath = join(directory, 'ca-key.pem');
  let root = await readPair(rootPath, rootKeyPath);
  if (!root || !root.cert.ca || expiresSoon(root.cert, 7)) {
    const key = await keys(3072);
    const ca = certificate(key, 'Teleprompter Local CA', 1825);
    ca.setIssuer(ca.subject.attributes);
    ca.setExtensions([
      { name: 'basicConstraints', critical: true, cA: true, pathLenConstraint: 0 },
      { name: 'keyUsage', critical: true, keyCertSign: true, cRLSign: true },
      { name: 'subjectKeyIdentifier' },
    ]);
    ca.sign(pki.privateKeyFromPem(key.privateKey), forge.md.sha256.create());
    const pem = pki.certificateToPem(ca);
    await writeFile(rootKeyPath, key.privateKey, { mode: 0o600 });
    await writeFile(rootPath, pem);
    root = { pem, key: key.privateKey, cert: new X509Certificate(pem) };
  }
  await writeFile(join(directory, 'teleprompter-ca.cer'), root.cert.raw);
  writeProfile(directory, root.cert.raw);

  const hosts = [...new Set(['127.0.0.1', ...addresses])];
  const serverPath = join(directory, 'server.pem');
  const serverKeyPath = join(directory, 'server-key.pem');
  const existing = await readPair(serverPath, serverKeyPath);
  if (existing && !expiresSoon(existing.cert, 7)
    && existing.cert.verify(root.cert.publicKey) && existing.cert.checkHost('localhost')
    && hosts.every(host => existing.cert.checkIP(host))) return;

  const key = await keys(2048);
  const leaf = certificate(key, 'Teleprompter Local', 365);
  leaf.setIssuer(pki.certificateFromPem(root.pem).subject.attributes);
  leaf.setExtensions([
    { name: 'basicConstraints', critical: true, cA: false },
    { name: 'keyUsage', critical: true, digitalSignature: true, keyEncipherment: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }, ...hosts.map(ip => ({ type: 7, ip }))] },
    { name: 'subjectKeyIdentifier' },
  ]);
  leaf.sign(pki.privateKeyFromPem(root.key), forge.md.sha256.create());
  await writeFile(serverKeyPath, key.privateKey, { mode: 0o600 });
  await writeFile(serverPath, pki.certificateToPem(leaf));
}

async function readPair(certPath, keyPath) {
  try {
    const [pem, key] = await Promise.all([readFile(certPath, 'utf8'), readFile(keyPath, 'utf8')]);
    const cert = new X509Certificate(pem);
    const publicKey = createPublicKey(createPrivateKey(key));
    return cert.publicKey.equals(publicKey) ? { cert, pem, key } : null;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function keys(modulusLength) {
  return generate('rsa', {
    modulusLength,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  });
}

function certificate(keys, name, days) {
  const cert = pki.createCertificate();
  cert.publicKey = pki.publicKeyFromPem(keys.publicKey);
  cert.serialNumber = '01' + randomBytes(15).toString('hex');
  cert.validity.notBefore = new Date(Date.now() - 300_000);
  cert.validity.notAfter = new Date(Date.now() + days * day);
  cert.setSubject([{ name: 'commonName', value: name }]);
  return cert;
}

function expiresSoon(cert, days) {
  return Date.parse(cert.validTo) - Date.now() < days * day;
}

module.exports = { prepareCertificates };
