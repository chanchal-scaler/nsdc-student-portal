const params = new URLSearchParams(location.search);
const err = params.get('error');
if (err) {
  const el = document.getElementById('error');
  el.textContent = err;
  el.style.display = 'block';
}

fetch('/api/login-mode')
  .then(res => res.json())
  .then(mode => {
    const note = document.getElementById('note');
    note.textContent = 'Only ' + mode.domain + ' accounts that have been given access can sign in.';
    if (mode.dev) document.getElementById('dev').style.display = 'block';
  })
  .catch(() => {});
