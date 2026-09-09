/**
 * The "Enrolled so far" page: every batch on record, most recently touched
 * first, with the students in it — and what the last few runs did.
 *
 * This is the page to open before uploading anything. Uploads come every few
 * months, so the first questions on returning are which batches are done, who
 * is already in them, and — when a run stopped because NSDC went down — what is
 * still left to upload. Batches load a page at a time as they are scrolled to,
 * because the list only grows.
 */
const summaryEl = document.getElementById('summary');
const syncBtn = document.getElementById('syncBtn');
const syncNote = document.getElementById('syncNote');
const runsEl = document.getElementById('runs');
const latestEl = document.getElementById('latest');
const earlierTitle = document.getElementById('earlierTitle');
const batchesEl = document.getElementById('batches');
const sentinel = document.getElementById('sentinel');
const loadingEl = document.getElementById('loading');
const endEl = document.getElementById('end');

const PAGE_SIZE = 10;
let nextOffset = 0;
let loading = false;
let done = false;

// All dynamic values are rendered via textContent / DOM nodes, never innerHTML
function text(tag, value, className) {
  const el = document.createElement(tag);
  el.textContent = value;
  if (className) el.className = className;
  return el;
}

/** "8 September 2026, 18:18" — the day plus enough to separate two same-day runs. */
function onDateTime(value) {
  if (!value) return '—';
  return new Date(value).toLocaleString(undefined, {
    day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit'
  });
}

/**
 * Where a batch has got to. Once NSDC has been read, its count is the one shown
 * — the portal's own is only what it was told, and a request that enrolled some
 * students before failing reports none.
 */
function batchState(batch) {
  if (batch.batchId === null) return { label: 'not created yet', cls: 'waiting' };
  if (batch.size === 0) return { label: 'no students yet', cls: 'waiting' };

  if (batch.nsdc.inBatch !== null) {
    const onNsdc = batch.nsdc.inBatch;
    if (batch.nsdc.certified === batch.size) return { label: 'results submitted', cls: 'done' };
    if (onNsdc === 0) return { label: 'none on NSDC yet', cls: 'waiting' };
    if (onNsdc >= batch.size) return { label: 'all ' + batch.size + ' on NSDC', cls: 'part' };
    return { label: onNsdc + ' of ' + batch.size + ' on NSDC', cls: 'part' };
  }

  // Before a read, all that can be said is what the portal recorded
  if (batch.completed === batch.size) return { label: 'results submitted (not verified)', cls: 'done' };
  if (batch.enrolled === batch.size) return { label: 'all enrolled (not verified)', cls: 'part' };
  if (batch.enrolled > 0) return { label: batch.enrolled + ' of ' + batch.size + ' enrolled (not verified)', cls: 'part' };
  return { label: 'nobody enrolled yet', cls: 'waiting' };
}

const STUDENT_STATES = {
  COMPLETED: { label: 'Results submitted', cls: 'completed' },
  ENROLLED: { label: 'Enrolled', cls: 'enrolled' }
};

const FLOW_NAMES = {
  students: 'Student upload',
  batches: 'Batch creation',
  enrolment: 'Enrolment',
  completion: 'Result submission'
};

function studentRow(student) {
  // NSDC first: it is the only source that knows whether the student is really
  // in the batch. The portal's own record is the fallback until a read happens.
  const state = student.onNsdc === true
    ? (student.certifiedOnNsdc
      ? { label: 'Results submitted (on NSDC)', cls: 'completed' }
      : { label: 'Enrolled (on NSDC)', cls: 'enrolled' })
    : student.onNsdc === false
      ? { label: 'Not on NSDC', cls: 'pending' }
      : STUDENT_STATES[student.status] || { label: 'On file, not enrolled', cls: 'pending' };

  const tr = document.createElement('tr');
  tr.appendChild(text('td', student.name || '—'));
  tr.appendChild(text('td', student.email));
  tr.appendChild(text('td', student.candidateId, 'mono'));
  tr.appendChild(text('td', state.label, 'state ' + state.cls));
  tr.appendChild(text('td', onDateTime(student.enrolledAt || student.addedAt)));
  return tr;
}

