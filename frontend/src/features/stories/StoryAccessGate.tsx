import { useId, useRef, useState } from 'react';
import { BookOpen } from 'lucide-react';
import { Alert, Button, Card } from '../../components/ui';
import { api } from '../../services/api';
import { useI18n } from '../../lib/i18n-context';
import { routes } from '../../lib/router';
import { storyErrorText } from './story-errors';
import {
  STORY_RULES_SLUG,
  STORY_SCENARIO_MAX,
  fill,
  formatStoryDate,
  plural,
  storyAccessView,
  storyApplyBody,
  storyCode,
  storyScenario,
  storyTermsBody,
  type StoryAccess,
} from './story-pilot';

/** Тёмный sky на светлом фоне (≥ 4.5:1), светлый — на тёмном. */
const linkClass =
  'text-sky-800 underline underline-offset-2 hover:text-sky-900 dark:text-sky-300 dark:hover:text-sky-200';
const inputClass =
  'mt-1 block w-full max-w-full rounded-lg border border-silver-300 bg-white p-3 text-sm text-silver-900 dark:border-silver-700 dark:bg-silver-900 dark:text-silver-100';

/**
 * Вход в Story‑Tales для того, кому мастер ещё не открыт (бриф ST3, п. 1):
 * заявка в пилот, её статус и принятие правил 18+. Решение о доступе —
 * за сервером; после действия экран просто перечитывает доступ.
 */
