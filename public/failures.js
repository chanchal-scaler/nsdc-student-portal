/**
 * The failures page: every NSDC call that did not go through.
 *
 * The list is loaded a page at a time; a failure's payload and response are
 * fetched only when that failure is opened, because a payload is large and a
 * page of thirty of them would be most of the response for no reason.
 */
const summaryEl = document.getElementById('summary');
const listEl = document.getElementById('list');
const moreBtn = document.getElementById('moreBtn');
const whoamiEl = document.getElementById('whoami');
const flowFilter = document.getElementById('flowFilter');
const userFilter = document.getElementById('userFilter');
const hoursFilter = document.getElementById('hoursFilter');
const searchFilter = document.getElementById('searchFilter');
const applyBtn = document.getElementById('applyBtn');
const exportLink = document.getElementById('exportLink');

const PAGE_SIZE = 25;
let nextOffset = 0;
let loading = false;
// Which failures have already had their payload fetched, so opening one twice
// does not ask again
const loaded = new Set();

applyBtn.addEventListener('click', reload);
searchFilter.addEventListener('keydown', event => {
  if (event.key === 'Enter') reload();
});
flowFilter.addEventListener('change', reload);
userFilter.addEventListener('change', reload);
hoursFilter.addEventListener('change', reload);
moreBtn.addEventListener('click', () => loadPage());

// The flow names the server stores are short; these are what they are called on
// the pages people actually use.
const FLOW_LABELS = {
  students: 'Students',
  batches: 'Batches',
  enrolment: 'Enrolment',
  completion: 'Completion',
  'nsdc-read': 'Read NSDC',
  download: 'Download data'
};

function flowLabel(flow) {
  return FLOW_LABELS[flow] || flow;
}

function currentQuery(extra) {
  const params = new URLSearchParams();
  if (flowFilter.value) params.set('flow', flowFilter.value);
  if (userFilter.value) params.set('user', userFilter.value);
  if (hoursFilter.value) params.set('hours', hoursFilter.value);
  if (searchFilter.value.trim()) params.set('q', searchFilter.value.trim());
  for (const [key, value] of Object.entries(extra || {})) params.set(key, value);
  return params;
}

function reload() {
  nextOffset = 0;
  loaded.clear();
  listEl.textContent = '';
  moreBtn.style.display = 'none';
  exportLink.href = '/api/failures/export/csv?' + currentQuery();
  loadPage();
}

async function loadPage() {
  if (loading) return;
  loading = true;
  moreBtn.disabled = true;

  const params = currentQuery({ limit: PAGE_SIZE, offset: nextOffset });

  let res;
  try {
    res = await fetch('/api/failures?' + params);
  } catch (err) {
    showError('Could not reach the portal: ' + err.message);
    loading = false;
    moreBtn.disabled = false;
    return;
  }

  if (res.status === 401) return location.href = '/login';

  let data;
  try {
    data = await res.json();
  } catch {
    showError('The portal gave an answer that could not be read.');
    loading = false;
    moreBtn.disabled = false;
    return;
  }

  loading = false;
  moreBtn.disabled = false;

  if (!res.ok) {
    showError(data.error || 'Could not read the failures.');
    return;
  }

  if (nextOffset === 0) {
    fillFilters(data);
    summarise(data);
    if (data.signedInAs) whoamiEl.textContent = 'Signed in as ' + data.signedInAs;
  }

  if (data.failures.length === 0 && nextOffset === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = anyFilterSet()
      ? 'No failure matches those filters.'
      : 'Nothing has failed. Every NSDC call the portal has made went through.';
    listEl.appendChild(empty);
    return;
  }

  for (const failure of data.failures) listEl.appendChild(renderFailure(failure));

  nextOffset = data.nextOffset === null ? nextOffset : data.nextOffset;
  moreBtn.style.display = data.nextOffset === null ? 'none' : 'block';
}

function anyFilterSet() {
  return Boolean(flowFilter.value || userFilter.value || hoursFilter.value || searchFilter.value.trim());
}

function showError(message) {
  const box = document.createElement('div');
  box.className = 'error-box';
  box.textContent = message;
  listEl.textContent = '';
  listEl.appendChild(box);
}

function summarise(data) {
  if (data.total === 0) {
    summaryEl.textContent = anyFilterSet()
      ? 'No failure matches those filters.'
      : 'No failed NSDC call on record.';
    return;
  }
  const people = data.users.length;
  const parts = [data.total + (data.total === 1 ? ' failed call' : ' failed calls')];
  if (data.flows.length > 0) {
    parts.push('across ' + data.flows.map(f => flowLabel(f.flow) + ' (' + f.count + ')').join(', '));
  }
  if (people > 0) {
    parts.push('from ' + people + (people === 1 ? ' login' : ' logins'));
  }
  summaryEl.textContent = parts.join(' — ') + '.';
}

// The filter lists are rebuilt from what the server actually holds, keeping
// whatever was already chosen selected.
function fillFilters(data) {
  const keepFlow = flowFilter.value;
  const keepUser = userFilter.value;

  flowFilter.textContent = '';
  flowFilter.appendChild(option('', 'Every flow'));
  for (const entry of data.flows) {
    flowFilter.appendChild(option(entry.flow, flowLabel(entry.flow) + ' (' + entry.count + ')'));
  }
  flowFilter.value = keepFlow;

  userFilter.textContent = '';
  userFilter.appendChild(option('', 'Everyone'));
  for (const entry of data.users) {
    userFilter.appendChild(option(entry.userEmail, entry.userEmail + ' (' + entry.count + ')'));
  }
  userFilter.value = keepUser;
}

