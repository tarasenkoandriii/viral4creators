'use client';

import { useEffect, useState } from 'react';
import { getEnvSettings, getVoiceoverProviderSettings, setVoiceoverProviderDefault } from '../../lib/endpoints';
import type { EnvCheckResult, EnvSettingsResult, VoiceoverProviderKey, VoiceoverProviderSettingsView } from '../../lib/types';
import { ApiRequestError } from '../../lib/admin-api';

const PROVIDER_LABEL: Record<VoiceoverProviderKey, string> = {
  elevenlabs: 'ElevenLabs',
  resemble: 'Resemble',
  veo: 'Veo (бесплатно, встроенный голос модели)',
};

const SEVERITY_LABEL: Record<EnvCheckResult['severity'], string> = {
  ok: 'Корректно',
  warning: 'Проверьте',
  critical: 'Ошибка',
};

function StatusBadge({ severity }: { severity: EnvCheckResult['severity'] }) {
  return <span className={`badge-status badge-status-${severity}`}>{SEVERITY_LABEL[severity]}</span>;
}

function groupChecks(checks: EnvCheckResult[]): Array<[string, EnvCheckResult[]]> {
  const order: string[] = [];
  const byGroup = new Map<string, EnvCheckResult[]>();
  for (const check of checks) {
    if (!byGroup.has(check.group)) {
      byGroup.set(check.group, []);
      order.push(check.group);
    }
    byGroup.get(check.group)!.push(check);
  }
  return order.map((group) => [group, byGroup.get(group)!]);
}

type ViewMode = 'all' | 'attention';

/**
 * «Озвучка по умолчанию» — доп. запрос владельца продукта: elevenlabs/
 * resemble/veo, veo как бесплатный фоллбек, когда на балансе платных
 * студий нет денег. В отличие от таблицы ниже (диагностика env-переменных,
 * read-only), это редактируемая настройка — меняется здесь и сразу же
 * подхватывается следующим синтезом, без передеплоя (см.
 * backend/src/modules/tts/tts-provider-resolver.service.ts).
 */
function VoiceoverProviderCard() {
  const [state, setState] = useState<VoiceoverProviderSettingsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = () => {
    getVoiceoverProviderSettings()
      .then(setState)
      .catch((err) => setError(err instanceof ApiRequestError ? err.message : 'Не удалось загрузить настройку озвучки'));
  };

  useEffect(load, []);

  const handleChange = async (provider: VoiceoverProviderKey) => {
    if (!state || provider === state.active) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await setVoiceoverProviderDefault(provider);
      setState(updated);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Не удалось сохранить настройку озвучки');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card" style={{ marginBottom: 24 }}>
      <h2 style={{ fontSize: 16, marginBottom: 4 }}>Озвучка по умолчанию</h2>
      <p className="muted" style={{ marginBottom: 16 }}>
        Какой провайдер синтеза используется для брендов с включённой озвучкой (`voiceMode: voiceover`/`dub`), если у
        голоса не указан провайдер явно. Veo — всегда доступный бесплатный вариант: реплики озвучивает сама модель,
        деньги и баланс аккаунта здесь ни при чём. Переключение действует сразу, без передеплоя.
      </p>

      {error && (
        <p style={{ color: 'var(--signal-critical)', marginBottom: 12 }}>{error}</p>
      )}

      {!state && !error && <p className="muted">Загрузка…</p>}

      {state && (
        <>
          <div className="filters" style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
            <select
              aria-label="Озвучка по умолчанию"
              value={state.active}
              disabled={saving}
              onChange={(e) => handleChange(e.target.value as VoiceoverProviderKey)}
            >
              {state.options.map((opt) => (
                <option key={opt.key} value={opt.key}>
                  {PROVIDER_LABEL[opt.key]}
                  {opt.key !== 'veo' ? (opt.configured ? ' — настроен' : ' — НЕ настроен на этом стенде') : ''}
                </option>
              ))}
            </select>
            {saving && <span className="muted">Сохраняю…</span>}
          </div>
          <p className="muted" style={{ fontSize: 13 }}>
            {state.source === 'admin'
              ? 'Задано вручную на этом экране.'
              : 'Ещё не менялось здесь — используется прежнее умолчание (переменная окружения TTS_PROVIDER или ElevenLabs).'}
            {' '}
            {state.active !== 'veo' &&
              !state.options.find((o) => o.key === state.active)?.configured &&
              'Внимание: выбранный провайдер не настроен на этом стенде (нет ключа/аккаунта) — озвучка будет молча пропускаться, ролики останутся с голосом Veo.'}
          </p>
        </>
      )}
    </div>
  );
}


