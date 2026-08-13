const startBtn = document.getElementById('startBtn');
const statusEl = document.getElementById('status');
const downloadRow = document.getElementById('downloadRow');
const fileMeta = document.getElementById('fileMeta');
let pollTimer = null;

startBtn.addEventListener('click', startDownload);

async function startDownload() {
  startBtn.disabled = true;
  try {
    const res = await fetch('/api/download/start', { method: 'POST' });
    if (res.status === 401) return location.href = '/login';
    if (!res.ok && res.status !== 409) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || 'Failed to start download');
    }
    poll();
  } catch (err) {
    showStatus('error', 'Error: ' + err.message);
    startBtn.disabled = false;
  }
}

// All dynamic values are rendered via textContent / DOM nodes, never innerHTML
function showStatus(cls, text) {
  statusEl.className = 'status ' + cls;
  statusEl.textContent = text;
}

function showRunning(data) {
  statusEl.className = 'status running';
  statusEl.textContent = '';

  const spinner = document.createElement('span');
  spinner.className = 'spinner';
  statusEl.appendChild(spinner);

  const total = data.totalPages || '?';
  statusEl.appendChild(document.createTextNode(
    'Fetching page ' + (data.pagesFetched + 1) + ' of ' + total +
    ' — ' + data.totalStudents.toLocaleString() + ' students so far'
  ));

  const bar = document.createElement('div');
  bar.className = 'progress-bar';
  const fill = document.createElement('div');
  fill.className = 'progress-fill';
  const pct = data.totalPages ? Math.min(100, Math.round(data.pagesFetched / data.totalPages * 100)) : 0;
  fill.style.width = pct + '%';
  bar.appendChild(fill);
  statusEl.appendChild(bar);
}

async function poll() {
  clearTimeout(pollTimer);
  let data;
  try {
    const res = await fetch('/api/download/status');
    if (res.status === 401) return location.href = '/login';
    data = await res.json();
  } catch {
    pollTimer = setTimeout(poll, 3000);
    return;
  }

  if (data.state === 'running') {
    startBtn.disabled = true;
    showRunning(data);
    downloadRow.style.display = 'none';
    pollTimer = setTimeout(poll, 2000);
  } else if (data.state === 'done') {
    startBtn.disabled = false;
    let msg = 'Done! ' + data.totalStudents.toLocaleString() + ' students fetched.';
    if (data.failedPages && data.failedPages.length > 0) {
      msg += ' Warning: ' + data.failedPages.length + ' page(s) failed: ' + data.failedPages.join(', ');
    }
    showStatus('done', msg);
    if (data.fileReady) {
      downloadRow.style.display = 'block';
      fileMeta.textContent = data.fileName + ' — completed ' + new Date(data.finishedAt).toLocaleString();
    }
  } else if (data.state === 'error') {
    startBtn.disabled = false;
    showStatus('error', 'Download failed: ' + (data.error || 'Unknown error'));
    if (data.fileReady) downloadRow.style.display = 'block';
  } else {
    startBtn.disabled = false;
  }
}

// On page load, pick up any in-progress or completed job
poll();
