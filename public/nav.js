fetch('/api/me')
  .then(res => res.json())
  .then(me => {
    if (me.role !== 'super_admin') return;
    for (const link of document.querySelectorAll('.topnav a.su-only')) link.style.display = '';
  })
  .catch(() => {});
