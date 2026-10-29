type FileResult =
  | { filename: string; status: 'ok'; document_id: number }
  | { filename: string; status: 'duplicate'; document_id: number; duplicate_of: string }
  | { filename: string; status: 'rejected'; reason: string };

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

$('upload').addEventListener('click', async () => {
  const input = $<HTMLInputElement>('files');
  if (!input.files?.length) return;
  const form = new FormData();
  for (const f of input.files) form.append('files', f, f.name);
  const res = await fetch('/api/upload', { method: 'POST', body: form });
  const { results } = (await res.json()) as { results: FileResult[] };
  $('upload-results').replaceChildren(
    ...results.map((r) => {
      const li = document.createElement('li');
      li.textContent =
        r.status === 'ok' ? `${r.filename}: принят`
        : r.status === 'duplicate' ? `${r.filename}: уже загружен (как ${r.duplicate_of})`
        : `${r.filename}: отклонён — ${r.reason}`;
      return li;
    }),
  );
  input.value = '';
});