export default function SettingsPage() {
  const [result, setResult] = useState<EnvSettingsResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Список переменных вырос настолько, что даже при полном порядке на
  // экране десятки строк «Корректно» — искать среди них единственную
  // проблемную неудобно. Фильтр чисто на клиенте, без похода на бэкенд:
  // `checks` уже содержит `ok` на каждую строку.
  const [mode, setMode] = useState<ViewMode>('all');

  useEffect(() => {
    getEnvSettings()
      .then(setResult)
      .catch((err) => setError(err instanceof ApiRequestError ? err.message : 'Не удалось загрузить настройки'));
  }, []);

  if (error) {
    return (
      <div className="page">
        <p style={{ color: 'var(--signal-critical)' }}>{error}</p>
      </div>
    );
  }

  if (!result) {
    return (
      <div className="page">
        <p className="muted">Загрузка…</p>
      </div>
    );
  }

  const problems = result.checks.filter((c) => !c.ok);
  // При «только требует внимания» из каждой группы остаются только
  // проблемные строки; группы, полностью прошедшие проверку, из вида
  // пропадают целиком — иначе остались бы пустые заголовки разделов.
  const visibleGroups = groupChecks(result.checks)
    .map(([group, checks]): [string, EnvCheckResult[]] => [
      group,
      mode === 'attention' ? checks.filter((c) => !c.ok) : checks,
    ])
    .filter(([, checks]) => checks.length > 0);

  return (
    <div className="page">
      <h1 style={{ fontSize: 20, marginBottom: 4 }}>Настройки</h1>
      <p className="muted" style={{ marginBottom: 20 }}>
        Статус переменных окружения бэкенда — задана ли переменная и похожа ли она на корректное
        значение. Секретные значения (ключи, токены, строки подключения к БД) здесь никогда не
        показываются — только вердикт и пояснение. Подробнее по каждой переменной —
        doc/LOCAL-DEVELOPMENT.md и doc/TELEGRAM-ADMIN.md.
      </p>

      <VoiceoverProviderCard />

      <div className="card" style={{ marginBottom: 24, display: 'flex', alignItems: 'center', gap: 12 }}>
        <StatusBadge severity={result.allOk ? 'ok' : problems.some((p) => p.severity === 'critical') ? 'critical' : 'warning'} />
        <span>
          {result.allOk
            ? 'Все переменные окружения в порядке.'
            : `${problems.length} из ${result.checks.length} переменных требуют внимания.`}
        </span>
      </div>

      <div className="filters" style={{ marginBottom: 20, display: 'flex', gap: 8, alignItems: 'center' }}>
        <select
          aria-label="Какие настройки показывать"
          value={mode}
          onChange={(e) => setMode(e.target.value as ViewMode)}
        >
          <option value="all">Все настройки</option>
          <option value="attention">Только требуется внимание</option>
        </select>
      </div>

      {mode === 'attention' && visibleGroups.length === 0 && (
        <p className="muted">Проблемных переменных нет — переключитесь на «Все настройки», чтобы увидеть полный список.</p>
      )}

      {visibleGroups.map(([group, checks]) => (
        <div className="settings-group" key={group}>
          <h2>{group}</h2>
          <div className="table-scroll">
            <table className="table-narrow">
              <thead>
                <tr>
                  <th>Переменная</th>
                  <th>Статус</th>
                  <th>Значение</th>
                  <th>Комментарий</th>
                </tr>
              </thead>
              <tbody>
                {checks.map((check) => (
                  <tr key={check.key}>
                    <td>
                      {check.key}
                      {check.required && (
                        <span className="muted" title="Обязательна">
                          {' '}
                          *
                        </span>
                      )}
                    </td>
                    <td>
                      <StatusBadge severity={check.severity} />
                    </td>
                    <td className="muted">{check.value ?? (check.set ? '(задано, секрет)' : '—')}</td>
                    <td className="muted">{check.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  );
}
