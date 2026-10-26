const sendableNote = document.getElementById('sendableNote');
const previewSendBtn = document.getElementById('previewSendBtn');
const sendStatus = document.getElementById('sendStatus');
const sendPreview = document.getElementById('sendPreview');
const sendPreviewTitle = document.getElementById('sendPreviewTitle');
const sendPreviewBody = document.getElementById('sendPreviewBody');
const sendErrors = document.getElementById('sendErrors');
const sendErrorsTitle = document.getElementById('sendErrorsTitle');
const sendErrorList = document.getElementById('sendErrorList');

previewSendBtn.addEventListener('click', previewSend);

function cell(text, className) {
  const td = document.createElement('td');
  td.textContent = text;
  if (className) td.className = className;
  return td;
}

async function loadSendable() {
  let data;
  try {
    const res = await fetch('/api/certificates/sendable');
    if (res.status === 401) return location.href = '/login';
    data = await res.json();
  } catch {
    sendableNote.textContent = 'Could not read who is waiting on an email.';
    previewSendBtn.disabled = true;
    return;
  }

  if (data.error) {
    sendableNote.textContent = data.error;
    previewSendBtn.disabled = true;
    return;
  }

  if (!data.total) {
    sendableNote.textContent = 'Nobody. Every certificate held here has already been emailed, ' +
      'and a certificate has to be downloaded before it can go anywhere.';
    previewSendBtn.disabled = true;
    return;
  }

  const batches = (data.batches || [])
    .map(b => (b.batchName || 'batch ' + b.batchId) + ' (' + b.students + ')')
    .join(', ');

  let note = data.total + ' student(s) have a certificate here that has not been emailed';
  if (batches) note += ' — in ' + batches;
  note += '.';
  if (data.withoutEmail) {
    note += ' ' + data.withoutEmail + ' of them have no email address on record.';
  }
  sendableNote.textContent = note;
  previewSendBtn.disabled = false;
}

async function previewSend() {
  previewSendBtn.disabled = true;
  sendErrors.style.display = 'none';
  sendPreview.style.display = 'none';
  sendStatus.className = 'status running';
  sendStatus.textContent = 'Working out what would be sent…';

  let res, body;
  try {
    res = await fetch('/api/certificates/send/preview', { method: 'POST' });
    if (res.status === 401) return location.href = '/login';
    body = await res.json();
  } catch (err) {
    sendStatus.className = 'status error';
    sendStatus.textContent = 'Could not build the preview: ' + err.message;
    previewSendBtn.disabled = false;
    return;
  }

  previewSendBtn.disabled = false;

  if (!res.ok) {
    sendStatus.className = 'status error';
    sendStatus.textContent = body.error || 'Could not build the preview.';
    return;
  }

  sendStatus.className = 'status done';
  sendStatus.textContent = body.sendable + ' email(s) would go out' +
    (body.unreachableCount ? ', ' + body.unreachableCount + ' student(s) could not be reached' : '') +
    '. Nothing has been sent.';

  sendPreviewBody.textContent = '';
  for (const row of body.rows || []) {
    const tr = document.createElement('tr');
    tr.appendChild(cell(row.name || row.candidateId));
    tr.appendChild(cell(row.email));
    tr.appendChild(cell(row.batchName || String(row.batchId)));
    tr.appendChild(cell(row.attachment, 'mono'));
    tr.appendChild(cell(row.sentBefore ? row.sentBefore + ' time(s)' : 'no'));
    sendPreviewBody.appendChild(tr);
  }
  if ((body.rows || []).length > 0) {
    sendPreviewTitle.textContent = 'What would be sent — showing ' +
      body.rows.length + ' of ' + body.sendable;
    sendPreview.style.display = 'block';
  }

  if ((body.unreachable || []).length > 0) {
    sendErrorsTitle.textContent = 'Cannot be reached — ' + body.unreachableCount + ' student(s)';
    sendErrorList.textContent = '';
    for (const row of body.unreachable) {
      const li = document.createElement('li');
      li.textContent = row.candidateId + (row.batchName ? ' (' + row.batchName + ')' : '') +
        ' — ' + row.reason;
      sendErrorList.appendChild(li);
    }
    sendErrors.style.display = 'block';
  }
}

loadSendable();
document.addEventListener('certificates:done', loadSendable);
