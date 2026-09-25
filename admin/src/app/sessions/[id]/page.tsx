'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { getSession, deleteSession } from '../../../lib/endpoints';
import type { SessionDetail } from '../../../lib/types';
import { ApiRequestError } from '../../../lib/admin-api';
import { ConfirmDialog } from '../../../components/ConfirmDialog';
import { AudioTracksPanel } from '../../../components/AudioTracksPanel';

/**
 * Найдено при аудите пайплайна GREETING_VIDEO (находка №4): «Полные
 * данные сессии» ниже уже дампят `session.data` целиком как JSON, так
 * что `greetingBriefSnapshot` технически виден оператору и без этой
 * карточки — но найти повод/получателя/текст поздравления среди сотен
 * строк сырого JSON неудобно, а у «Товар:» (см. ниже) есть своя
 * заметная карточка. Эта функция — тот же приём для брифа
 * ролика-поздравления: пока `data` типизирован как `unknown` (нет
 * общего пакета типов бэкенд/фронтенд, см. header-комментарий файла),
 * читаем поле защищённо и рендерим карточку, только когда оно есть.
 */
function greetingBriefFromData(data: unknown): {
  occasion: string;
  customOccasionText: string | null;
  recipientName: string;
  senderName: string | null;
  tone: string;
  personalMessage: string | null;
  occasionDate: string | null;
} | null {
  if (!data || typeof data !== 'object') return null;
  const brief = (data as { greetingBriefSnapshot?: unknown }).greetingBriefSnapshot;
  if (!brief || typeof brief !== 'object') return null;
  const b = brief as Record<string, unknown>;
  if (typeof b.occasion !== 'string' || typeof b.recipientName !== 'string' || typeof b.tone !== 'string') {
    return null;
  }
  return {
    occasion: b.occasion,
    customOccasionText: typeof b.customOccasionText === 'string' ? b.customOccasionText : null,
    recipientName: b.recipientName,
    senderName: typeof b.senderName === 'string' ? b.senderName : null,
    tone: b.tone,
    personalMessage: typeof b.personalMessage === 'string' ? b.personalMessage : null,
    occasionDate: typeof b.occasionDate === 'string' ? b.occasionDate : null,
  };
}

/** То же защитное чтение, что у `greetingBriefFromData` — сколько
 * референс-изображений загрузил создатель и с какими подписями,
 * прежде видное оператору только внутри сырого JSON. */
function greetingReferencesFromData(data: unknown): { label: string; description: string | null }[] {
  if (!data || typeof data !== 'object') return [];
  const images = (data as { greetingReferenceImages?: unknown }).greetingReferenceImages;
  if (!Array.isArray(images)) return [];
  return images
    .filter((img): img is Record<string, unknown> => !!img && typeof img === 'object')
    .map((img) => ({
      label: typeof img.label === 'string' ? img.label : '(без подписи)',
      description: typeof img.description === 'string' ? img.description : null,
    }));
}

const OCCASION_LABEL: Record<string, string> = {
  BIRTHDAY: 'День рождения',
  WEDDING: 'Свадьба',
  ANNIVERSARY: 'Годовщина',
  NEW_YEAR: 'Новый год',
  GRADUATION: 'Выпускной',
  CORPORATE: 'Корпоративное поздравление',
  OTHER: 'Другое',
};

const TONE_LABEL: Record<string, string> = {
  WARM: 'Тёплый, душевный',
  FUNNY: 'С юмором',
  FORMAL: 'Официальный',
};

/** Флаги модерации промпта (`generationPrompt.moderationStatus`/
 * `.moderationFlags`) — раньше у GREETING_VIDEO этот статус вообще
 * никогда не был `flagged` (см. аудит пайплайна, находка №2), теперь
 * может быть, и оператору стоит видеть это не только в сыром JSON.
 * Поле общее для всех типов проекта, не только GREETING_VIDEO. */
function moderationFlagsFromData(data: unknown): string[] | null {
  if (!data || typeof data !== 'object') return null;
  const prompt = (data as { generationPrompt?: unknown }).generationPrompt;
  if (!prompt || typeof prompt !== 'object') return null;
  const p = prompt as Record<string, unknown>;
  if (p.moderationStatus !== 'flagged') return null;
  return Array.isArray(p.moderationFlags)
    ? p.moderationFlags.filter((f): f is string => typeof f === 'string')
    : [];
}

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

      {(() => {
        const flags = moderationFlagsFromData(session.data);
        if (!flags) return null;
        return (
          <div className="card" style={{ marginBottom: 16, borderColor: 'var(--signal-critical)' }}>
            <strong style={{ color: 'var(--signal-critical)' }}>
              ⚠ Промпт помечен модерацией
            </strong>
            {flags.length > 0 && <p style={{ margin: '4px 0 0' }}>Причины: {flags.join(', ')}</p>}
          </div>
        );
      })()}

      {(() => {
        const brief = greetingBriefFromData(session.data);
        if (!brief) return null;
        const references = greetingReferencesFromData(session.data);
        return (
          <div className="card" style={{ marginBottom: 16 }}>
            <p style={{ marginBottom: 8 }}>
              <strong>Бриф ролика-поздравления</strong>
            </p>
            <p style={{ margin: '2px 0' }}>
              <strong>Повод:</strong>{' '}
              {brief.occasion === 'OTHER' && brief.customOccasionText
                ? brief.customOccasionText
                : (OCCASION_LABEL[brief.occasion] ?? brief.occasion)}
              {brief.occasionDate ? ` (${brief.occasionDate})` : ''}
            </p>
            <p style={{ margin: '2px 0' }}>
              <strong>Получатель:</strong> {brief.recipientName}
              {brief.senderName ? ` — от ${brief.senderName}` : ''}
            </p>
            <p style={{ margin: '2px 0' }}>
              <strong>Тон:</strong> {TONE_LABEL[brief.tone] ?? brief.tone}
            </p>
            {brief.personalMessage && (
              <p style={{ margin: '8px 0 0', whiteSpace: 'pre-wrap' }}>
                <strong>Текст поздравления:</strong> {brief.personalMessage}
              </p>
            )}
            {references.length > 0 && (
              <p style={{ margin: '8px 0 0' }}>
                <strong>Референс-изображения ({references.length}):</strong>{' '}
                {references
                  .map((r) => (r.description ? `${r.label} — ${r.description}` : r.label))
                  .join('; ')}
              </p>
            )}
          </div>
        );
      })()}

      {session.downloadUrl && (
        <div className="card" style={{ marginBottom: 16 }}>
          <p style={{ marginBottom: 8 }}>
            <strong>Готовое видео</strong>
          </p>
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <video src={session.downloadUrl} controls style={{ maxWidth: '100%', borderRadius: 8 }} />
        </div>
      )}

      {/* Этап 139: мультиязычные дорожки — работа оператора, и место ей
          рядом с самим роликом, а не отдельной вкладкой: человек
          приходит сюда, уже открыв нужный ролик. */}
      <div className="card" style={{ marginBottom: 16 }}>
        <AudioTracksPanel sessionId={params.id} />
      </div>

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
