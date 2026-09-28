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

    // Shown whether or not anybody is waiting: it is the whole of what gets
    // sent, and an empty body on a button that acts on everyone is worth seeing.
    previewTitle.textContent = 'What would be sent';
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

  if (data.state === 'requesting') {
    statusEl.appendChild(document.createTextNode('Asking NSDC to issue certificates…'));
    return;
  }

  // The read has no total until NSDC answers with one, and the page should not
  // look stuck in the meantime
  const pages = data.totalPages
    ? 'page ' + data.pagesFetched + ' of ' + data.totalPages
    : data.pagesFetched + ' page(s) read';
  statusEl.appendChild(document.createTextNode(
    'NSDC took the request. Reading it back to see who was certified — ' + pages
  ));

  if (data.totalPages) {
    const bar = document.createElement('div');
    bar.className = 'progress-bar';
    const fill = document.createElement('div');
    fill.className = 'progress-fill';
    fill.style.width = Math.round(data.pagesFetched / data.totalPages * 100) + '%';
    bar.appendChild(fill);
    statusEl.appendChild(bar);
  }
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

  if (data.state === 'requesting' || data.state === 'reading') {
    pendingBtn.disabled = true;
    showRunning(data);
    pollTimer = setTimeout(poll, 1500);
    return;
  }

  pendingBtn.disabled = false;
  loadPending();

  if (data.state === 'done') {
    if (data.error) {
      // The request went through; only the confirmation did not
      showStatus('error', data.error);
    } else {
      let message = 'Done: ' + data.certified + ' of ' + data.waiting + ' now certified on NSDC';
      if (data.stillWaiting) message += ', ' + data.stillWaiting + ' not yet';
      message += '.';
      if (!data.dbEnabled) message += ' (Not stored in the database: DATABASE_URL is not set.)';
      showStatus(data.stillWaiting ? 'error' : 'done', message);
    }

    if (data.stillWaiting) {
      showErrors('Not certified yet', [
        data.stillWaiting + ' student(s) NSDC has not certified. It may not consider them eligible, ' +
        'or the certificate may not have been issued by the time this read ran — the result CSV names them.'
      ]);
    }

    if (data.response) {
      previewTitle.textContent = 'What NSDC answered';
      previewBody.textContent = typeof data.response === 'string'
        ? data.response
        : JSON.stringify(data.response, null, 2);
      previewEl.style.display = 'block';
    }

    if (data.resultReady) {
      downloadRow.style.display = 'block';
      fileMeta.textContent = data.resultFileName + ' — finished ' + new Date(data.finishedAt).toLocaleString();
    }
  } else if (data.state === 'error') {
    if (data.serviceDown) {
      showStatus('error', 'Skill India (NSDC) was not responding. Nothing was issued — try again once it is back.');
    } else {
      showStatus('error', 'Certificates could not be generated: ' + (data.error || 'Unknown error'));
    }
  }
}

loadPending();
poll();
