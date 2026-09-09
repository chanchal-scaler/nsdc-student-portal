const fileInput = document.getElementById('fileInput');
const uploadBtn = document.getElementById('uploadBtn');
const statusEl = document.getElementById('status');
const errorsEl = document.getElementById('errors');
const errorsTitle = document.getElementById('errorsTitle');
const errorList = document.getElementById('errorList');
const downloadRow = document.getElementById('downloadRow');
const fileMeta = document.getElementById('fileMeta');
const banner = document.getElementById('banner');
const previewBtn = document.getElementById('previewBtn');
const previewEl = document.getElementById('preview');
const previewTitle = document.getElementById('previewTitle');
const previewBody = document.getElementById('previewBody');
let pollTimer = null;

// The poll that runs on page load and a button click can both be waiting on a
// response at once, and a late poll used to repaint the finished-run status
// over whatever the click had just put there — leaving, say, a green "2
// created" above a red "nothing to create". Every render claims the status area
// first; a response that no longer owns it is dropped.
let statusToken = 0;
const claimStatus = () => ++statusToken;
const ownsStatus = token => token === statusToken;

uploadBtn.addEventListener('click', startUpload);
previewBtn.addEventListener('click', previewPayload);

function showValidationErrors(body) {
  const messages = [];
  for (const headerError of body.headerErrors || []) messages.push(headerError);
  for (const error of body.errors || []) messages.push('Row ' + error.row + ': ' + error.message);
  if (body.errorCount > (body.errors || []).length) {
    messages.push('… and ' + (body.errorCount - body.errors.length) + ' more');
  }
  showErrors('Fix these and try again', messages);
  return body.errorCount || messages.length;
}

// Validates the sheet and shows the exact JSON that would be sent to NSDC.
// Nothing is submitted: the endpoint stops before the push call, so no batch is
// completed and no certificate is issued.
async function previewPayload() {
  const token = claimStatus();
  const file = fileInput.files && fileInput.files[0];
  if (!file) {
    showStatus('error', 'Choose a .csv or .xlsx file first.');
    return;
  }

  previewBtn.disabled = true;
  clearErrors();
  previewEl.style.display = 'none';
  downloadRow.style.display = 'none';
  banner.style.display = 'none';
  showStatus('running', 'Building payloads…');

  const form = new FormData();
  form.append('sheet', file);

  let res;
  try {
    res = await fetch('/api/complete/preview', { method: 'POST', body: form });
  } catch (err) {
    showStatus('error', 'Preview failed: ' + err.message);
    previewBtn.disabled = false;
    return;
  }

  if (res.status === 401) return location.href = '/login';

  const body = await res.json().catch(() => ({}));

  previewBtn.disabled = false;

  if (!ownsStatus(token)) return;

  if (res.status === 422) {
    const count = showValidationErrors(body);
    showStatus('error', 'Sheet rejected — ' + count + ' problem(s) found.');
    return;
  }

  if (!res.ok) {
    showStatus('error', body.error || 'Preview failed');
    return;
  }

  // Rows already submitted, or whose student or batch could not be found, are
  // not in the payloads — say which, so the count makes sense against the sheet
  const notes = [];
  if (body.skipped) notes.push(body.skipped + ' row(s) already submitted — left out');
  if (body.unresolvedCount) notes.push(body.unresolvedCount + ' row(s) could not be matched');
  if (notes.length > 0) {
    banner.style.display = 'block';
    banner.textContent = notes.join('. ') + '.';
  }

  showStatus('done', body.total + ' student(s) in ' + body.groups +
    ' batch payload(s). Nothing was sent to NSDC.');
  previewTitle.textContent = 'Payload preview — showing ' +
    Math.min(5, body.groups) + ' of ' + body.groups + ' batch payload(s)';
  previewBody.textContent = JSON.stringify(body.payloads, null, 2);
  previewEl.style.display = 'block';
}

// All dynamic values are rendered via textContent / DOM nodes, never innerHTML
function showStatus(cls, text) {
  statusEl.className = 'status ' + cls;
  statusEl.textContent = text;
}

