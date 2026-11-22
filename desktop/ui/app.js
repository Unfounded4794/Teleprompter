const api = window.launcher;
const $ = id => document.getElementById(id);
let state;
let copyTimer;

function render(next) {
  state = next;
  const working = Boolean(next.busy);
  const ready = Boolean(next.desktopUrl);
  $('connection').classList.toggle('running', ready);
  $('connection-text').textContent = ready ? 'Local server running' : next.busy === 'desktop' ? 'Starting' : 'Desktop stopped';
  $('open-desktop').disabled = working || !ready;
  $('open-desktop').hidden = !ready && next.busy !== 'desktop';
  $('retry-desktop').hidden = ready || next.busy === 'desktop';
  $('retry-desktop').disabled = working;
  $('phone-toggle').disabled = working;
  $('phone-toggle').textContent = next.busy === 'phone' ? 'Please wait…'
    : next.phoneEnabled ? 'Stop phone sharing' : 'Start phone setup';
  $('phone-details').hidden = !next.phoneEnabled;
  $('keep-open').hidden = !next.phoneEnabled;
  if (next.phoneEnabled) {
    const selected = next.addresses.find(entry => entry.address === next.selectedHost);
    if (next.qr && $('qr-code').getAttribute('src') !== next.qr) $('qr-code').src = next.qr;
    const select = $('network');
    const addressKey = next.addresses.map(item => item.address).join(' ');
    if (select.dataset.addresses !== addressKey) {
      select.replaceChildren(...next.addresses.map(item => {
        const option = document.createElement('option');
        option.value = item.address;
        option.textContent = item.name + ' · ' + item.address;
        return option;
      }));
      select.dataset.addresses = addressKey;
    }
    select.value = next.selectedHost;
    select.disabled = working;
    $('network-field').hidden = next.addresses.length < 2;
    $('setup-url').value = selected?.setupUrl || '';
    $('copy').disabled = !selected;
  } else {
    $('qr-code').removeAttribute('src');
  }

  $('import-models').disabled = working;
  for (const [id, model] of Object.entries(next.models)) {
    const existing = $('model-' + id);
    if (!existing) $('models').append(modelRow(id, model));
    const row = $('model-' + id);
    const status = row.querySelector('.model-status');
    status.classList.toggle('ready', model.ready);
    status.textContent = model.ready ? 'On this computer' : model.size;
    const download = row.querySelector('button');
    download.hidden = model.ready;
    download.disabled = working;
  }
  $('download-state').hidden = !next.progress;
  $('download-state').textContent = next.progress;
  feedback(next.error || next.message, Boolean(next.error));
}

function modelRow(id, model) {
  const row = document.createElement('div');
  row.id = 'model-' + id;
  row.className = 'model-row';
  const name = document.createElement('strong');
  name.textContent = model.label;
  const status = document.createElement('span');
  status.className = 'model-status';
  const download = document.createElement('button');
  download.type = 'button';
  download.className = 'button compact';
  download.textContent = 'Download';
  download.setAttribute('aria-label', 'Download ' + model.label + ' voice model');
  download.addEventListener('click', () => perform(() => api.downloadVoice(id)));
  row.append(name, status, download);
  return row;
}

function feedback(text, mistake) {
  const node = $('feedback');
  node.hidden = !text;
  node.classList.toggle('error', mistake);
  node.textContent = text || '';
}

async function perform(action) {
  try { render(await action()); } catch (error) { feedback(error.message, true); }
}

$('open-desktop').addEventListener('click', () => perform(api.openDesktop));
$('retry-desktop').addEventListener('click', () => perform(api.retryDesktop));
$('phone-toggle').addEventListener('click', () => perform(() => api.phone(!state?.phoneEnabled)));
$('network').addEventListener('change', event => perform(() => api.address(event.target.value)));
$('setup-url').addEventListener('focus', event => event.target.select());
$('import-models').addEventListener('click', () => perform(api.importVoice));
$('copy').addEventListener('click', async () => {
  if (!(await api.copySetup())) return;
  clearTimeout(copyTimer);
  $('copy').textContent = 'Copied';
  copyTimer = setTimeout(() => { $('copy').textContent = 'Copy link'; }, 1600);
});
api.subscribe(render);
perform(api.state);
