import { networkInterfaces } from 'node:os';

export function localInterfaces() {
  return Object.entries(networkInterfaces()).flatMap(([name, addresses]) =>
    addresses.filter(info => info.family === 'IPv4' && !info.internal).map(info => ({
      name,
      address: info.address,
      priority: info.address.startsWith('169.254.') ? 2 : /virtual|vethernet|docker|wsl|vpn|vmware|bluetooth/i.test(name) ? 1 : 0,
    })),
  ).sort((left, right) => left.priority - right.priority);
}