/** A link that hands back the rows a run never got through. */
function remainingLink(run) {
  const link = document.createElement('a');
  link.href = '/api/runs/' + run.id + '/remaining';
  link.className = 'run-link';
  link.textContent = 'Download the ' + run.remainingCount + ' still to do';
  return link;
}

/**
 * What the last few runs did, at the top of the page. A run that stopped is the
 * reason someone is here: it says how far it got and hands back the rest.
 */
function runBlock(run) {
  const stopped = run.outcome === 'stopped';
  const wrap = text('div', '', 'run ' + (stopped ? 'run-stopped' : 'run-finished'));

  wrap.appendChild(text('div',
    (FLOW_NAMES[run.flow] || run.flow) + ' — ' + onDateTime(run.finishedAt), 'run-head'));

  const detail = stopped
    ? run.done + ' of ' + run.total + ' went through before it stopped' +
      (run.stopReason === 'service-down'
        ? ', because Skill India (NSDC) was not responding.'
        : '.') +
      (run.remainingCount ? ' ' + run.remainingCount + ' still to upload.' : '')
    : run.done + ' of ' + run.total + ' went through' +
      (run.failed ? ', ' + run.failed + ' failed' : '') + '.';
  wrap.appendChild(text('div', detail, 'run-detail'));

  if (run.sourceFile) wrap.appendChild(text('div', 'From ' + run.sourceFile, 'run-file'));
  if (run.batchNames && run.batchNames.length > 0) {
    wrap.appendChild(text('div', 'Batches: ' + run.batchNames.join(', '), 'run-file'));
  }
  if (run.remainingCount > 0) wrap.appendChild(remainingLink(run));

  return wrap;
}

/** The same thing, said against the one batch it happened to. */
function stoppedNote(run) {
  const wrap = text('div', '', 'batch-stopped');
  wrap.appendChild(text('span',
    (FLOW_NAMES[run.flow] || run.flow) + ' stopped on ' + onDateTime(run.finishedAt) + ' — ' +
    run.done + ' of ' + run.total + ' done' +
    (run.stopReason === 'service-down' ? ', NSDC was not responding' : '') +
    (run.remainingCount ? '. ' + run.remainingCount + ' still to upload.' : '.')));
  if (run.remainingCount > 0) wrap.appendChild(remainingLink(run));
  return wrap;
}

/**
 * The students NSDC does not have in this batch.
 *
 * This is the answer someone comes to the page for: a run that stopped when
 * NSDC went down leaves students uploaded here but absent there, and those are
 * the rows to put in the next sheet. Students already through are counted, not
 * listed — there is nothing to do about them.
 */
function missingBlock(batch) {
  if (batch.nsdc.inBatch === null) {
    return text('div',
      'NSDC has not been read for this batch yet — use "Read NSDC for these batches" above to see who is missing.',
      'not-read');
  }

  if (batch.missingCount === 0) {
    return text('div',
      'All ' + batch.size + ' student(s) are in this batch on NSDC' +
      (batch.nsdc.certified ? ', ' + batch.nsdc.certified + ' certified' : '') + '.',
      'all-through');
  }

  const wrap = text('div', '', 'missing');
  wrap.appendChild(text('h3',
    batch.missingCount + ' of ' + batch.size + ' student(s) are not in this batch on NSDC — still to upload'));

  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const label of ['Student', 'Email', 'Candidate ID', 'Recorded here']) {
    headRow.appendChild(text('th', label));
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (const student of batch.missing) {
    const tr = document.createElement('tr');
    tr.appendChild(text('td', student.name || '—'));
    tr.appendChild(text('td', student.email));
    tr.appendChild(text('td', student.candidateId, 'mono'));
    tr.appendChild(text('td', onDateTime(student.addedAt)));
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);

  const scroller = text('div', '', 'table-wrap');
  scroller.appendChild(table);
  wrap.appendChild(scroller);
  return wrap;
}