export function StoryAccessGate({
  access,
  onChanged,
}: {
  access: StoryAccess;
  onChanged: () => void;
}) {
  const { dict, locale } = useI18n();
  const t = dict.storyTales;
  const view = storyAccessView(access);
  const [scenario, setScenario] = useState('');
  const [adult, setAdult] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const lock = useRef(false);
  const ids = useId();
  const check = storyScenario(scenario, t);
  const date = formatStoryDate(access.application?.createdAt, locale);

  async function act(fn: () => Promise<unknown>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      await fn();
      onChanged();
    } catch (e) {
      const code = storyCode(e);
      setError(
        code === 'STORY_PILOT_FULL'
          ? t.access.pilotFull
          : storyErrorText(e, {
              fallback: t.access.actionError,
              noResponse: t.access.actionNoResponse,
              locale,
              ui: dict.storyUi,
            })
      );
      // Мест нет / правила сменились / доступ отозван — перечитать доступ
      // (ST3-U-12: новая версия правил приходит вместе с ним).
      if (
        code === 'STORY_PILOT_FULL' ||
        code === 'STORY_TERMS_OUTDATED' ||
        code === 'STORY_PILOT_REVOKED'
      )
        onChanged();
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  const header = (title: string) => (
    <div className="flex items-start gap-3">
      <BookOpen className="mt-1 shrink-0 text-sky-800 dark:text-sky-300" />
      <h1 className="min-w-0 break-words text-xl font-semibold sm:text-2xl">
        {title}
      </h1>
    </div>
  );
  const errorBox = error ? (
    <div role="alert">
      <Alert tone="error">{error}</Alert>
    </div>
  ) : null;
  const statusButton = (
    <Button variant="outline" disabled={busy} onClick={onChanged}>
      {t.access.checkStatus}
    </Button>
  );

  if (view === 'terms') {
    const body = storyTermsBody(access.termsVersion, adult, agreed);
    return (
      <Card className="mx-auto max-w-2xl space-y-4 p-4 sm:p-5">
        {header(t.access.termsTitle)}
        <p className="break-words">{t.access.termsIntro}</p>
        <p>
          <a className={linkClass} href={`#${routes.legal(STORY_RULES_SLUG)}`}>
            {t.access.termsRulesLink}
          </a>
          {access.termsVersion && (
            <span className="block text-xs text-silver-600 dark:text-silver-300">
              {fill(t.access.termsVersion, { version: access.termsVersion })}
            </span>
          )}
        </p>
        <label className="flex min-h-[44px] items-start gap-3">
          <input
            type="checkbox"
            className="mt-1 h-5 w-5 shrink-0"
            checked={adult}
            onChange={(e) => setAdult(e.target.checked)}
          />
          <span className="min-w-0 break-words">{t.access.termsAdult}</span>
        </label>
        <label className="flex min-h-[44px] items-start gap-3">
          <input
            type="checkbox"
            className="mt-1 h-5 w-5 shrink-0"
            checked={agreed}
            onChange={(e) => setAgreed(e.target.checked)}
          />
          <span className="min-w-0 break-words">{t.access.termsAgree}</span>
        </label>
        {errorBox}
        <Button
          disabled={busy || !body}
          loading={busy}
          onClick={() =>
            void act(() => api.post('/story-gifts/terms/accept', body))
          }
        >
          {t.access.termsButton}
        </Button>
      </Card>
    );
  }

  if (view === 'pending' || view === 'rejected') {
    const pending = view === 'pending';
    return (
      <Card className="mx-auto max-w-2xl space-y-4 p-4 sm:p-5">
        {header(t.access.pilotTitle)}
        <div role="status">
          <Alert
            tone={pending ? 'info' : 'warning'}
            title={pending ? t.access.pendingTitle : t.access.rejectedTitle}
          >
            {fill(pending ? t.access.pendingBody : t.access.rejectedBody, {
              date: date || '—',
            })}
          </Alert>
        </div>
        {errorBox}
        {statusButton}
      </Card>
    );
  }

  // apply | full
  const full = view === 'full';
  const scenarioId = `${ids}-scenario`;
  const hintId = `${ids}-hint`;
  const countId = `${ids}-count`;
  return (
    <Card className="mx-auto max-w-2xl space-y-4 p-4 sm:p-5">
      {header(t.access.pilotTitle)}
      <p className="break-words">{t.access.pilotIntro}</p>
      {(typeof access.maxMembers === 'number' ||
        typeof access.seatsLeft === 'number') && (
        <p className="text-sm">
          {typeof access.maxMembers === 'number' &&
            fill(t.access.pilotLimit, { max: access.maxMembers })}{' '}
          {typeof access.seatsLeft === 'number' &&
            access.seatsLeft > 0 &&
            plural(t.access.seatsLeft, access.seatsLeft, locale)}
        </p>
      )}
      {full ? (
        <Alert tone="warning">{t.access.noSeats}</Alert>
      ) : (
        <div className="space-y-1">
          <label htmlFor={scenarioId} className="block font-medium">
            {t.access.scenarioLabel}
          </label>
          <p
            id={hintId}
            className="text-sm text-silver-700 dark:text-silver-300"
          >
            {t.access.scenarioHint}
          </p>
          <textarea
            id={scenarioId}
            className={inputClass}
            rows={4}
            maxLength={STORY_SCENARIO_MAX + 50}
            placeholder={t.access.scenarioPlaceholder}
            value={scenario}
            aria-describedby={`${hintId} ${countId}`}
            aria-invalid={!!check.error}
            onChange={(e) => setScenario(e.target.value)}
          />
          <p
            id={countId}
            className={`text-right text-xs ${check.error ? 'text-rose-800 dark:text-rose-300' : 'text-silver-600 dark:text-silver-300'}`}
          >
            {check.error ??
              fill(t.access.scenarioCount, {
                n: check.length,
                max: STORY_SCENARIO_MAX,
              })}
          </p>
        </div>
      )}
      {errorBox}
      <div className="flex flex-wrap gap-2">
        {!full && (
          <Button
            disabled={busy || !!check.error}
            loading={busy}
            onClick={() =>
              void act(() =>
                api.post('/story-gifts/pilot/apply', storyApplyBody(scenario))
              )
            }
          >
            {t.access.applyButton}
          </Button>
        )}
        {full && statusButton}
      </div>
    </Card>
  );
}
