'use client';

import { useEffect, useState } from 'react';
import {
  getEnvSettings,
  getVoiceoverProviderSettings,
  setVoiceoverProviderDefault,
  getAnalysisProviderSettings,
  setAnalysisProviderDefault,
  getVideoProviderSettings,
  setVideoProviderDefault,
  getGrokTransportSettings,
  setGrokTransport,
  getAssistantSettings,
  setAssistantSettings,
  seedFixtureUser,
  getVirtualStudioHedraEnabled,
  setVirtualStudioHedraEnabled,
} from '../../lib/endpoints';
import type {
  EnvCheckResult,
  EnvSettingsResult,
  VoiceoverProviderKey,
  VoiceoverProviderSettingsView,
  AnalysisProviderKey,
  AnalysisProviderSettingsView,
  VideoProviderKey,
  VideoProviderSettingsView,
  GrokTransportKey,
  GrokTransportSettingsView,
  AssistantAdminSettingsView,
  FixtureSeedResult,
} from '../../lib/types';
import { ApiRequestError } from '../../lib/admin-api';

const PROVIDER_LABEL: Record<VoiceoverProviderKey, string> = {
  elevenlabs: 'ElevenLabs',
  resemble: 'Resemble',
  veo: 'Veo (бесплатно, встроенный голос модели)',
};

