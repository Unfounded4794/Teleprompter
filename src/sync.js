export class DisplaySync {
  constructor(onFailure, onControl = () => {}, onViewers = () => {}) {
    this.onFailure = onFailure;
    this.onControl = onControl;
    this.onViewers = onViewers;
    this.id = sessionStorage.getItem('teleprompter-operator') || makeId();
    sessionStorage.setItem('teleprompter-operator', this.id);
    this.channel = new BroadcastChannel('teleprompter:' + this.id);
    this.channel.onmessage = event => {
      if (event.data?.type === 'hello' && this.current) this.channel.postMessage(this.current);
      if (event.data?.type === 'control') this.onControl(event.data);
    };
  }

  publish(state, version) {
    this.current = state;
    if (version !== this.localVersion) {
      this.channel.postMessage(state);
      this.localVersion = version;
    } else {
      const { html, ...update } = state;
      this.channel.postMessage(update);
    }
    if (this.pair) {
      this.next = { state, version };
      this.flush();
    }
  }

  openDisplay(flipX, flipY) {
    const url = new URL(location.origin);
    url.searchParams.set('display', this.id);
    if (flipX) url.searchParams.set('x', '1');
    if (flipY) url.searchParams.set('y', '1');
    const display = window.open(url, 'teleprompter-display-' + this.id, 'popup,width=1000,height=650');
    display?.focus();
    return display;
  }

  async startPair(flipX, flipY) {
    const response = await fetch('/api/network', { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error('Could not reach Teleprompter Setup. Check the local network and try again.');
    const network = await response.json();
    if (!network.lan) throw new Error('Open Teleprompter Setup on the computer, select Start phone setup, then retry here.');
    if (!this.pair) {
      const response = await fetch('/api/session', { method: 'POST', signal: AbortSignal.timeout(5000) });
      const pair = await response.json();
      if (!response.ok) throw new Error(pair.error || 'Could not start a local pairing.');
      if (!pair.code) throw new Error('Update the desktop launcher to use pairing codes.');
      this.remoteVersion = undefined;
      this.pair = pair;
    }
    const url = new URL('/display/' + this.pair.id, network.setupAddress || network.address);
    if (!network.setupAddress) {
      url.pathname = '/';
      url.searchParams.set('pair', this.pair.id);
    }
    if (flipX) url.searchParams.set('x', '1');
    if (flipY) url.searchParams.set('y', '1');
    return { url: url.href, code: this.pair.code };
  }

  async endPair() {
    const pair = this.pair;
    if (!pair) return;
    this.pair = null;
    this.next = null;
    await fetch('/api/session/' + pair.id, { method: 'DELETE', headers: { 'X-Teleprompter-Key': pair.key }, signal: AbortSignal.timeout(3500) }).catch(() => {});
  }

  async flush() {
    if (this.sending || !this.next || !this.pair) return;
    const pair = this.pair;
    const { state, version } = this.next;
    this.next = null;
    this.sending = true;
    try {
      const { html, ...update } = state;
      const response = await fetch('/api/session/' + pair.id, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Teleprompter-Key': pair.key },
        body: JSON.stringify(version !== this.remoteVersion ? state : update),
        signal: AbortSignal.timeout(3500),
      });
      if (!response.ok) {
        if (response.status === 404 && this.pair === pair) {
          this.pair = null;
          this.onFailure('Pairing ended. Select Start pairing to create a new code.', true);
          return;
        }
        const detail = await response.json().catch(() => ({}));
        throw new Error(detail.error || 'The display connection was lost.');
      }
      if (this.pair === pair) this.remoteVersion = version;
      const detail = await response.json();
      if (this.pair === pair) {
        this.onViewers(detail.viewers || 0);
        for (const control of detail.controls || []) this.onControl(control);
      }
    } catch (error) {
      if (this.pair === pair) {
        this.next = null;
        this.onFailure(error.message || 'Could not reach the local display.');
      }
    } finally {
      this.sending = false;
      if (this.next) this.flush();
    }
  }
}

export function watchDisplay(session, pair, receive, status) {
  if (pair) {
    const source = new EventSource('/api/session/' + pair);
    source.onmessage = event => {
      const packet = JSON.parse(event.data);
      if (!Number.isFinite(packet.position)) return;
      status('Receiving the operator’s script');
      receive(packet);
    };
    source.onerror = () => status(source.readyState === EventSource.CLOSED
      ? 'This pairing ended. Return to the workspace and enter a new code.'
      : 'Display disconnected. Reconnecting on the local network…', true);
    source.addEventListener('end', () => {
      source.close();
      status('This pairing has ended.', true);
    });
    let pending = Promise.resolve();
    let latestSeek;
    let seekQueued = false;
    const send = command => {
      if (command.action === 'seek') {
        latestSeek = command;
        if (seekQueued) return;
        seekQueued = true;
      }
      pending = pending.then(async () => {
        if (command.action === 'seek') {
          command = latestSeek;
          seekQueued = false;
        }
        const response = await fetch('/api/session/' + pair + '/control', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(command), signal: AbortSignal.timeout(4000), keepalive: command.action === 'release',
        });
        if (!response.ok) throw new Error();
      }).catch(() => status('Could not send that control to the operator.', true));
    };
    return { send, close: () => source.close() };
  }
  const channel = new BroadcastChannel('teleprompter:' + session);
  channel.onmessage = event => {
    if (event.data?.type !== 'state') return;
    receive(event.data);
    status('Receiving the operator’s script from this device');
  };
  channel.postMessage({ type: 'hello' });
  return {
    send: command => channel.postMessage({ ...command, type: 'control' }),
    close: () => channel.close(),
  };
}

function makeId() {
  const data = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(data, byte => byte.toString(16).padStart(2, '0')).join('');
}
