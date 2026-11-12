const rowsEl = document.getElementById('rows');
const emptyEl = document.getElementById('empty');
const errorEl = document.getElementById('error');
const doneEl = document.getElementById('done');
const whoami = document.getElementById('whoami');
const emailInput = document.getElementById('emailInput');
const labelInput = document.getElementById('labelInput');
const roleInput = document.getElementById('roleInput');
const addBtn = document.getElementById('addBtn');

let signedInAs = null;

function show(el, text) {
  el.textContent = text;
  el.style.display = text ? 'block' : 'none';
}

function when(value) {
  if (!value) return 'never';
  const d = new Date(value);
  return d.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function render(users) {
  rowsEl.innerHTML = '';
  emptyEl.style.display = users.length ? 'none' : 'block';

  for (const user of users) {
    const tr = document.createElement('tr');
    if (!user.active) tr.className = 'off';

    const email = document.createElement('td');
    email.className = 'who';
    email.textContent = user.email;

    const label = document.createElement('td');
    label.textContent = user.label || '';

    const role = document.createElement('td');
    const tag = document.createElement('span');
    if (!user.active) {
      tag.className = 'tag off';
      tag.textContent = 'No access';
    } else if (user.role === 'super_admin') {
      tag.className = 'tag super';
      tag.textContent = 'Super admin';
    } else {
      tag.className = 'tag';
      tag.textContent = 'Admin';
    }
    role.appendChild(tag);

    const last = document.createElement('td');
    last.className = 'when';
    last.textContent = when(user.last_login_at);

    const action = document.createElement('td');
    if (user.active && user.email !== signedInAs) {
      const btn = document.createElement('button');
      btn.className = 'off-btn';
      btn.textContent = 'Take access away';
      btn.onclick = () => takeAway(user.email, btn);
      action.appendChild(btn);
    }

    tr.append(email, label, role, last, action);
    rowsEl.appendChild(tr);
  }
}

async function load() {
  show(errorEl, '');
  try {
    const res = await fetch('/api/users');
    const data = await res.json();
    if (!res.ok) return show(errorEl, data.error || 'Could not read the list of logins.');
    signedInAs = data.signedInAs;
    whoami.textContent = data.signedInAs ? `Signed in as ${data.signedInAs}` : '';
    render(data.users);
  } catch (err) {
    show(errorEl, `Could not read the list of logins: ${err.message}`);
  }
}

async function add() {
  const email = emailInput.value.trim();
  if (!email) return show(errorEl, 'Give an email address.');

  show(errorEl, '');
  show(doneEl, '');
  addBtn.disabled = true;

  try {
    const res = await fetch('/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, label: labelInput.value.trim(), role: roleInput.value })
    });
    const data = await res.json();
    if (!res.ok) return show(errorEl, data.error || 'Could not save that login.');
    show(doneEl, `${email.toLowerCase()} can now sign in with Google. It has to be the address Google itself returns, not an alias.`);
    emailInput.value = '';
    labelInput.value = '';
    await load();
  } catch (err) {
    show(errorEl, `Could not save that login: ${err.message}`);
  } finally {
    addBtn.disabled = false;
  }
}

async function takeAway(email, btn) {
  if (!confirm(`${email} will not be able to sign in any more. Their past uploads still name them.`)) return;

  show(errorEl, '');
  show(doneEl, '');
  btn.disabled = true;

  try {
    const res = await fetch('/api/users/off', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email })
    });
    const data = await res.json();
    if (!res.ok) {
      btn.disabled = false;
      return show(errorEl, data.error || 'Could not change that login.');
    }
    show(doneEl, `${email} can no longer sign in.`);
    await load();
  } catch (err) {
    btn.disabled = false;
    show(errorEl, `Could not change that login: ${err.message}`);
  }
}

addBtn.onclick = add;
emailInput.addEventListener('keydown', event => { if (event.key === 'Enter') add(); });
load();
