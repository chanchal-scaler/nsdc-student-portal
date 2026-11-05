const rowsEl = document.getElementById('rows');
const emptyEl = document.getElementById('empty');
const errorEl = document.getElementById('error');
const moreBtn = document.getElementById('moreBtn');
const actorFilter = document.getElementById('actorFilter');
const actionFilter = document.getElementById('actionFilter');
const hoursFilter = document.getElementById('hoursFilter');
const whoami = document.getElementById('whoami');

const LABELS = {
  'login': ['Signed in', 'login'],
  'login-refused': ['Turned away', 'refused'],
  'logout': ['Signed out', 'login'],
  'run': ['Ran an upload', 'run'],
  'download': ['Took data out', 'download'],
  'view-failures': ['Opened the failures page', 'download'],
  'access-granted': ['Gave access to', 'access'],
  'access-revoked': ['Took access from', 'access']
};

const FILES = {
  '/api/download/file': 'the student data pulled from NSDC',
  '/api/upload/result': 'the students result sheet',
  '/api/upload/preview/file': 'the students payload preview',
  '/api/upload/enrollment-sheet': 'the enrolment sheet built from those students',
  '/api/batches/result': 'the batches result sheet',
  '/api/batches/preview/file': 'the batches payload preview',
  '/api/enroll/result': 'the enrolment result sheet',
  '/api/enroll/preview/file': 'the enrolment payload preview',
  '/api/complete/result': 'the completion result sheet',
  '/api/complete/preview/file': 'the completion payload preview',
  '/api/certificates/result': 'the certificates result sheet',
  '/api/failures/export/csv': 'the failures sheet',
  '/failures': 'the failures page'
};

function named(detail) {
  if (!detail) return '';
  const [path, rest] = detail.split(' — ');
  const name = FILES[path];
  if (!name) return detail;
  return rest ? `${name} — ${rest}` : name;
}

let oldestId = null;
let actorsLoaded = false;

function when(at) {
  return new Date(at).toLocaleString(undefined, {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'
  });
}

function addRow(event) {
  const [text, tone] = LABELS[event.action] || [event.action, ''];
  const tr = document.createElement('tr');

  const time = document.createElement('td');
  time.className = 'when';
  time.textContent = when(event.at);

  const who = document.createElement('td');
  who.className = 'who';
  who.textContent = event.actor || 'not known';

  const what = document.createElement('td');
  const tag = document.createElement('span');
  tag.className = 'tag ' + tone;
  tag.textContent = text;
  what.appendChild(tag);

  const detail = document.createElement('td');
  detail.className = 'detail';
  detail.textContent = event.action === 'download' || event.action === 'view-failures'
    ? named(event.detail)
    : (event.detail || '');

  tr.append(time, who, what, detail);
  rowsEl.appendChild(tr);
}

async function load(append) {
  errorEl.style.display = 'none';
  const params = new URLSearchParams();
  if (append && oldestId) params.set('before', oldestId);
  if (actorFilter.value) params.set('actor', actorFilter.value);
  if (actionFilter.value) params.set('action', actionFilter.value);
  if (hoursFilter.value) params.set('hours', hoursFilter.value);

  let res, body;
  try {
    res = await fetch('/api/activity?' + params.toString());
    if (res.status === 401) return location.href = '/login';
    body = await res.json();
  } catch (err) {
    errorEl.textContent = 'Could not load: ' + err.message;
    errorEl.style.display = 'block';
    return;
  }

  if (!res.ok) {
    errorEl.textContent = body.error || 'Could not load';
    errorEl.style.display = 'block';
    return;
  }

  if (!append) rowsEl.textContent = '';
  if (body.signedInAs) whoami.textContent = 'Signed in as ' + body.signedInAs;

  if (!actorsLoaded) {
    for (const actor of body.actors || []) {
      const option = document.createElement('option');
      option.value = actor;
      option.textContent = actor;
      actorFilter.appendChild(option);
    }
    actorsLoaded = true;
  }

  for (const event of body.events) addRow(event);
  if (body.events.length > 0) oldestId = body.events[body.events.length - 1].id;

  emptyEl.style.display = rowsEl.children.length === 0 ? 'block' : 'none';
  moreBtn.style.display = body.events.length === 50 ? 'block' : 'none';
}

for (const filter of [actorFilter, actionFilter, hoursFilter]) {
  filter.addEventListener('change', () => { oldestId = null; load(false); });
}
moreBtn.addEventListener('click', () => load(true));

load(false);
