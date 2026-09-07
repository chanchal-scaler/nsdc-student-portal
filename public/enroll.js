const statusEl = document.getElementById('status');
const errorsEl = document.getElementById('errors');
const errorsTitle = document.getElementById('errorsTitle');
const errorList = document.getElementById('errorList');
const downloadRow = document.getElementById('downloadRow');
const fileMeta = document.getElementById('fileMeta');
const banner = document.getElementById('banner');
const pendingEl = document.getElementById('pending');
const pendingTitle = document.getElementById('pendingTitle');
const pendingNote = document.getElementById('pendingNote');
const pendingBtn = document.getElementById('pendingBtn');
let pollTimer = null;

const reloadHistory = renderHistory({
  endpoint: '/api/history/enrollments',
  countLabel: 'student(s) enrolled through the portal',
  columns: [
    { label: 'Candidate ID', value: r => r.candidate_id },
    { label: 'Email',        value: r => r.email || '' },
    { label: 'Batch',        value: r => r.batch_name || '' },
    { label: 'Batch ID',     value: r => r.batch_id },
    { label: 'Status',       value: r => r.status === 'COMPLETED' ? 'Enrolled, results in' : 'Enrolled' },
    { label: 'When',         value: r => whenText(r.enrolled_at) }
  ]
});


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

// A run that stops part way has really enrolled some of the list. Saying how
// many, and how many are left, is the difference between knowing what to do
// next and having to work it out from the result file. The rest stay in the
// waiting list above, so there is nothing to re-upload.
function howFar(data) {
  const done = data.stoppedAfter || 0;
  const left = Math.max(0, (data.total || 0) - done);
  if (done === 0) return 'Nobody was enrolled — all ' + data.total + ' are still waiting above.';
  return done + ' of ' + data.total + ' students were enrolled before it stopped; ' +
    left + ' still waiting above. The result sheet lists exactly which.';
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
    pendingBtn.disabled = true;
    showRunning(data);
    downloadRow.style.display = 'none';
    pollTimer = setTimeout(poll, 1500);
    return;
  }

  loadPending();

  reloadHistory();

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
    // A run that stopped part way still did real work; say how much, so it is
    // clear what is left rather than looking like nothing happened.
    if (data.serviceDown) {
      showStatus('error', 'The last run: Skill India (NSDC) was not responding. ' + howFar(data) +
        ' Try again once it is back.');
      if (data.resultReady) downloadRow.style.display = 'block';
      return;
    }

    if (data.stoppedAfter !== null) {
      showStatus('error', 'The last run stopped early. ' + howFar(data));
      if (data.resultReady) downloadRow.style.display = 'block';
      return;
    }
    showStatus('error', 'Enrolment failed: ' + (data.error || 'Unknown error'));
    if (data.resultReady) downloadRow.style.display = 'block';
  }
}

// On page load, pick up any in-progress or completed enrolment
poll();
loadPending();

// A handler that throws used to leave the page sitting on "Checking the
// sheet…" with no way to tell whether anything had happened.
window.addEventListener('unhandledrejection', event => {
  console.error(event.reason);
  showStatus('error', 'Enrolment could not be completed: ' + (event.reason && event.reason.message || event.reason) +
    '. Nothing was sent — reload the page and try again.');
});
