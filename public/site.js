'use strict';
(async () => {
  const $ = (id) => document.getElementById(id);
  const money = (cur, n) => `${cur}${Number.isInteger(n) ? n : n.toFixed(2)}`;

  // Price per bot per week (the same number the Discord shop uses) and the login state.
  let info = { price: { perWeek: 1, currency: '€' }, signedIn: false };
  try {
    const r = await fetch('/api/site', { credentials: 'same-origin' });
    if (r.ok) info = await r.json();
  } catch { /* the page works with the defaults */ }

  const { perWeek, currency } = info.price;
  $('heroPrice').textContent = money(currency, perWeek);
  $('priceAmount').textContent = money(currency, perWeek);
  const rows = $('priceRows');
  for (const n of [1, 3, 5, 10]) {
    const tr = document.createElement('tr');
    const a = document.createElement('td'); a.textContent = `${n} bot${n === 1 ? '' : 's'}`;
    const b = document.createElement('td'); b.textContent = money(currency, Math.round(perWeek * n * 100) / 100);
    tr.append(a, b);
    rows.append(tr);
  }

  // Login top right; once signed in it becomes the way back into the panel.
  const btn = $('authBtn');
  if (info.signedIn) { btn.href = '/panel'; btn.textContent = 'Go to panel'; }

  // Panel preview tabs
  const img = $('shotImg');
  for (const b of document.querySelectorAll('.tabs button')) {
    b.addEventListener('click', () => {
      for (const o of document.querySelectorAll('.tabs button')) { o.classList.toggle('on', o === b); o.setAttribute('aria-selected', String(o === b)); }
      img.src = `/site/preview-${b.dataset.shot}.png`;
    });
  }
})();
