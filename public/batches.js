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
    res = await fetch('/api/batches/preview', { method: 'POST', body: form });
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

  showStatus('done', body.total + ' payload(s) built. Nothing was sent to NSDC.');
  previewTitle.textContent = 'Payload preview — showing ' +
    Math.min(20, body.total) + ' of ' + body.total;
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
    res = await fetch('/api/batches/upload', { method: 'POST', body: form });
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

  if (body.ignoredColumns && body.ignoredColumns.length > 0) {
    banner.style.display = 'block';
    banner.textContent = 'Ignored column(s): ' + body.ignoredColumns.join(', ');
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
    'Creating batch ' + Math.min(data.processed + 1, data.total) + ' of ' + data.total +
    ' — ' + data.created + ' created, ' + data.failed + ' failed'
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
    const res = await fetch('/api/batches/status');
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

  if (data.state === 'done') {
    let message = 'Done — ' + data.created + ' created, ' + data.failed + ' failed.';
    if (!data.dbEnabled) message += ' (Not stored in the database: DATABASE_URL is not set.)';
    showStatus(data.failed > 0 ? 'error' : 'done', message);

    if (data.resultReady) {
      downloadRow.style.display = 'block';
      fileMeta.textContent = data.resultFileName + ' — finished ' + new Date(data.finishedAt).toLocaleString();
    }
  } else if (data.state === 'error') {
    showStatus('error', 'Upload failed: ' + (data.error || 'Unknown error'));
    if (data.resultReady) downloadRow.style.display = 'block';
  }
}

// On page load, pick up any in-progress or completed upload
poll();