const ANALYSIS_PROVIDER_LABEL: Record<AnalysisProviderKey, string> = {
  gemini: 'Gemini',
  grok: 'Grok',
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
    setError(null);
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
        <p style={{ color: 'var(--signal-critical)', marginBottom: 12 }}>
          {error}
          {/* Аудит 14.09.2026 (М-7.9): ошибка загрузки — не тупик, а «Повторить». */}
          {!state && (
            <>
              {' '}
              <button type="button" onClick={load} style={{ marginLeft: 8 }}>
                Повторить
              </button>
            </>
          )}
        </p>
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

/**
 * «Разбор референса по умолчанию» — доп. запрос владельца продукта: тот
 * же принцип, что у VoiceoverProviderCard выше (ТЗ §17). `grok` показан
 * в списке, но недоступен для выбора — `select` не даёт его выбрать
 * (`disabled` на `<option>`), сам разбор через Grok ещё не реализован.
 */
function AnalysisProviderCard() {
  const [state, setState] = useState<AnalysisProviderSettingsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = () => {
    setError(null);
    getAnalysisProviderSettings()
      .then(setState)
      .catch((err) => setError(err instanceof ApiRequestError ? err.message : 'Не удалось загрузить настройку разбора видео'));
  };

  useEffect(load, []);

  const handleChange = async (provider: AnalysisProviderKey) => {
    if (!state || provider === state.active) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await setAnalysisProviderDefault(provider);
      setState(updated);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Не удалось сохранить настройку разбора видео');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card" style={{ marginBottom: 24 }}>
      <h2 style={{ fontSize: 16, marginBottom: 4 }}>Разбор референса по умолчанию</h2>
      <p className="muted" style={{ marginBottom: 16 }}>
        Какая модель анализирует загруженное видео (сцены, персонажи, аудитория, товар). Grok показан в списке, но
        выбрать его пока нельзя — сам разбор через Grok ещё не реализован, доступен только Gemini.
      </p>

      {error && (
        <p style={{ color: 'var(--signal-critical)', marginBottom: 12 }}>
          {error}
          {/* Аудит 14.09.2026 (М-7.9): ошибка загрузки — не тупик, а «Повторить». */}
          {!state && (
            <>
              {' '}
              <button type="button" onClick={load} style={{ marginLeft: 8 }}>
                Повторить
              </button>
            </>
          )}
        </p>
      )}

      {!state && !error && <p className="muted">Загрузка…</p>}

      {state && (
        <>
          <div className="filters" style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
            <select
              aria-label="Разбор референса по умолчанию"
              value={state.active}
              disabled={saving}
              onChange={(e) => handleChange(e.target.value as AnalysisProviderKey)}
            >
              {state.options.map((opt) => (
                <option key={opt.key} value={opt.key} disabled={!opt.available}>
                  {ANALYSIS_PROVIDER_LABEL[opt.key]}
                  {!opt.available ? ` — ${opt.unavailableReason ?? 'недоступно'}` : ''}
                </option>
              ))}
            </select>
            {saving && <span className="muted">Сохраняю…</span>}
          </div>
          <p className="muted" style={{ fontSize: 13 }}>
            {state.source === 'admin'
              ? 'Задано вручную на этом экране.'
              : 'Ещё не менялось здесь — используется Gemini по умолчанию.'}
          </p>
        </>
      )}
    </div>
  );
}

/**
 * «Провайдер видео-генерации по умолчанию» — доп. запрос владельца
 * продукта: закрывает недостающую админскую половину решения §11.1
 * (найдено при аудите ТЗ §20) — раньше это был только код-дефолт в
 * `GenerationWizard.tsx`, теперь оператор может поменять его здесь,
 * без передеплоя фронтенда. В отличие от `AnalysisProviderCard` выше,
 * оба провайдера уже полностью реализованы — нет пункта «показан, но
 * недоступен».
 */
function VideoProviderCard() {
  const [state, setState] = useState<VideoProviderSettingsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = () => {
    setError(null);
    getVideoProviderSettings()
      .then(setState)
      .catch((err) => setError(err instanceof ApiRequestError ? err.message : 'Не удалось загрузить настройку провайдера видео'));
  };

  useEffect(load, []);

  const handleChange = async (provider: VideoProviderKey) => {
    if (!state || provider === state.active) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await setVideoProviderDefault(provider);
      setState(updated);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Не удалось сохранить настройку провайдера видео');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card" style={{ marginBottom: 24 }}>
      <h2 style={{ fontSize: 16, marginBottom: 4 }}>Провайдер видео-генерации по умолчанию</h2>
      <p className="muted" style={{ marginBottom: 16 }}>
        Какой провайдер предзаполнен на экране генерации при первом открытии. Пользователь всегда может выбрать
        другой на конкретной генерации — это влияет только на то, что выбрано изначально.
      </p>

      {error && (
        <p style={{ color: 'var(--signal-critical)', marginBottom: 12 }}>
          {error}
          {/* Аудит 14.09.2026 (М-7.9): ошибка загрузки — не тупик, а «Повторить». */}
          {!state && (
            <>
              {' '}
              <button type="button" onClick={load} style={{ marginLeft: 8 }}>
                Повторить
              </button>
            </>
          )}
        </p>
      )}

      {!state && !error && <p className="muted">Загрузка…</p>}

      {state && (
        <>
          <div className="filters" style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
            <select
              aria-label="Провайдер видео-генерации по умолчанию"
              value={state.active}
              disabled={saving}
              onChange={(e) => handleChange(e.target.value as VideoProviderKey)}
            >
              {state.options.map((opt) => (
                <option key={opt.key} value={opt.key}>
                  {opt.key === 'grok' ? 'Grok' : 'Veo'}
                </option>
              ))}
            </select>
            {saving && <span className="muted">Сохраняю…</span>}
          </div>
          <p className="muted" style={{ fontSize: 13 }}>
            {state.source === 'admin'
              ? 'Задано вручную на этом экране.'
              : 'Ещё не менялось здесь — используется Grok по умолчанию.'}
          </p>
        </>
      )}
    </div>
  );
}

/**
 * Транспорт Grok для одиночных роликов (доп. запрос владельца продукта,
 * 14.09.2026): как мастер ходит в xAI за одним роликом — синхронно
 * (минуты) или через Batch API (дешевле, но «обычно до 24 часов»).
 * На весь стенд, без привязки к бренду; действует на следующий старт.
 */
function GrokTransportCard() {
  const [state, setState] = useState<GrokTransportSettingsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = () => {
    setError(null);
    getGrokTransportSettings()
      .then(setState)
      .catch((err) => setError(err instanceof ApiRequestError ? err.message : 'Не удалось загрузить настройку транспорта Grok'));
  };

  useEffect(load, []);

  const handleChange = async (transport: GrokTransportKey) => {
    if (!state || transport === state.active) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await setGrokTransport(transport);
      setState(updated);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Не удалось сохранить настройку транспорта Grok');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card" style={{ marginBottom: 24 }}>
      <h2 style={{ fontSize: 16, marginBottom: 4 }}>Транспорт Grok для одиночных роликов</h2>
      <p className="muted" style={{ marginBottom: 16 }}>
        Как мастер отправляет в xAI одиночную генерацию — и один сегмент, и цепочку «база + расширение».
        Синхронные вызовы отвечают за минуты. Batch API дешевле по прайсу xAI, но обрабатывается
        «обычно до 24 часов»; ролик всё это время висит в статусе рендера и появится сам, как только
        пачка готова. Действует на следующий запуск; уже идущий ролик дорисовывается своим транспортом.
        Каталог-партии и перевод блога всегда идут батчем — на них это не влияет.
      </p>

      {error && (
        <p style={{ color: 'var(--signal-critical)', marginBottom: 12 }}>
          {error}
          {/* Аудит 14.09.2026 (М-7.9): ошибка загрузки — не тупик, а «Повторить». */}
          {!state && (
            <>
              {' '}
              <button type="button" onClick={load} style={{ marginLeft: 8 }}>
                Повторить
              </button>
            </>
          )}
        </p>
      )}

      {!state && !error && <p className="muted">Загрузка…</p>}

      {state && (
        <>
          <div className="filters" style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
            <select
              aria-label="Транспорт Grok для одиночных роликов"
              value={state.active}
              disabled={saving}
              onChange={(e) => handleChange(e.target.value as GrokTransportKey)}
            >
              {state.options.map((opt) => (
                <option key={opt.key} value={opt.key}>
                  {opt.key === 'batch' ? 'Batch API (дешевле, до 24 часов)' : 'Синхронные вызовы (минуты)'}
                </option>
              ))}
            </select>
            {saving && <span className="muted">Сохраняю…</span>}
          </div>
          <p className="muted" style={{ fontSize: 13 }}>
            {state.source === 'admin'
              ? 'Задано вручную на этом экране.'
              : 'Ещё не менялось здесь — используются синхронные вызовы.'}
          </p>
        </>
      )}
    </div>
  );
}

/** Форматирует micro-USD (1_000_000 = $1) для короткой строки статуса —
 * та же величина, что уже показывает вкладка «Расходы» (costs/page.tsx),
 * здесь только для «сегодня потрачено X из Y». */
function formatUsd(microUsd: number): string {
  return `$${(microUsd / 1_000_000).toFixed(2)}`;
}

/**
 * «ИИ-консультант» — включение/выключение, проактивный режим, дневной
 * бюджет и модель (ТЗ §9, §13: «запуск сначала с assistant_enabled=off
 * на проде» — рубильник здесь и есть тот самый выключатель). В отличие
 * от карточек выше (один select, одно значение) — три независимых поля,
 * поэтому черновик (`draft`) со своей кнопкой «Сохранить», а не смена
 * применяется на каждый onChange: ползунок бюджета в долларах, случайно
 * задетый на середине ввода, не должен улетать в PATCH на каждую цифру.
 *
 * Модель — свободный текст, не select: список допустимых Gemini-моделей
 * (`GEMINI_MODEL_CHOICES` в backend/src/modules/assistant/dto) выводится
 * из прайса (`common/ai-pricing.ts`) и не отдаётся отдельным эндпоинтом
 * наружу — заводить его специально ради одного select в этой карточке
 * посчитано избыточным; невалидное имя модели бэкенд отклонит `IsIn`,
 * ошибка PATCH покажет это оператору тем же способом, что и остальные
 * ошибки сохранения на этой странице.
 */
function AssistantSettingsCard() {
  const [state, setState] = useState<AssistantAdminSettingsView | null>(null);
  const [draft, setDraft] = useState<{
    enabled: boolean;
    proactiveEnabled: boolean;
    dailyBudgetUsd: string;
    model: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const load = () => {
    setError(null);
    getAssistantSettings()
      .then((s) => {
        setState(s);
        setDraft({
          enabled: s.enabled,
          proactiveEnabled: s.proactiveEnabled,
          dailyBudgetUsd: (s.dailyBudgetMicroUsd / 1_000_000).toString(),
          model: s.model,
        });
      })
      .catch((err) => setError(err instanceof ApiRequestError ? err.message : 'Не удалось загрузить настройки консультанта'));
  };

  useEffect(load, []);

  const dirty =
    !!state &&
    !!draft &&
    (draft.enabled !== state.enabled ||
      draft.proactiveEnabled !== state.proactiveEnabled ||
      draft.model !== state.model ||
      Number(draft.dailyBudgetUsd) !== state.dailyBudgetMicroUsd / 1_000_000);

  const handleSave = async () => {
    if (!draft) return;
    const dailyBudgetUsd = Number(draft.dailyBudgetUsd);
    if (!Number.isFinite(dailyBudgetUsd) || dailyBudgetUsd < 0) {
      setError('Дневной бюджет должен быть неотрицательным числом');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const updated = await setAssistantSettings({
        enabled: draft.enabled,
        proactiveEnabled: draft.proactiveEnabled,
        dailyBudgetUsd,
        model: draft.model.trim() || undefined,
      });
      setState(updated);
      setDraft({
        enabled: updated.enabled,
        proactiveEnabled: updated.proactiveEnabled,
        dailyBudgetUsd: (updated.dailyBudgetMicroUsd / 1_000_000).toString(),
        model: updated.model,
      });
      setSavedAt(Date.now());
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Не удалось сохранить настройки консультанта');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card" style={{ marginBottom: 24 }}>
      <h2 style={{ fontSize: 16, marginBottom: 4 }}>ИИ-консультант на лендинге</h2>
      <p className="muted" style={{ marginBottom: 16 }}>
        Обучающий чат-виджет на главной и на /how-it-works (doc/LANDING-TUTORIAL-AI-CONSULTANT-SPEC.md). Выключен по
        умолчанию — включайте, только когда готовы следить за расходами первые дни. Подробная лента вопросов и
        агрегаты — на вкладке «ИИ-консультант».
      </p>

      {error && (
        <p style={{ color: 'var(--signal-critical)', marginBottom: 12 }}>
          {error}
          {!state && (
            <>
              {' '}
              <button type="button" onClick={load} style={{ marginLeft: 8 }}>
                Повторить
              </button>
            </>
          )}
        </p>
      )}

      {!state && !error && <p className="muted">Загрузка…</p>}

      {state && draft && (
        <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 16 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input
                type="checkbox"
                checked={draft.enabled}
                disabled={saving}
                onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
              />
              Консультант включён
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input
                type="checkbox"
                checked={draft.proactiveEnabled}
                disabled={saving}
                onChange={(e) => setDraft({ ...draft, proactiveEnabled: e.target.checked })}
              />
              Проактивные подсказки (пауза на шаге, задержка на тарифах, уход со страницы…)
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              Дневной бюджет, $
              <input
                type="number"
                min={0}
                max={1000}
                step="0.01"
                value={draft.dailyBudgetUsd}
                disabled={saving}
                style={{ width: 100 }}
                onChange={(e) => setDraft({ ...draft, dailyBudgetUsd: e.target.value })}
              />
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              Модель Gemini
              <input
                type="text"
                value={draft.model}
                disabled={saving}
                style={{ width: 220 }}
                onChange={(e) => setDraft({ ...draft, model: e.target.value })}
              />
            </label>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
            <button type="button" disabled={saving || !dirty} onClick={() => void handleSave()}>
              {saving ? 'Сохраняю…' : 'Сохранить'}
            </button>
            {!dirty && savedAt && <span className="muted">Сохранено.</span>}
          </div>

          <p className="muted" style={{ fontSize: 13 }}>
            Сегодня: {state.today.questions} вопрос(ов), из них {state.today.proactiveQuestions} по проактивным
            подсказкам. Потрачено {formatUsd(state.today.spentMicroUsd)} из {formatUsd(state.today.budgetMicroUsd)} (
            {state.today.percentOfBudget}%). База знаний собрана {new Date(state.knowledgeBuiltAt).toLocaleString('ru-RU')}
            {state.knowledgeCommit ? ` (commit ${state.knowledgeCommit.slice(0, 7)})` : ''}.
          </p>
        </>
      )}
    </div>
  );
}

/**
 * Кнопка «Завести фикстурного пользователя» (этап 105) — карточка среди
 * остальных карточек-настроек в шапке страницы (не внутри
 * `visibleGroups.map`, см. довод у места её рендера ниже): до этого
 * этапа единственный способ создать пользователя с telegramId =
 * FIXTURE_TELEGRAM_ID и весь набор данных для него (манифест бренда,
 * персонаж, проект, товар, сессия с готовым роликом) был ручной
 * CLI-запуск `npm run seed:fixture-user` с прод DATABASE_URL —
 * недоступно оператору без доступа к серверу/CI. Делегирует в `POST
 * /admin/tutorial-runner/seed-fixture-user`
 * (`FixtureSeedAdminController`) — та же идемпотентная логика
 * (`seedFixtureUser()`, `fixture-seed.ts`), что и у CLI-скрипта, так что
 * повторное нажатие безопасно: обновляет те же записи, не плодит
 * дубликаты.
 */
function FixtureSeedCard() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<FixtureSeedResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await seedFixtureUser();
      setResult(r);
    } catch (err) {
      setError(
        err instanceof ApiRequestError ? err.message : 'Не удалось завести фикстурного пользователя',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card" style={{ marginTop: 4, marginBottom: 20 }}>
      <h3 style={{ fontSize: 14, marginTop: 0, marginBottom: 4 }}>Фикстурный пользователь</h3>
      <p className="muted" style={{ fontSize: 13, marginBottom: 12 }}>
        Заводит/обновляет пользователя с telegramId = FIXTURE_TELEGRAM_ID (см. таблицу выше) и весь
        набор данных, который ждут шаги сценариев (манифест бренда, персонаж, проект, товар, сессия с
        готовым роликом). Без этого регресс-раннер обучалки скипается с «фикстурный пользователь не
        заведён», даже если все три переменные выше заданы правильно. Безопасно нажимать повторно —
        обновляет те же записи, не создаёт дубликаты.
      </p>
      <button type="button" disabled={busy} onClick={() => void run()}>
        {busy ? 'Завожу…' : 'Завести фикстурного пользователя'}
      </button>
      {error && (
        <p className="critical" style={{ marginTop: 12 }}>
          {error}
        </p>
      )}
      {result && (
        <div style={{ marginTop: 12 }}>
          <p style={{ marginBottom: 6 }}>
            <span className="badge-status badge-status-ok">Готово</span> userId {result.userId}
          </p>
          <ul className="muted" style={{ fontSize: 12, margin: 0, paddingLeft: 18 }}>
            {result.log.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * Флаг Hedra для видео-фрагментов виртуальной студии
 * (docs-tz/TZ-Virtualnaya-Studiya-i-AI-Vedushaya.md §3.5) — выключен по
 * умолчанию: юридический периметр (нет инфраструктуры маркировки
 * ИИ-контента/согласия, doc/AI-ACTORS-NO-REFERENCE-SPEC.md §0)
 * применяется к Hedra-ветке студии так же, как и к пилоту аватара.
 * Пока выключено — в форме видео-фрагмента на /virtual-studio виден
 * только Grok, пункт Hedra скрыт.
 */
function VirtualStudioHedraCard() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = () => {
    setError(null);
    getVirtualStudioHedraEnabled()
      .then((r) => setEnabled(r.enabled))
      .catch((err) => setError(err instanceof ApiRequestError ? err.message : 'Не удалось загрузить настройку'));
  };

  useEffect(load, []);

  const handleToggle = async () => {
    if (enabled === null) return;
    setSaving(true);
    setError(null);
    try {
      const result = await setVirtualStudioHedraEnabled(!enabled);
      setEnabled(result.enabled);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Не удалось сохранить настройку');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card" style={{ marginBottom: 24 }}>
      <h2 style={{ fontSize: 16, marginBottom: 4 }}>Виртуальная студия: Hedra для видео-фрагментов</h2>
      <p className="muted" style={{ marginBottom: 16 }}>
        Пока выключено, в форме видео-фрагмента (/virtual-studio) виден только Grok Imagine. Hedra даёт говорящую
        голову с честным лип-синком, но юридический периметр (нет маркировки ИИ-контента/согласия) требует явного
        включения оператором.
      </p>
      {error && <p style={{ color: 'var(--signal-critical)', marginBottom: 12 }}>{error}</p>}
      {enabled === null && !error && <p className="muted">Загрузка…</p>}
      {enabled !== null && (
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input type="checkbox" checked={enabled} disabled={saving} onChange={() => void handleToggle()} />
          Включить Hedra для видео-фрагментов студии
          {saving && <span className="muted">Сохраняю…</span>}
        </label>
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

  const load = () => {
    setError(null);
    getEnvSettings()
      .then(setResult)
      .catch((err) => setError(err instanceof ApiRequestError ? err.message : 'Не удалось загрузить настройки'));
  };

  useEffect(load, []);

  if (error) {
    return (
      <div className="page">
        <p style={{ color: 'var(--signal-critical)' }}>{error}</p>
        {/* Аудит 14.09.2026 (М-7.9): «Повторить» вместо тупика с перезагрузкой страницы. */}
        <button type="button" onClick={load}>
          Повторить
        </button>
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
      <AnalysisProviderCard />
      <VideoProviderCard />
      <GrokTransportCard />
      <VirtualStudioHedraCard />
      <AssistantSettingsCard />
      {/* Не внутри цикла групп ниже намеренно: при фильтре «только
          требуется внимание» группа «Обучалка» пропадает из списка, если
          все три переменные уже настроены — а кнопка сидирования нужна
          именно тогда, когда переменные уже в порядке (этап 105). */}
      <FixtureSeedCard />

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
