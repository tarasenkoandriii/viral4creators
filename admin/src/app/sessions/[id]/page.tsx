'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { getSession, deleteSession } from '../../../lib/endpoints';
import type { SessionDetail } from '../../../lib/types';
import { ApiRequestError } from '../../../lib/admin-api';
import { ConfirmDialog } from '../../../components/ConfirmDialog';

export default function SessionDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const [session, setSession] = useState<SessionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  // «Умный» алерт удаления (этап 89) — тот же механизм, что на TMA-
  // стороне (ProjectScreen/PostprodScreen): вместо `confirm(...)` —
  // модалка. У сессии нет под-сущностей для превью (см. doc-комментарий
  // ConfirmDialog.tsx), поэтому тело диалога — фиксированный текст.
  const [confirmOpen, setConfirmOpen] = useState(false);

  useEffect(() => {
    getSession(params.id)
      .then(setSession)
      .catch((err) => setError(err instanceof ApiRequestError ? err.message : 'Не удалось загрузить сессию'));
  }, [params.id]);

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await deleteSession(params.id);
      router.replace('/sessions');
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Не удалось удалить сессию');
      setDeleting(false);
      setConfirmOpen(false);
    }
  };

  if (error) {
    return (
      <div className="page">
        <p style={{ color: 'var(--signal-critical)' }}>{error}</p>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="page">
        <p className="muted">Загрузка…</p>
      </div>
    );
  }

  return (
    <div className="page">
      <h1 style={{ fontSize: 20, marginBottom: 4 }}>Сессия {session.sessionId}</h1>
      <p className="muted" style={{ marginBottom: 20 }}>
        Статус: {session.status} · создана {new Date(session.createdAt).toLocaleString('ru-RU')} · последняя
        активность {new Date(session.lastActivityAt).toLocaleString('ru-RU')}
        {session.userId && <> · пользователь {session.userId}</>}
      </p>

      {session.productName && (
        <div className="card" style={{ marginBottom: 16 }}>
          <strong>Товар:</strong> {session.productName}
        </div>
      )}

      {session.downloadUrl && (
        <div className="card" style={{ marginBottom: 16 }}>
          <p style={{ marginBottom: 8 }}>
            <strong>Готовое видео</strong>
          </p>
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <video src={session.downloadUrl} controls style={{ maxWidth: '100%', borderRadius: 8 }} />
        </div>
      )}

      <div className="card" style={{ marginBottom: 16 }}>
        <p style={{ marginBottom: 8 }}>
          <strong>Полные данные сессии</strong>
        </p>
        <pre style={{ overflow: 'auto', fontSize: 12, whiteSpace: 'pre-wrap' }}>
          {JSON.stringify(session.data, null, 2)}
        </pre>
      </div>

      <button type="button" onClick={() => setConfirmOpen(true)} disabled={deleting}>
        {deleting ? 'Удаление…' : 'Удалить сессию'}
      </button>

      <ConfirmDialog
        open={confirmOpen}
        title={`Удалить сессию ${params.id}?`}
        busy={deleting}
        onConfirm={() => void handleDelete()}
        onCancel={() => setConfirmOpen(false)}
      >
        Ролик (если сгенерирован), история генерации и все файлы сессии
        будут удалены. Восстановить через интерфейс нельзя.
      </ConfirmDialog>
    </div>
  );
}