function option(value, label) {
  const el = document.createElement('option');
  el.value = value;
  el.textContent = label;
  return el;
}

function renderFailure(failure) {
  const block = document.createElement('div');
  block.className = 'fail' + (failure.kind === 'run-stopped' ? ' stopped' : '');

  const head = document.createElement('div');
  head.className = 'fail-head';

  const what = document.createElement('div');
  what.className = 'fail-what';
  // What a person is looking for first: which row, or that the run itself gave up
  what.textContent = failure.kind === 'run-stopped'
    ? flowLabel(failure.flow) + ' run stopped'
    : (failure.subject || 'Row ' + (failure.rowNumber || '?')) + ' was refused';
  head.appendChild(what);

  const when = document.createElement('div');
  when.className = 'fail-when';
  when.textContent = new Date(failure.occurredAt).toLocaleString();
  head.appendChild(when);
  block.appendChild(head);

  const meta = document.createElement('div');
  meta.className = 'fail-meta';
  meta.appendChild(tag('flow', flowLabel(failure.flow)));
  if (failure.userEmail) meta.appendChild(tag('who', failure.userEmail));
  if (failure.httpStatus) meta.appendChild(tag('status', 'HTTP ' + failure.httpStatus));
  if (failure.kind === 'run-stopped') meta.appendChild(tag('kind', 'Run stopped here'));
  if (failure.batchName) meta.appendChild(tag('', failure.batchName));
  if (failure.sourceFile) meta.appendChild(tag('', failure.sourceFile));
  if (Number.isInteger(failure.rowNumber)) meta.appendChild(tag('', 'Row ' + failure.rowNumber));
  if (failure.attempts) meta.appendChild(tag('', failure.attempts + ' attempt(s)'));
  block.appendChild(meta);

  // The endpoint and the reason are what the page is for. They used to be
  // behind the click with the payload; only the payload is worth folding away.
  const reason = document.createElement('div');
  reason.className = 'fail-reason' + (failure.kind === 'run-stopped' ? ' stopped' : '');
  const called = document.createElement('div');
  called.className = 'fail-endpoint';
  called.textContent = failure.method + ' ' + shortEndpoint(failure.endpoint);
  reason.appendChild(called);
  const said = document.createElement('div');
  said.className = 'fail-message';
  said.textContent = failure.errorMessage || 'NSDC gave no message';
  reason.appendChild(said);
  const hint = document.createElement('div');
  hint.className = 'fail-hint';
  hint.textContent = failure.hasPayload
    ? 'Click for the body that was sent and NSDC\u2019s full answer'
    : 'Click for the full answer';
  reason.appendChild(hint);
  block.appendChild(reason);

  const body = document.createElement('div');
  body.className = 'fail-body';
  block.appendChild(body);

  head.addEventListener('click', () => toggle(block, body, failure));
  return block;
}

function shortEndpoint(endpoint) {
  try {
    const url = new URL(endpoint);
    return url.pathname + (url.search ? '?…' : '');
  } catch {
    return endpoint;
  }
}

function tag(kind, text) {
  const el = document.createElement('span');
  el.className = 'tag' + (kind ? ' ' + kind : '');
  el.textContent = text;
  return el;
}

async function toggle(block, body, failure) {
  const opening = !block.classList.contains('open');
  block.classList.toggle('open');
  if (!opening || loaded.has(failure.id)) return;

  body.textContent = '';
  const pending = document.createElement('div');
  pending.className = 'loading-detail';
  pending.textContent = 'Loading the payload…';
  body.appendChild(pending);

  let res;
  try {
    res = await fetch('/api/failures/' + failure.id);
  } catch (err) {
    pending.textContent = 'Could not load it: ' + err.message;
    return;
  }

  if (res.status === 401) return location.href = '/login';

  let detail;
  try {
    detail = await res.json();
  } catch {
    pending.textContent = 'Could not read the answer.';
    return;
  }

  if (!res.ok) {
    pending.textContent = detail.error || 'Could not load it.';
    return;
  }

  loaded.add(failure.id);
  body.textContent = '';

  body.appendChild(field('NSDC endpoint', detail.method + ' ' + detail.endpoint, true));
  body.appendChild(field('When', new Date(detail.occurredAt).toLocaleString()));
  body.appendChild(field('Uploaded by', detail.userEmail || 'Not recorded — the run predates per-person logins'));
  if (detail.sourceFile) body.appendChild(field('Sheet', detail.sourceFile));
  if (detail.subject) body.appendChild(field('Row was for', detail.subject));
  body.appendChild(field('What NSDC said', detail.errorMessage || '(nothing)'));

  if (detail.requestPayload) {
    body.appendChild(block2('Body sent to NSDC', JSON.stringify(detail.requestPayload, null, 2)));
  }
  if (detail.responseBody) {
    body.appendChild(block2('Answer from NSDC', detail.responseBody));
  }
}

function field(title, value, mono) {
  const wrap = document.createElement('div');
  wrap.className = 'field';
  const h = document.createElement('h4');
  h.textContent = title;
  const p = document.createElement('div');
  if (mono) p.className = 'mono';
  else p.style.fontSize = '0.8125rem';
  p.textContent = value;
  wrap.appendChild(h);
  wrap.appendChild(p);
  return wrap;
}

function block2(title, text) {
  const wrap = document.createElement('div');
  wrap.className = 'field';
  const h = document.createElement('h4');
  h.textContent = title;
  const pre = document.createElement('pre');
  pre.className = 'mono';
  pre.textContent = text;
  wrap.appendChild(h);
  wrap.appendChild(pre);
  return wrap;
}

exportLink.href = '/api/failures/export/csv';
loadPage();
