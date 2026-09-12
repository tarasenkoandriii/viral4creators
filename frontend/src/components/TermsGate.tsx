/**
 * TermsGate — согласие с офертой и условиями использования перед первым
 * разбором (spec §20, этап 24).
 *
 * Почему именно перед разбором, а не при входе: разбор — это момент, когда
 * сервис создаёт объект, права на который по условиям принадлежат ему
 * (§4 условий использования, «Разборы принадлежат Сервису»), и добавляет
 * результат в библиотеку. Просить согласие ровно там, где оно наступает,
 * честнее, чем модальным окном на старте.
 *
 * Два хранилища по необходимости: у вошедшего пользователя согласие
 * пишется в его строку (`POST /me/terms/accept`), у анонимного браузера —
 * в localStorage, потому что записывать некуда, а заводить ради галочки
 * пользователя было бы хуже для него самого.
 */

import { useEffect, useState } from 'react';
import { ScrollText } from 'lucide-react';
import { Alert, Button, Card, CardHeader } from './ui';
import {
  acceptTerms,
  getTermsStatus,
  isUnauthorized,
} from '../services/projects-api';
import { LEGAL_VERSION } from '../lib/legal-content';
import { routes } from '../lib/router';
import { useI18n } from '../lib/i18n-context';

const LS_KEY = 'termsAcceptedVersion';

function localAccepted(): boolean {
  try {
    return localStorage.getItem(LS_KEY) === LEGAL_VERSION;
  } catch {
    return false;
  }
}

function rememberLocally(): void {
  try {
    localStorage.setItem(LS_KEY, LEGAL_VERSION);
  } catch {
    /* приватный режим — просто спросим ещё раз */
  }
}

export function TermsGate({ onAccepted }: { onAccepted: () => void }) {
  const { dict } = useI18n();
  const [checked, setChecked] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let alive = true;
    getTermsStatus()
      .then((s) => {
        if (!alive) return;
        if (s.accepted) onAccepted();
        else setReady(true);
      })
      .catch((e) => {
        if (!alive) return;
        // Анонимный путь: сервер не знает, кто мы — смотрим в браузер.
        if (isUnauthorized(e) && localAccepted()) onAccepted();
        else setReady(true);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = async () => {
    setSaving(true);
    setError(null);
    rememberLocally();
    try {
      await acceptTerms(LEGAL_VERSION);
    } catch (e) {
      // Для анонимного пользователя 401 здесь — норма: согласие уже
      // записано в браузер, идём дальше.
      if (!isUnauthorized(e)) {
        setError(e instanceof Error ? e.message : dict.termsGate.saveFailed);
        setSaving(false);
        return;
      }
    }
    setSaving(false);
    onAccepted();
  };

  if (!ready) return null;

  return (
    <Card className="p-5 animate-fadeIn">
      <CardHeader
        icon={<ScrollText size={18} className="text-accent" />}
        title={dict.termsGate.title}
        hint={dict.termsGate.hint}
      />

      {error && (
        <Alert tone="error" className="mb-3" onDismiss={() => setError(null)}>
          {error}
        </Alert>
      )}

      <label className="flex cursor-pointer gap-3 rounded-xl border border-silver-200/70 p-3 text-xs leading-relaxed dark:border-silver-800">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => setChecked(e.target.checked)}
          className="mt-0.5 h-4 w-4 shrink-0 accent-sky-400"
        />
        <span>
          {dict.termsGate.acceptPrefix}{' '}
          <a
            href={`#${routes.legal('offer')}`}
            className="text-accent underline"
          >
            {dict.termsGate.offerLink}
          </a>{' '}
          {dict.termsGate.and}{' '}
          <a
            href={`#${routes.legal('terms-of-use')}`}
            className="text-accent underline"
          >
            {dict.termsGate.termsLink}
          </a>
          {dict.termsGate.acceptSuffix}
        </span>
      </label>

      <Button
        block
        className="mt-4"
        disabled={!checked}
        loading={saving}
        onClick={() => void submit()}
      >
        {dict.termsGate.submit}
      </Button>

      {/* Доп. запрос владельца продукта: та же реферальная ссылка Claude,
          что в подвале (`App.tsx`) — на самом первом экране тоже. Тот же
          env (`VITE_CLAUDE_REFERRAL_URL`), тот же текст словаря
          (`footer.madeWithClaude`) — вторая копия того же перевода была
          бы лишней. */}
      <div className="mt-3 text-center text-[11px] text-silver-400">
        <a
          href={
            import.meta.env.VITE_CLAUDE_REFERRAL_URL ||
            'https://claude.ai/referral/P7cQCOjbvg?s=android'
          }
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex min-h-[44px] items-center px-1 underline hover:text-accent"
        >
          {dict.footer.madeWithClaude}
        </a>
      </div>
    </Card>
  );
}
