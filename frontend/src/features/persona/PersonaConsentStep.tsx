/**
 * Согласие (ТЗ Greeting 2.0 §4.1 п.1, §4.3): что сервис делает с лицом и
 * голосом, где хранит и как удалить. Текст — серверный и версионный
 * (`GET /personas/consent-text`): юридическая формулировка меняется без
 * релиза фронтенда, а версия уходит обратно в `POST /personas` — видно,
 * какой именно текст человек принял.
 *
 * Галочка — ДО камеры (§4.1): камера на следующем шаге не включается,
 * пока согласия нет, и запрос разрешения камеры не всплывает раньше.
 */

import { useEffect, useState } from 'react';
import { Alert, Button, Card, CardHeader, Spinner } from '../../components/ui';
import { useI18n } from '../../lib/i18n-context';
import { errorMessage } from '../../services/projects-api';
import { getConsentText, type ConsentText } from '../../services/persona-api';

export function PersonaConsentStep({
  onAccepted,
}: {
  onAccepted: (consent: ConsentText) => void;
}) {
  const { dict, locale } = useI18n();
  const t = dict.persona;
  const [consent, setConsent] = useState<ConsentText | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    setConsent(null);
    setError(null);
    // Смена языка интерфейса перечитывает текст: согласие принимают на
    // том языке, который человек читает, и версия — от него же.
    setChecked(false);
    getConsentText(locale)
      .then((c) => alive && setConsent(c))
      .catch((e) => alive && setError(errorMessage(e, undefined, dict.errors)));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locale, attempt]);

  return (
    <Card className="p-4 sm:p-5">
      <CardHeader title={t.consentTitle} hint={t.consentLead} />
      {!consent && !error && (
        <div className="flex items-center gap-2 text-sm text-silver-400">
          <Spinner size={16} />
          {t.consentLoading}
        </div>
      )}
      {error && (
        <Alert tone="error">
          {t.consentLoadFailed.replace('{{error}}', error)}
          <div className="mt-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => setAttempt((n) => n + 1)}
            >
              {t.retry}
            </Button>
          </div>
        </Alert>
      )}
      {consent && (
        <div className="space-y-4">
          <div
            className="max-h-72 overflow-y-auto whitespace-pre-line rounded-xl border border-silver-200/70 p-3 text-sm leading-relaxed dark:border-silver-800"
            tabIndex={0}
            aria-label={t.consentTitle}
          >
            {consent.text}
          </div>
          {consent.version && (
            <p className="text-[11px] text-silver-400">
              {t.consentVersion.replace('{{version}}', consent.version)}
            </p>
          )}
          <p className="text-xs text-silver-400">{t.likenessNote}</p>
          <p className="text-xs text-silver-400">{t.thirdPartyNote}</p>
          <label className="flex cursor-pointer gap-2 text-sm leading-relaxed">
            <input
              type="checkbox"
              checked={checked}
              onChange={(e) => setChecked(e.target.checked)}
              className="mt-1 h-4 w-4 shrink-0 accent-sky-400"
            />
            <span>{t.consentCheckbox}</span>
          </label>
          <div>
            <Button
              disabled={!checked || !consent.version}
              onClick={() => onAccepted(consent)}
            >
              {t.consentContinue}
            </Button>
            {!checked && (
              <p className="mt-1 text-xs text-silver-400">{t.consentHint}</p>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}
