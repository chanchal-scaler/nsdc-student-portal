// The second half of this page: fetching the certificates NSDC has issued.
// Kept apart from the generate half because the two runs are independent — one
// can be watched while the other is idle, and neither shares state with the
// other beyond which candidates the last generate covered.
const fetchLastBtn = document.getElementById('fetchLastBtn');
const fetchAllBtn = document.getElementById('fetchAllBtn');
const fetchNote = document.getElementById('fetchNote');
const fetchStatus = document.getElementById('fetchStatus');
const zipRow = document.getElementById('zipRow');
const zipMeta = document.getElementById('zipMeta');

let fetchPollTimer = null;

fetchLastBtn.addEventListener('click', () => startFetch('last'));
fetchAllBtn.addEventListener('click', () => startFetch('everyone'));

async function loadDownloadable() {
  try {
    const res = await fetch('/api/certificates/downloadable');
    if (res.status === 401) return location.href = '/login';
    const data = await res.json();

    if (data.error) {
      fetchNote.textContent = data.error;
      fetchLastBtn.disabled = true;
      fetchAllBtn.disabled = true;
      return;
    }

    const parts = [];
    if (data.lastRun) parts.push(data.lastRun + ' from the last run');
    parts.push(data.everyone + ' on record');
    fetchNote.textContent = parts.join(', ') + '.';

    fetchLastBtn.disabled = !data.lastRun;
    fetchAllBtn.disabled = !data.everyone;
  } catch {
    fetchNote.textContent = 'Could not read how many certificates there are.';
  }
}

async function startFetch(scope) {
  fetchLastBtn.disabled = true;
  fetchAllBtn.disabled = true;
  zipRow.style.display = 'none';
  showFetchStatus('running', 'Starting…');

  try {
    const res = await fetch('/api/certificates/download?scope=' + scope, { method: 'POST' });
    if (res.status === 401) return location.href = '/login';
    const body = await res.json();

    if (!res.ok) {
      showFetchStatus('error', body.note || body.error || 'Could not start.');
      loadDownloadable();
      return;
    }

    pollFetch();
  } catch (err) {
    showFetchStatus('error', 'Could not start: ' + err.message);
    loadDownloadable();
  }
}

// All dynamic values are rendered via textContent / DOM nodes, never innerHTML

function showFetchStatus(cls, text) {
  fetchStatus.className = 'status ' + cls;
  fetchStatus.textContent = text;
}

function showFetching(data) {
  fetchStatus.className = 'status running';
  fetchStatus.textContent = '';

  const spinner = document.createElement('span');
  spinner.className = 'spinner';
  fetchStatus.appendChild(spinner);

  const held = data.alreadyHad ? data.alreadyHad + ' already in hand, ' : '';
  fetchStatus.appendChild(document.createTextNode(
    'Fetching ' + Math.min(data.processed + 1, data.total) + ' of ' + data.total +
    ' — ' + held + data.downloaded + ' fetched, ' + data.failed + ' failed'
  ));

  const bar = document.createElement('div');
  bar.className = 'progress-bar';
  const fill = document.createElement('div');
  fill.className = 'progress-fill';
  fill.style.width = (data.total ? Math.round(data.processed / data.total * 100) : 0) + '%';
  bar.appendChild(fill);
  fetchStatus.appendChild(bar);
}

async function pollFetch() {
  clearTimeout(fetchPollTimer);
  let data;
  try {
    const res = await fetch('/api/certificates/download/status');
    if (res.status === 401) return location.href = '/login';
    data = await res.json();
  } catch {
    fetchPollTimer = setTimeout(pollFetch, 3000);
    return;
  }

  if (data.state === 'running') {
    fetchLastBtn.disabled = true;
    fetchAllBtn.disabled = true;
    showFetching(data);
    fetchPollTimer = setTimeout(pollFetch, 1500);
    return;
  }

  loadDownloadable();

  if (data.state === 'done') {
    let message = 'The zip holds ' + data.held + ' of ' + data.total + ' certificates — ' + data.scope + '.';
    if (data.alreadyHad) message += ' ' + data.downloaded + ' fetched this time, ' + data.alreadyHad + ' already in hand.';
    if (data.failed) message += ' ' + data.failed + ' could not be fetched.';
    showFetchStatus(data.failed ? 'error' : 'done', message);
  } else if (data.state === 'error') {
    // A run that stopped still holds what it fetched, and can be started again
    // without asking NSDC for those
    const got = data.held
      ? 'The zip holds ' + data.held + ' of ' + data.total + '. Starting it again asks NSDC only for the rest.'
      : 'Nothing was fetched.';
    showFetchStatus('error', (data.serviceDown
      ? 'Skill India (NSDC) was not responding. '
      : (data.error || 'The run stopped.') + ' ') + got);
  }

  if (data.zipReady) {
    zipRow.style.display = 'block';
    zipMeta.textContent = data.zipFileName + ' — ' + data.held + ' certificate(s), finished ' +
      new Date(data.finishedAt).toLocaleString();
  }
}

loadDownloadable();
pollFetch();
