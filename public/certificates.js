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
    if (data.downloaded) {
      message += ', ' + data.downloaded + ' downloaded' +
        (data.certificateFormat === 'link' ? ' — NSDC hands back a LINK, kept in the database'
          : data.certificateFormat === 'pdf' ? ' — NSDC hands back the PDF itself, kept on disk' : '');
    }
    if (data.downloadFailed) message += ', ' + data.downloadFailed + ' download(s) failed';
    if (data.failed) message += ', ' + data.failed + ' failed';
    message += '.';
    if (!data.dbEnabled) message += ' (Not stored in the database: DATABASE_URL is not set.)';
    showStatus(data.failed || data.downloadFailed ? 'error' : 'done', message);

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

const sheetInput = document.getElementById('sheetInput');
const sheetPreviewBtn = document.getElementById('sheetPreviewBtn');
const sheetUploadBtn = document.getElementById('sheetUploadBtn');
const sheetResolved = document.getElementById('sheetResolved');
const sheetResolvedTitle = document.getElementById('sheetResolvedTitle');
const sheetResolvedBody = document.getElementById('sheetResolvedBody');
const sheetPreview = document.getElementById('sheetPreview');
const sheetPreviewTitle = document.getElementById('sheetPreviewTitle');
const sheetPreviewBody = document.getElementById('sheetPreviewBody');
const sheetErrors = document.getElementById('sheetErrors');
const sheetErrorsTitle = document.getElementById('sheetErrorsTitle');
const sheetErrorList = document.getElementById('sheetErrorList');

sheetPreviewBtn.addEventListener('click', () => sendSheet('/api/certificates/preview', false));
sheetUploadBtn.addEventListener('click', () => sendSheet('/api/certificates/upload', true));

function clearSheet() {
  sheetResolved.style.display = 'none';
  sheetPreview.style.display = 'none';
  sheetErrors.style.display = 'none';
}

function showSheetErrors(title, messages) {
  sheetErrorsTitle.textContent = title;
  sheetErrorList.textContent = '';
  for (const message of messages) {
    const li = document.createElement('li');
    li.textContent = message;
    sheetErrorList.appendChild(li);
  }
  sheetErrors.style.display = 'block';
}

function showSheetResolved(rows) {
  sheetResolvedBody.textContent = '';
  if (rows.length === 0) {
    sheetResolved.style.display = 'none';
    return;
  }
  for (const row of rows) {
    const tr = document.createElement('tr');
    const cells = [
      { text: String(row.row) },
      { text: row.candidateId },
      { text: row.name || 'not known to this portal', unknown: !row.known },
      { text: String(row.batchId) },
      { text: row.batchName || 'not known to this portal', unknown: !row.batchName }
    ];
    for (const cell of cells) {
      const td = document.createElement('td');
      td.textContent = cell.text;
      if (cell.unknown) td.className = 'unknown';
      tr.appendChild(td);
    }
    sheetResolvedBody.appendChild(tr);
  }
  sheetResolvedTitle.textContent = 'What each row resolved to — ' + rows.length + ' row(s)';
  sheetResolved.style.display = 'block';
}

async function sendSheet(url, isRun) {
  const token = claimStatus();
  const file = sheetInput.files && sheetInput.files[0];
  if (!file) {
    showStatus('error', 'Choose a .csv or .xlsx file first.');
    return;
  }

  sheetPreviewBtn.disabled = true;
  sheetUploadBtn.disabled = true;
  clearSheet();
  showStatus('running', isRun ? 'Checking the sheet…' : 'Resolving the sheet…');

  const form = new FormData();
  form.append('sheet', file);

  let res, body;
  try {
    res = await fetch(url, { method: 'POST', body: form });
    if (res.status === 401) return location.href = '/login';
    body = await res.json().catch(() => ({}));
  } catch (err) {
    showStatus('error', 'Failed: ' + err.message);
    sheetPreviewBtn.disabled = false;
    sheetUploadBtn.disabled = false;
    return;
  }

  sheetPreviewBtn.disabled = false;
  sheetUploadBtn.disabled = false;
  if (!ownsStatus(token)) return;

  if (res.status === 422) {
    const messages = [];
    for (const headerError of body.headerErrors || []) messages.push(headerError);
    for (const error of body.errors || []) messages.push('Row ' + error.row + ': ' + error.message);
    showSheetErrors('Fix these and try again', messages);
    showStatus('error', body.note || ((body.errorCount || messages.length) + ' problem(s) found. Nothing was sent to NSDC.'));
    return;
  }

  if (!res.ok) {
    showStatus('error', body.error || 'Failed');
    return;
  }

  if ((body.skippedRows || []).length > 0) {
    showSheetErrors('Left out', body.skippedRows.map(r => 'Row ' + r.row + ': ' + r.who + ' — ' + r.error));
  }

  if (isRun) {
    poll();
    return;
  }

  showSheetResolved(body.resolved || []);
  showStatus('done', body.total + ' certificate(s) would be asked for' +
    (body.skipped ? ', ' + body.skipped + ' row(s) left out' : '') +
    '. Nothing was sent to NSDC.');
  sheetPreviewTitle.textContent = 'Payload preview — showing ' +
    Math.min(5, body.total) + ' of ' + body.total;
  sheetPreviewBody.textContent = JSON.stringify(body.payloads, null, 2);
  sheetPreview.style.display = 'block';
}