function clearErrors() {
  errorsEl.style.display = 'none';
  errorList.textContent = '';
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

async function startUpload() {
  const token = claimStatus();
  const file = fileInput.files && fileInput.files[0];
  if (!file) {
    showStatus('error', 'Choose a .csv or .xlsx file first.');
    return;
  }

  uploadBtn.disabled = true;
  clearErrors();
  previewEl.style.display = 'none';
  downloadRow.style.display = 'none';
  showStatus('running', 'Checking the sheet…');

  const form = new FormData();
  form.append('sheet', file);

  let res;
  try {
    res = await fetch('/api/complete/upload', { method: 'POST', body: form });
  } catch (err) {
    showStatus('error', 'Upload failed: ' + err.message);
    uploadBtn.disabled = false;
    return;
  }

  if (res.status === 401) return location.href = '/login';

  const body = await res.json().catch(() => ({}));

  if (!ownsStatus(token)) return;

  if (res.status === 422) {
    // Validation failed — nothing was sent to NSDC
    const count = showValidationErrors(body);
    showStatus('error', 'Sheet rejected — ' + count + ' problem(s) found. Nothing was sent to NSDC.');
    uploadBtn.disabled = false;
    return;
  }

  if (!res.ok) {
    showStatus('error', body.error || 'Upload failed');
    uploadBtn.disabled = false;
    return;
  }

  const notes = [];
  if (body.skipped) notes.push(body.skipped + ' row(s) already submitted — skipped');
  if (body.unresolvedCount) notes.push(body.unresolvedCount + ' row(s) could not be matched — see the result CSV');
  if (notes.length > 0) {
    banner.style.display = 'block';
    banner.textContent = notes.join('. ') + '.';
  }

  poll();
}

function showRunning(data) {
  statusEl.className = 'status running';
  statusEl.textContent = '';

  const spinner = document.createElement('span');
  spinner.className = 'spinner';
  statusEl.appendChild(spinner);

  statusEl.appendChild(document.createTextNode(
    'Submitting ' + Math.min(data.processed + 1, data.total) + ' of ' + data.total +
    ' — ' + data.completed + ' submitted, ' + data.failed + ' failed'
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
    const res = await fetch('/api/complete/status');
    if (res.status === 401) return location.href = '/login';
    data = await res.json();
  } catch {
    pollTimer = setTimeout(poll, 3000);
    return;
  }

  if (!ownsStatus(token)) return;

  if (data.state === 'running') {
    uploadBtn.disabled = true;
    showRunning(data);
    downloadRow.style.display = 'none';
    pollTimer = setTimeout(poll, 1500);
    return;
  }

  uploadBtn.disabled = false;

  if (data.state === 'done') {
    let message = 'Done — ' + data.completed + ' result(s) submitted, ' +
      data.skipped + ' skipped, ' + data.failed + ' failed.';
    if (!data.dbEnabled) message += ' (Not stored in the database: DATABASE_URL is not set.)';
    showStatus(data.failed > 0 ? 'error' : 'done', message);

    if (data.resultReady) {
      downloadRow.style.display = 'block';
      fileMeta.textContent = data.resultFileName + ' — finished ' + new Date(data.finishedAt).toLocaleString();
    }
  } else if (data.state === 'error') {
    // A run that stopped part way still did real work; say how much, so the
    // sheet is not re-uploaded blind.
    if (data.serviceDown) {
      const done = data.stoppedAfter
        ? data.stoppedAfter + ' of ' + data.total + ' went through before it stopped. '
        : 'Nothing was sent. ';
      showStatus('error', 'Skill India (NSDC) is not responding. ' + done +
        'Try again once it is back — re-uploading the same sheet picks up where this left off.');
      if (data.resultReady) downloadRow.style.display = 'block';
      return;
    }

    if (data.stoppedAfter) {
      showStatus('error', 'Stopped after ' + data.stoppedAfter + ' of ' + data.total +
        '. Those are done — download the result sheet to see them. Uploading the same sheet again picks up where this left off.');
      if (data.resultReady) downloadRow.style.display = 'block';
      return;
    }
    showStatus('error', 'Upload failed: ' + (data.error || 'Unknown error'));
    if (data.resultReady) downloadRow.style.display = 'block';
  }
}

// On page load, pick up any in-progress or completed enrolment
poll();