/** Says when NSDC was last read, or how the read going on right now is doing. */
function showSync(state) {
  if (!state) return;

  if (state.state === 'running') {
    syncBtn.disabled = true;
    const of = state.totalPages ? ' of ' + state.totalPages : '';
    syncNote.textContent = 'Reading NSDC — page ' + state.pagesFetched + of +
      ', ' + state.candidatesSeen + ' candidate(s) seen, ' + state.matched + ' in these batches…';
    return;
  }

  syncBtn.disabled = false;

  if (state.state === 'error') {
    syncNote.textContent = state.serviceDown
      ? 'The last read stopped: Skill India (NSDC) was not responding. What it read before that is kept.'
      : 'The last read stopped: ' + (state.error || 'unknown error');
    return;
  }

  const last = state.last || state;
  if (!last || !last.finishedAt) {
    syncNote.textContent = 'NSDC has not been read yet. Numbers below are what this portal recorded.';
    return;
  }
  syncNote.textContent = 'NSDC last read ' + onDateTime(last.finishedAt) +
    ' — ' + last.enrolled + ' student(s) enrolled in these batches' +
    (last.certified ? ', ' + last.certified + ' certified' : '') +
    (last.failedPages ? '. ' + last.failedPages + ' page(s) could not be read' : '') + '.' +
    (last.staleSince
      ? ' A run has happened since (' + onDateTime(last.staleSince) +
        '), so read NSDC again for a true count.'
      : '');
}

/** Reloads the page's data from scratch, after a read of NSDC changes it. */
function reload() {
  nextOffset = 0;
  done = false;
  loading = false;
  runsEl.textContent = '';
  latestEl.textContent = '';
  batchesEl.textContent = '';
  earlierTitle.style.display = 'none';
  endEl.style.display = 'none';
  summaryEl.style.display = 'block';
  loadPage();
}

async function pollSync() {
  let state;
  try {
    const res = await fetch('/api/history/sync/status');
    if (res.status === 401) return location.href = '/login';
    state = await res.json();
  } catch {
    setTimeout(pollSync, 3000);
    return;
  }

  showSync(state);

  if (state.state === 'running') {
    setTimeout(pollSync, 1500);
    return;
  }
  // A finished read changes every count on the page, so it is read again
  if (syncWasRunning) {
    syncWasRunning = false;
    reload();
  }
}

let syncWasRunning = false;

async function startSync() {
  syncBtn.disabled = true;
  syncNote.textContent = 'Starting…';

  let body;
  try {
    const res = await fetch('/api/history/sync', { method: 'POST' });
    if (res.status === 401) return location.href = '/login';
    body = await res.json().catch(() => ({}));
    if (!res.ok) {
      syncBtn.disabled = false;
      syncNote.textContent = body.error || 'Could not start the read.';
      return;
    }
  } catch (err) {
    syncBtn.disabled = false;
    syncNote.textContent = 'Could not start the read: ' + err.message;
    return;
  }

  syncWasRunning = true;
  pollSync();
}

syncBtn.addEventListener('click', startSync);

function batchBlock(batch, isLatest) {
  const wrap = text('div', '', isLatest ? 'batch latest' : 'batch');

  const head = text('div', '', 'batch-head');
  const left = document.createElement('div');
  left.appendChild(text('div', batch.batchName, 'batch-name'));
  left.appendChild(text('div',
    (batch.batchId === null ? 'No batch ID yet' : 'Batch ID ' + batch.batchId) +
    ' · ' + batch.size + ' student(s)' +
    ' · last updated ' + onDateTime(batch.lastActivityAt), 'batch-meta'));
  head.appendChild(left);

  const state = batchState(batch);
  head.appendChild(text('span', state.label, 'pill ' + state.cls));
  wrap.appendChild(head);

  if (batch.lastStoppedRun) wrap.appendChild(stoppedNote(batch.lastStoppedRun));

  if (batch.students.length === 0) {
    wrap.appendChild(text('div',
      'No student on file names this batch yet.', 'batch-empty'));
    return wrap;
  }

  wrap.appendChild(missingBlock(batch));

  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const label of ['Student', 'Email', 'Candidate ID', 'State', 'Last updated']) {
    headRow.appendChild(text('th', label));
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (const student of batch.students) tbody.appendChild(studentRow(student));
  table.appendChild(tbody);

  const scroller = text('div', '', 'table-wrap');
  scroller.appendChild(table);
  wrap.appendChild(scroller);
  return wrap;
}

