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
const pendingEl = document.getElementById('pending');
const pendingTitle = document.getElementById('pendingTitle');
const pendingNote = document.getElementById('pendingNote');
const pendingBtn = document.getElementById('pendingBtn');
let pollTimer = null;

uploadBtn.addEventListener('click', startUpload);
previewBtn.addEventListener('click', previewPayload);
pendingBtn.addEventListener('click', enrolPending);

// Whatever the student sheets asked for and has not been enrolled yet. Batch
// IDs are resolved when this loads, so uploading batches later is enough.
async function loadPending() {
  let data;
  try {
    const res = await fetch('/api/enroll/pending');
    if (res.status === 401) return location.href = '/login';
    data = await res.json();
  } catch {
    return;
  }

  if (!data.total) {
    pendingEl.style.display = 'none';
    return;
  }

  pendingEl.style.display = 'block';
  pendingTitle.textContent = 'From the student sheets — ' + data.total + ' student(s) waiting';

  pendingNote.textContent = '';
  pendingNote.appendChild(document.createTextNode(data.ready + ' ready to enrol.'));

  if (data.waiting.length > 0) {
    const names = [...new Set(data.waiting.map(w => w.batchName))];
    pendingNote.appendChild(document.createElement('br'));
    pendingNote.appendChild(document.createTextNode(
      data.waiting.length + ' waiting for a batch that does not exist yet: ' + names.join(', ')
    ));
  }

  pendingBtn.disabled = data.ready === 0;
}

async function enrolPending() {
  pendingBtn.disabled = true;
  clearErrors();
  previewEl.style.display = 'none';
  downloadRow.style.display = 'none';
  showStatus('running', 'Enrolling…');

  let res;
  try {
    res = await fetch('/api/enroll/pending', { method: 'POST' });
  } catch (err) {
    showStatus('error', 'Enrolment failed: ' + err.message);
    pendingBtn.disabled = false;
    return;
  }

  if (res.status === 401) return location.href = '/login';
  const body = await res.json().catch(() => ({}));

  if (!res.ok) {
    const count = res.status === 422 ? showValidationErrors(body) : 0;
    showStatus('error', body.note || body.error || (count + ' problem(s) found'));
    pendingBtn.disabled = false;
    return;
  }

  poll();
}

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

// Builds the request bodies and shows them without contacting NSDC at all
async function previewPayload() {
  const file = fileInput.files && fileInput.files[0];
  if (!file) {
    showStatus('error', 'Choose a .csv or .xlsx file first.');
    return;
  }

  previewBtn.disabled = true;
  clearErrors();
  previewEl.style.display = 'none';
  downloadRow.style.display = 'none';
  showStatus('running', 'Building payloads…');

  const form = new FormData();
  form.append('sheet', file);

  let res;
  try {
    res = await fetch('/api/enroll/preview', { method: 'POST', body: form });
  } catch (err) {
    showStatus('error', 'Preview failed: ' + err.message);
    previewBtn.disabled = false;
    return;
  }

  if (res.status === 401) return location.href = '/login';

  const body = await res.json().catch(() => ({}));
  previewBtn.disabled = false;

  if (res.status === 422) {
    const count = showValidationErrors(body);
    showStatus('error', 'Sheet rejected — ' + count + ' problem(s) found.');
    return;
  }

  if (!res.ok) {
    showStatus('error', body.error || 'Preview failed');
    return;
  }

  let summary = body.total + ' student(s) across ' + body.groups + ' batch request(s). Nothing was sent to NSDC.';
  if (body.skipped) summary += ' ' + body.skipped + ' already enrolled, skipped.';
  if (body.unresolvedCount) summary += ' ' + body.unresolvedCount + ' could not be matched.';
  showStatus(body.unresolvedCount ? 'error' : 'done', summary);

  if (body.unresolvedCount) {
    showErrors('These rows will not be sent', (body.unresolved || [])
      .map(u => 'Row ' + u.row + ' (' + u.email + '): ' + u.error));
  }

  previewTitle.textContent = 'Payload preview — ' + body.groups + ' request(s)';
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
    res = await fetch('/api/enroll/upload', { method: 'POST', body: form });
  } catch (err) {
    showStatus('error', 'Upload failed: ' + err.message);
    uploadBtn.disabled = false;
    return;
  }

  if (res.status === 401) return location.href = '/login';

  const body = await res.json().catch(() => ({}));

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
  if (body.skipped) notes.push(body.skipped + ' row(s) already enrolled — skipped');
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
    'Enrolling ' + Math.min(data.processed + 1, data.total) + ' of ' + data.total +
    ' — ' + data.enrolled + ' enrolled, ' + data.alreadyEnrolled + ' already in batch, ' + data.failed + ' failed'
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
  let data;
  try {
    const res = await fetch('/api/enroll/status');
    if (res.status === 401) return location.href = '/login';
    data = await res.json();
  } catch {
    pollTimer = setTimeout(poll, 3000);
    return;
  }

  if (data.state === 'running') {
    uploadBtn.disabled = true;
    showRunning(data);
    downloadRow.style.display = 'none';
    pollTimer = setTimeout(poll, 1500);
    return;
  }

  uploadBtn.disabled = false;

  loadPending();

  if (data.state === 'done') {
    let message = 'Done — ' + data.enrolled + ' enrolled, ' + data.alreadyEnrolled +
      ' already in batch, ' + data.skipped + ' skipped, ' + data.failed + ' failed.';
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
loadPending();
