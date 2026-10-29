const status = document.getElementById('status')!;
fetch('/api/health')
  .then((r) => r.json())
  .then((d: { ok: boolean }) => { status.textContent = d.ok ? 'Сервер работает' : 'Сервер недоступен'; })
  .catch(() => { status.textContent = 'Сервер недоступен'; });
