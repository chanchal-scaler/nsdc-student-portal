const params = new URLSearchParams(location.search);
const err = params.get('error');
if (err) {
  const el = document.getElementById('error');
  el.textContent = err;
  el.style.display = 'block';
}
