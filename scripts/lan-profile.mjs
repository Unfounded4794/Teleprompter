import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function writeLanProfile(directory, certificate) {
  const profile = resolve(directory, 'teleprompter-ca.mobileconfig');
  const encoded = certificate.toString('base64');
  if (existsSync(profile) && readFileSync(profile, 'utf8').includes(encoded)) return;
  const id = 'local.teleprompter.ca.' + createHash('sha256').update(certificate).digest('hex').slice(0, 16);
  writeFileSync(profile, [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0"><dict>',
    '<key>PayloadType</key><string>Configuration</string>',
    '<key>PayloadVersion</key><integer>1</integer>',
    '<key>PayloadIdentifier</key><string>' + id + '</string>',
    '<key>PayloadUUID</key><string>' + randomUUID() + '</string>',
    '<key>PayloadDisplayName</key><string>Teleprompter Local CA</string>',
    '<key>PayloadDescription</key><string>Installs the certificate for the Teleprompter server on this local network.</string>',
    '<key>PayloadContent</key><array><dict>',
    '<key>PayloadType</key><string>com.apple.security.root</string>',
    '<key>PayloadVersion</key><integer>1</integer>',
    '<key>PayloadIdentifier</key><string>' + id + '.root</string>',
    '<key>PayloadUUID</key><string>' + randomUUID() + '</string>',
    '<key>PayloadDisplayName</key><string>Teleprompter Local CA</string>',
    '<key>PayloadCertificateFileName</key><string>teleprompter-ca.cer</string>',
    '<key>PayloadContent</key><data>' + encoded + '</data>',
    '</dict></array></dict></plist>',
  ].join('\n'));
}