/** Loads one page of batches, and on the first page the runs panel too. */
async function loadPage() {
  if (loading || done) return;
  loading = true;
  loadingEl.style.display = 'block';

  const first = nextOffset === 0;
  let data;
  try {
    const res = await fetch('/api/history?offset=' + nextOffset + '&limit=' + PAGE_SIZE);
    if (res.status === 401) return location.href = '/login';
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      loadingEl.style.display = 'none';
      summaryEl.textContent = body.error || 'Could not read what has been recorded.';
      done = true;
      return;
    }
    data = await res.json();
  } catch (err) {
    loadingEl.style.display = 'none';
    loading = false;
    summaryEl.textContent = 'Could not read what has been recorded: ' + err.message;
    return;
  }

  loadingEl.style.display = 'none';
  loading = false;

  if (first) {
    for (const run of data.runs || []) runsEl.appendChild(runBlock(run));

    if (data.total === 0) {
      summaryEl.style.display = 'none';
      batchesEl.appendChild(text('div',
        'Nothing recorded yet. Upload a sheet of students to start.', 'empty'));
      done = true;
      endEl.style.display = 'none';
      return;
    }

    const t = data.totals;
    summaryEl.textContent = t.inNsdc === null
      ? data.total + ' batch(es) and ' + t.students + ' student(s) uploaded from here. ' +
        'NSDC has not been read yet, so how many are actually enrolled is not known — read it below.'
      // The count that matters, from NSDC itself
      : t.inNsdc + ' of ' + t.students + ' student(s) are enrolled on NSDC, across ' +
        data.total + ' batch(es)' +
        (t.certified ? ', ' + t.certified + ' with results submitted' : '') + '. ' +
        (t.missing
          ? t.missing + ' are still to upload.'
          : 'Nothing outstanding.');
    showSync({ state: 'idle', last: data.sync || null });

    // The batch touched most recently is what someone coming back is checking,
    // so it is shown on its own above the rest rather than as the first of a list
    const [latest, ...earlier] = data.batches;
    latestEl.appendChild(text('div',
      'Uploaded last — ' + onDateTime(latest.lastActivityAt), 'latest-label'));
    latestEl.appendChild(batchBlock(latest, true));

    if (earlier.length > 0 || data.nextOffset !== null) earlierTitle.style.display = 'block';
    for (const batch of earlier) batchesEl.appendChild(batchBlock(batch));
  } else {
    for (const batch of data.batches) batchesEl.appendChild(batchBlock(batch));
  }

  if (data.nextOffset === null) {
    done = true;
    endEl.style.display = 'block';
  } else {
    nextOffset = data.nextOffset;
    // The page may be taller than the batches loaded so far, in which case the
    // sentinel is still on screen and the next page is wanted straight away
    if (observer) observer.observe(sentinel);
  }
}

// Scrolling to the bottom loads the next page, so months keep coming without a
// pager to click. Falls back to a button where IntersectionObserver is missing.
let observer = null;
if ('IntersectionObserver' in window) {
  observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (entry.isIntersecting && !loading && !done) loadPage();
    }
  }, { rootMargin: '200px' });
  observer.observe(sentinel);
} else {
  const more = document.createElement('button');
  more.className = 'more';
  more.textContent = 'Load more batches';
  more.addEventListener('click', loadPage);
  sentinel.appendChild(more);
}

loadPage();
pollSync();
