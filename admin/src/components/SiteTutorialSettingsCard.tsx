'use client';

// «Обучалка по сайту: выключатель и суточные потолки» (П-Т9, заход 7) —
// карточка /settings. Бэкенд: GET/PATCH /api/admin/settings/site-tutorial
// (admin-site-tutorial-settings.service.ts). Читает и пишет те же ключи
// PlatformSetting, что проверяет запуск обучалки по сайту; изменения
// доходят до всех инстансов в течение 15 с (кэш настроек).

import { useEffect, useState } from 'react';
import { getSiteTutorialSettings, setSiteTutorialSettings } from '../lib/endpoints';
import type { SiteTutorialSettingsView } from '../lib/types';
import { ApiRequestError } from '../lib/admin-api';
import {
  capSummary,
  SITE_TUTORIAL_CAP_MAX,
  siteTutorialChanges,
  siteTutorialDraft,
  type SiteTutorialDraft,
} from '../lib/site-tutorial-settings';

function changedBy(at: string | null, by: string | null): string | null {
  if (!at) return null;
  return `изменено ${new Date(at).toLocaleString('ru-RU')}${by ? ` · ${by}` : ''}`;
}

export default function SiteTutorialSettingsCard() {
  const [state, setState] = useState<SiteTutorialSettingsView | null>(null);
  const [draft, setDraft] = useState<SiteTutorialDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const apply = (s: SiteTutorialSettingsView) => {
    setState(s);
    setDraft(siteTutorialDraft(s));
  };

  const load = () => {
    setError(null);
    getSiteTutorialSettings()
      .then(apply)
      .catch((err) =>
        setError(err instanceof ApiRequestError ? err.message : 'Не удалось загрузить настройки обучалки по сайту'),
      );
  };

  useEffect(load, []);

  const changes = state && draft ? siteTutorialChanges(state, draft) : null;
  const dirty = !!changes && (changes.error !== null || Object.keys(changes.input).length > 0);

  const save = async () => {
    if (!changes) return;
    if (changes.error) {
      setError(changes.error);
      return;
    }
    if (
      changes.input.paused === true &&
      !window.confirm(
        'Поставить обучалку по сайту на паузу? Новые раунды и живые сессии будут отклоняться у ВСЕХ пользователей ' +
          '(в течение 15 с на всех инстансах), пока выключатель не снят.',
      )
    ) {
      return;
    }
    setSaving(true);
    setError(null);
    try {
      apply(await setSiteTutorialSettings(changes.input));
      setSavedAt(Date.now());
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Не удалось сохранить настройки обучалки по сайту');
    } finally {
      setSaving(false);
    }
  };

  const capField = (key: 'rounds' | 'liveSessions', label: string) => {
    if (!state || !draft) return null;
    const c = state[key];
    const changed = changedBy(c.updatedAt, c.updatedBy);
    return (
      <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span>
          {label} в сутки (UTC, на всех пользователей)
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <input
            type="number"
            min={1}
            max={SITE_TUTORIAL_CAP_MAX}
            step={1}
            value={draft[key]}
            placeholder={`умолчание ${c.defaultValue}`}
            disabled={saving}
            style={{ width: 120 }}
            onChange={(e) => setDraft((prev) => (prev ? { ...prev, [key]: e.target.value } : prev))}
          />
          <span className="muted" style={{ fontSize: 13 }}>
            {capSummary(c)}
          </span>
        </span>
        {changed && (
          <span className="muted" style={{ fontSize: 12 }}>
            {changed}
          </span>
        )}
      </label>
    );
  };

  const pausedChanged = state ? changedBy(state.pausedUpdatedAt, state.pausedUpdatedBy) : null;

  return (
    <div className="card" style={{ marginBottom: 24 }}>
      <h2 style={{ fontSize: 16, marginBottom: 4 }}>Обучалка по сайту: выключатель и суточные потолки</h2>
      <p className="muted" style={{ marginBottom: 16 }}>
        Тормоз на инцидент и общий бюджет обучалки по сайту заказчика: выключатель останавливает новые раунды и
        живые сессии у всех пользователей; потолки ограничивают их число за сутки UTC сразу на всех (личные лимиты
        пользователя действуют отдельно). Пустое поле — умолчание (переменная окружения, иначе значение кода).
        Изменения действуют без передеплоя, в течение {state?.cacheSeconds ?? 15} с на всех инстансах. Кто и когда
        менял — под каждым полем.
      </p>

      {error && (
        <p style={{ color: 'var(--signal-critical)', marginBottom: 12 }}>
          {error}
          {!state && (
            <button type="button" onClick={load} style={{ marginLeft: 8 }}>
              Повторить
            </button>
          )}
        </p>
      )}

      {!state && !error && <p className="muted">Загрузка…</p>}

      {state && draft && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <input
              type="checkbox"
              checked={draft.paused}
              disabled={saving}
              onChange={(e) => setDraft((prev) => (prev ? { ...prev, paused: e.target.checked } : prev))}
            />
            <span>Обучалка по сайту на паузе</span>
            {state.paused && <span className="badge-status badge-status-critical">сейчас на паузе</span>}
            {pausedChanged && (
              <span className="muted" style={{ fontSize: 12 }}>
                {pausedChanged}
              </span>
            )}
          </label>
          {capField('rounds', 'Раундов')}
          {capField('liveSessions', 'Живых сессий')}

          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <button type="button" disabled={saving || !dirty} onClick={() => void save()}>
              Сохранить
            </button>
            <button type="button" disabled={saving} onClick={load}>
              Обновить расход
            </button>
            {saving && <span className="muted">Сохраняю…</span>}
            {savedAt && !saving && !dirty && (
              <span className="muted">Сохранено — действует в течение {state.cacheSeconds} с</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
