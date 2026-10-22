const statusEl = document.getElementById('status');
const errorsEl = document.getElementById('errors');
const errorsTitle = document.getElementById('errorsTitle');
const errorList = document.getElementById('errorList');
const downloadRow = document.getElementById('downloadRow');
const fileMeta = document.getElementById('fileMeta');
const banner = document.getElementById('banner');
const pendingTitle = document.getElementById('pendingTitle');
const pendingNote = document.getElementById('pendingNote');
const pendingBtn = document.getElementById('pendingBtn');
const nsdcNote = document.getElementById('nsdcNote');
const previewEl = document.getElementById('preview');
const previewTitle = document.getElementById('previewTitle');
const previewBody = document.getElementById('previewBody');

let pollTimer = null;

// The poll running on page load and a button click can both be waiting on a
// response at once, and a late poll would otherwise repaint the finished-run
// status over whatever the click had just put there. Every render claims the
// status area first; a response that no longer owns it is dropped.
let statusToken = 0;
const claimStatus = () => ++statusToken;
const ownsStatus = token => token === statusToken;

pendingBtn.addEventListener('click', generate);

/** Who this portal expects the run to cover, and what it will send. */
async function loadPending() {
  try {
    const res = await fetch('/api/certificates/pending');
    if (res.status === 401) return location.href = '/login';
    const data = await res.json();

    if (data.error) {
      pendingNote.textContent = data.error;
      pendingBtn.disabled = true;
      return;
    }

    // Shown whether or not anybody is waiting: it is the shape of what gets
    // sent, and is worth seeing before pressing the button that sends it.
    previewTitle.textContent = 'What would be sent — one request like this per student';
    previewBody.textContent = 'POST ' + data.url + '\n\n' + JSON.stringify(data.payload, null, 2) +
      '\n\n// signed in as ' + data.tpId + ' — that is how NSDC knows which partner';
    previewEl.style.display = 'block';

    if (!data.total) {
      pendingTitle.textContent = 'Waiting on a certificate';
      pendingNote.textContent = 'Nobody. Every student whose results are in already has one recorded here.';
      pendingBtn.disabled = true;
      return;
    }

    pendingTitle.textContent = 'Waiting on a certificate — ' + data.total + ' student(s)';
    const batches = (data.batches || [])
      .map(b => (b.batchName || 'batch ' + b.batchId) + ' (' + b.students + ')')
      .join(', ');
    pendingNote.textContent = batches ? 'In ' + batches + '.' : '';
    pendingBtn.disabled = false;
  } catch {
    pendingNote.textContent = 'Could not read the waiting list.';
    pendingBtn.disabled = true;
  }
}

async function generate() {
  const token = claimStatus();
  clearErrors();
  pendingBtn.disabled = true;
  showStatus('running', 'Asking NSDC…');

  try {
    const res = await fetch('/api/certificates/generate', { method: 'POST' });
    if (res.status === 401) return location.href = '/login';
    const body = await res.json();

    if (!res.ok) {
      if (!ownsStatus(token)) return;
      showStatus('error', body.note || body.error || 'Could not start.');
      pendingBtn.disabled = false;
      return;
    }

    poll();
  } catch (err) {
    if (!ownsStatus(token)) return;
    showStatus('error', 'Could not start: ' + err.message);
    pendingBtn.disabled = false;
  }
}

// All dynamic values are rendered via textContent / DOM nodes, never innerHTML

function showStatus(cls, text) {
  statusEl.className = 'status ' + cls;
  statusEl.textContent = text;
}

function clearErrors() {
  errorsEl.style.display = 'none';
  errorList.textContent = '';
  banner.style.display = 'none';
  nsdcNote.textContent = '';
}

function showErrors(title, messages) {
  errorsTitle.textContent = title;
  errorList.textContent = '';
  for (const message of messages) {
    const li = document.createElement('li');
    li.textContent = message;
    errorList.appendChild(li);
  }
  errorsEl.style.display = 'block';
}

function showRunning(data) {
  statusEl.className = 'status running';
  statusEl.textContent = '';

  const spinner = document.createElement('span');
  spinner.className = 'spinner';
  statusEl.appendChild(spinner);

  statusEl.appendChild(document.createTextNode(
    'Asking for certificate ' + Math.min(data.processed + 1, data.total) + ' of ' + data.total +
    ' — ' + data.generated + ' generated, ' + data.failed + ' failed'
  ));

  const bar = document.createElement('div');
  bar.className = 'progress-bar';
  const fill = document.createElement('div');
  fill.className = 'progress-fill';
  fill.style.width = (data.total ? Math.round(data.processed / data.total * 100) : 0) + '%';
  bar.appendChild(fill);
  statusEl.appendChild(bar);
}

async function poll() {
  clearTimeout(pollTimer);
  const token = claimStatus();
  let data;
  try {
    const res = await fetch('/api/certificates/status');
    if (res.status === 401) return location.href = '/login';
    data = await res.json();
  } catch {
    pollTimer = setTimeout(poll, 3000);
    return;
  }
  if (!ownsStatus(token)) return;

  if (data.state === 'running') {
    pendingBtn.disabled = true;
    showRunning(data);
    pollTimer = setTimeout(poll, 1500);
    return;
  }

  pendingBtn.disabled = false;
  loadPending();

  if (data.state === 'done') {
    let message = 'Done: ' + data.generated + ' of ' + data.total + ' certificate(s) generated';
    if (data.failed) message += ', ' + data.failed + ' failed';
    message += '.';
    if (!data.dbEnabled) message += ' (Not stored in the database: DATABASE_URL is not set.)';
    showStatus(data.failed ? 'error' : 'done', message);

    if (data.failed) {
      showErrors('No certificate asked for', [
        data.failed + ' student(s) NSDC refused — the result CSV and the Failures page say why, student by student.'
      ]);
    }

    if (data.resultReady) {
      downloadRow.style.display = 'block';
      fileMeta.textContent = data.resultFileName + ' — finished ' + new Date(data.finishedAt).toLocaleString();
    }
  } else if (data.state === 'error') {
    if (data.serviceDown) {
      const done = data.stoppedAfter
        ? data.stoppedAfter + ' of ' + data.total + ' were asked about before it stopped; the rest stay on the waiting list above. '
        : 'Nothing was asked for — the whole list is still waiting above. ';
      showStatus('error', 'Skill India (NSDC) was not responding. ' + done +
        'Try again once it is back — students already certified are left alone.');
      if (data.resultReady) downloadRow.style.display = 'block';
      return;
    }
    showStatus('error', 'Certificates could not be generated: ' + (data.error || 'Unknown error'));
    if (data.resultReady) downloadRow.style.display = 'block';
  }
}

loadPending();
poll();
