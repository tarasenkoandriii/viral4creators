'use client';
import { useState } from 'react';
import { importVirtualStudioMedia } from '../../lib/endpoints';

export function ImportStudioMedia({ studioId, onImported }: { studioId: string; onImported: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function upload(file: File | undefined, kind: 'image' | 'voice') {
    if (!file || busy) return;
    setBusy(true); setError(null);
    try {
      await importVirtualStudioMedia(studioId, kind, file);
      await onImported();
    } catch (e) { setError(e instanceof Error ? e.message : 'Не удалось импортировать файл'); }
    finally { setBusy(false); }
  }
  return <div className="card">
    <h2 style={{ fontSize: 15 }}>Собственный портрет и одобренная озвучка</h2>
    <p className="muted">Импорт без генерации и повторного синтеза. Используйте свои материалы с разрешёнными правами. Файлы будут доступны по ссылке в хранилище сервиса. До 6 МБ: JPEG/PNG или PCM WAV 16 bit, 0,5–30 секунд.</p>
    <label style={{ display: 'block', marginTop: 8 }}>Импорт портрета или скетча <input aria-label="Импорт портрета или скетча" type="file" accept="image/png,image/jpeg" disabled={busy} onChange={e => { const file=e.target.files?.[0]; e.target.value=''; void upload(file,'image'); }} /></label>
    <label style={{ display: 'block', marginTop: 8 }}>Импорт одобренного WAV <input aria-label="Импорт одобренного WAV" type="file" accept="audio/wav,.wav" disabled={busy} onChange={e => { const file=e.target.files?.[0]; e.target.value=''; void upload(file,'voice'); }} /></label>
    {busy && <p role="status">Импортируем файл…</p>}
    {error && <p role="alert" className="critical">{error}</p>}
  </div>;
}
