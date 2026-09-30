/**
 * «Создать себя» / «Я в кадре» (ТЗ Greeting 2.0 §4.1–§4.6, §4.9) — один
 * экран на весь путь: согласие → камера → проверка → базовый образ →
 * образы, голос, удаление. Шаг выводится из того, что уже есть у
 * персоны на сервере (`personaStage`), а не из адреса: перезагрузка
 * вкладки посреди пути возвращает туда же, где человек был.
 *
 * Режим за флагом `PERSONA_ENABLED`: выключен — сервер отвечает 404
 * `PERSONA_DISABLED`, и экран говорит «недоступно» (сюда можно попасть
 * только прямой ссылкой — вход прячется).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { UserRound } from 'lucide-react';
import {
  Alert,
  Busy,
  Button,
  Card,
  CardHeader,
  EmptyState,
} from '../../components/ui';
import { useI18n } from '../../lib/i18n-context';
import { navigate, routes } from '../../lib/router';
import { revokeObjectUrl } from '../../lib/object-url';
import { errorMessage } from '../../services/projects-api';
import {
  createPersona,
  personaErrorCode,
  putPersonaFile,
  regenerateBaseLook,
  verifyPersona,
  type ConsentText,
  type VerifyResult,
} from '../../services/persona-api';
import {
  lookState,
  personaDeleteOnly,
  personaStage,
  type PublishedShare,
} from '../../lib/persona-flow';
import { usePersonaMe } from './usePersonaMe';
import { PersonaConsentStep } from './PersonaConsentStep';
import { PersonaCaptureStep, type PersonaCapture } from './PersonaCaptureStep';
import { PersonaVerifyResult } from './PersonaVerifyResult';
import { PersonaBaseStep } from './PersonaBaseStep';
import { PersonaLooks } from './PersonaLooks';
import { PersonaVoice } from './PersonaVoice';
import { PersonaDelete, PersonaSharesPanel } from './PersonaDelete';

type Flow =
  | { kind: 'idle' }
  | { kind: 'consent' }
  | { kind: 'capture' }
  | { kind: 'submitting'; phase: 'uploading' | 'verifying' }
  | { kind: 'result'; result: VerifyResult };

const ACCEPTED_KEY = 'persona-base-accepted:';

function readAccepted(personaId: string): boolean {
  try {
    return window.localStorage.getItem(ACCEPTED_KEY + personaId) === '1';
  } catch {
    return false;
  }
}
/** «Удалить всё» забывает и принятие: новая персона — новый базовый образ. */
function clearAccepted(personaId: string): void {
  try {
    window.localStorage.removeItem(ACCEPTED_KEY + personaId);
  } catch {
    // Хранилище недоступно — и помнить было нечего.
  }
}
function writeAccepted(personaId: string): void {
  try {
    window.localStorage.setItem(ACCEPTED_KEY + personaId, '1');
  } catch {
    // Приватный режим — принятие просто не переживёт перезагрузку.
  }
}

/** Пока образ готовится — перечитываем персону, не чаще раза в 4 с. */
const POLL_MS = 4000;

export function PersonaScreen() {
  const { dict, locale } = useI18n();
  const t = dict.persona;
  const { load, reload } = usePersonaMe();
  const [flow, setFlow] = useState<Flow>({ kind: 'idle' });
  const [consent, setConsent] = useState<ConsentText | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selfieUrl, setSelfieUrl] = useState<string | null>(null);
  const [shares, setShares] = useState<PublishedShare[] | null>(null);
  const [deleted, setDeleted] = useState(false);
  const [accepted, setAccepted] = useState(false);

  useEffect(() => () => revokeObjectUrl(selfieUrl), [selfieUrl]);

  const me = load.kind === 'ready' ? load.me : null;
  const stage = personaStage(me);
  const personaId = me?.persona?.id ?? null;

  useEffect(() => {
    setAccepted(personaId ? readAccepted(personaId) : false);
  }, [personaId]);

  const anyPending = useMemo(
    () => !!me?.looks.some((l) => lookState(l) === 'pending'),
    [me]
  );
  useEffect(() => {
    if (!anyPending || flow.kind === 'submitting') return;
    const timer = window.setTimeout(() => void reload(), POLL_MS);
    return () => window.clearTimeout(timer);
  }, [anyPending, me, flow.kind, reload]);

  const refresh = useCallback(() => void reload(), [reload]);

  const submitCapture = async (capture: PersonaCapture) => {
    if (!consent) {
      setFlow({ kind: 'consent' });
      return;
    }
    setError(null);
    setFlow({ kind: 'submitting', phase: 'uploading' });
    revokeObjectUrl(selfieUrl);
    setSelfieUrl(URL.createObjectURL(capture.photo));
    try {
      const uploads = await createPersona({
        consentTextVersion: consent.version,
        locale,
        selfieMimeType: capture.photoType,
        livenessMimeType: capture.videoType,
      });
      await putPersonaFile(
        uploads.selfieUploadUrl,
        capture.photo,
        capture.photoType
      );
      await putPersonaFile(
        uploads.livenessUploadUrl,
        capture.video,
        capture.videoType
      );
      setFlow({ kind: 'submitting', phase: 'verifying' });
      const result = await verifyPersona();
      setFlow({ kind: 'result', result });
    } catch (e) {
      const code = personaErrorCode(e);
      setError(
        code === 'PERSONA_EXISTS'
          ? t.alreadyExists
          : errorMessage(e, undefined, dict.errors)
      );
      if (code === 'PERSONA_UNDER_18') {
        // Надгробие отказа по возрасту (CONTRACT5): новая попытка
        // запрещена — после перечитывания экран сам станет «закрыт».
        setError(null);
        setFlow({ kind: 'idle' });
      } else if (code === 'PERSONA_CONSENT_OUTDATED') {
        // Текст согласия сменил редакцию, пока человек снимал: принять
        // нужно новый — снимки при этом придётся сделать заново.
        setConsent(null);
        setFlow({ kind: 'consent' });
      } else {
        setFlow({ kind: 'idle' });
      }
    } finally {
      void reload();
    }
  };

  /**
   * Снять заново. Удалять ничего не нужно: `POST /personas` у
   * непроверенной персоны переиспользует ту же строку, пишет свежее
   * согласие и сам убирает прежние файлы (persona.service.ts `create`).
   */
  const retake = (haveConsent = !!consent) => {
    setError(null);
    setFlow({ kind: haveConsent ? 'capture' : 'consent' });
  };

  const verifyAgain = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await verifyPersona();
      setFlow({ kind: 'result', result });
      await reload();
    } catch (e) {
      setError(errorMessage(e, undefined, dict.errors));
    } finally {
      setBusy(false);
    }
  };

  const regenerate = async (baseId: string) => {
    setBusy(true);
    setError(null);
    try {
      await regenerateBaseLook(baseId);
    } catch (e) {
      setError(errorMessage(e, undefined, dict.errors));
    } finally {
      setBusy(false);
      void reload();
    }
  };

  const accept = () => {
    if (personaId) writeAccepted(personaId);
    setAccepted(true);
  };

  // ── Шапка и общие состояния ──────────────────────────────────────────

  const header = (
    <div className="mb-4">
      <h1 className="flex items-center gap-2 text-xl font-bold tracking-tight">
        <UserRound size={20} className="text-accent" aria-hidden />
        {t.title}
      </h1>
      <p className="mt-1 text-sm text-silver-400">{t.subtitle}</p>
    </div>
  );

  if (load.kind === 'loading') return <Busy title={t.loading} />;
  if (load.kind === 'disabled') {
    return (
      <EmptyState
        title={t.disabledTitle}
        hint={t.disabledHint}
        action={
          <Button
            variant="outline"
            onClick={() => navigate(routes.projects(), true)}
          >
            {dict.notFound.action}
          </Button>
        }
      />
    );
  }
  if (load.kind === 'guest') {
    return (
      <>
        {header}
        <Alert tone="info">{t.loginRequired}</Alert>
      </>
    );
  }
  if (load.kind === 'error') {
    return (
      <>
        {header}
        <Alert tone="error">
          {t.loadFailed.replace('{{error}}', load.message)}
          <div className="mt-2">
            <Button size="sm" variant="outline" onClick={refresh}>
              {t.retry}
            </Button>
          </div>
        </Alert>
      </>
    );
  }

  const errorBox = error && (
    <Alert tone="error" className="mb-4" onDismiss={() => setError(null)}>
      {error}
    </Alert>
  );

  // Экран после «Удалить всё»: сначала — страницы, которые ещё открыты.
  if (shares && shares.length > 0) {
    return (
      <>
        {header}
        <Alert tone="success" className="mb-4">
          {t.deleted}
        </Alert>
        <PersonaSharesPanel shares={shares} onDone={() => setShares(null)} />
      </>
    );
  }

  // ── Путь до проверки ────────────────────────────────────────────────

  if (flow.kind === 'submitting') {
    return (
      <>
        {header}
        <Busy
          title={flow.phase === 'uploading' ? t.uploading : t.verifying}
          hint={t.verifyHint}
        />
      </>
    );
  }

  if (flow.kind === 'result') {
    return (
      <>
        {header}
        {errorBox}
        <PersonaVerifyResult
          result={flow.result}
          busy={busy}
          onRetake={() => retake()}
          onVerifyAgain={() => void verifyAgain()}
          onContinue={() => setFlow({ kind: 'idle' })}
        />
      </>
    );
  }

  if (stage === 'intro') {
    return (
      <>
        {header}
        {deleted && (
          <Alert
            tone="success"
            className="mb-4"
            onDismiss={() => setDeleted(false)}
          >
            {t.deleted}
          </Alert>
        )}
        {errorBox}
        {flow.kind === 'consent' ? (
          <PersonaConsentStep
            onAccepted={(c) => {
              setConsent(c);
              setFlow({ kind: 'capture' });
            }}
          />
        ) : flow.kind === 'capture' && consent ? (
          <PersonaCaptureStep
            busy={false}
            onCaptured={(c) => void submitCapture(c)}
            onCancel={() => setFlow({ kind: 'idle' })}
          />
        ) : (
          <Card className="p-4 sm:p-5">
            <CardHeader title={t.entryTitle} hint={t.introLead} />
            <ul className="list-disc space-y-1 pl-5 text-sm" role="list">
              <li>{t.introStep1}</li>
              <li>{t.introStep2}</li>
              <li>{t.introStep3}</li>
              <li>{t.introStep4}</li>
            </ul>
            <p className="mt-3 text-xs text-silver-400">{t.likenessNote}</p>
            <div className="mt-4">
              <Button onClick={() => setFlow({ kind: 'consent' })}>
                {t.start}
              </Button>
            </div>
          </Card>
        )}
      </>
    );
  }

  const persona = me!.persona!;

  // Флаг выключен, а персона есть: право на удаление не зависит от
  // флага (§4.9, CONTRACT5) — ни создания, ни образов, только «Удалить всё».
  if (personaDeleteOnly(me) && stage !== 'closed') {
    return (
      <>
        {header}
        {errorBox}
        <div className="space-y-4">
          <Alert tone="info">{t.deleteOnlyNote}</Alert>
          <PersonaDelete
            onDeleted={(list) => {
              clearAccepted(persona.id);
              setAccepted(false);
              setDeleted(true);
              setShares(list);
              void reload();
            }}
          />
        </div>
      </>
    );
  }

  if (stage === 'closed') {
    return (
      <>
        {header}
        {errorBox}
        <PersonaVerifyResult
          result={{
            status: 'refused',
            reasons: persona.refusals ?? ['under-18'],
            ageMin: persona.ageMin,
            ageMax: persona.ageMax,
          }}
          busy={busy}
          onRetake={() => retake()}
          onVerifyAgain={() => void verifyAgain()}
          onContinue={() => undefined}
        />
      </>
    );
  }

  if (stage === 'unverified') {
    return (
      <>
        {header}
        {errorBox}
        {flow.kind === 'consent' ? (
          <PersonaConsentStep
            onAccepted={(c) => {
              setConsent(c);
              retake(true);
            }}
          />
        ) : flow.kind === 'capture' ? (
          <PersonaCaptureStep
            busy={false}
            onCaptured={(c) => void submitCapture(c)}
            onCancel={() => setFlow({ kind: 'idle' })}
          />
        ) : persona.refusals && persona.refusals.length > 0 ? (
          <PersonaVerifyResult
            result={{
              status: 'refused',
              reasons: persona.refusals,
              ageMin: persona.ageMin,
              ageMax: persona.ageMax,
            }}
            busy={busy}
            onRetake={() => retake()}
            onVerifyAgain={() => void verifyAgain()}
            onContinue={() => undefined}
          />
        ) : (
          <Card className="p-4 sm:p-5">
            <CardHeader title={t.unverifiedTitle} hint={t.unverifiedLead} />
            <div className="flex flex-wrap gap-2">
              <Button loading={busy} onClick={() => void verifyAgain()}>
                {t.verifyAgain}
              </Button>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => retake()}
              >
                {t.startOver}
              </Button>
            </div>
          </Card>
        )}
        {flow.kind === 'idle' && (
          <div className="mt-4">
            <PersonaDelete
              onDeleted={(list) => {
                clearAccepted(persona.id);
                setDeleted(true);
                setShares(list);
                void reload();
              }}
            />
          </div>
        )}
      </>
    );
  }

  // ── Проверка пройдена ──────────────────────────────────────────────

  const base =
    me!.looks.find((l) => l.isBase && lookState(l) !== 'deleted') ?? null;
  const showBase = stage === 'base' || !accepted;

  return (
    <>
      {header}
      {errorBox}
      <div className="space-y-4">
        {persona.sourcesPurgedAt && (
          <Alert tone="info">{t.sourcesPurged}</Alert>
        )}
        {showBase ? (
          <PersonaBaseStep
            base={base}
            localSelfieUrl={selfieUrl}
            // Перегенерировать можно, пока селфи ещё хранится (В-3):
            // после удаления источника базовый образ — сам источник.
            canRegenerate={!persona.sourcesPurgedAt && !!base}
            busy={busy}
            error={null}
            onAccept={accept}
            onRegenerate={() => base && void regenerate(base.id)}
          />
        ) : (
          <>
            <PersonaLooks me={me!} onChanged={refresh} />
            <PersonaVoice me={me!} onChanged={refresh} />
          </>
        )}
        <PersonaDelete
          onDeleted={(list) => {
            clearAccepted(persona.id);
            setAccepted(false);
            setDeleted(true);
            setShares(list);
            setFlow({ kind: 'idle' });
            setSelfieUrl(null);
            void reload();
          }}
        />
        <p className="text-xs text-silver-400">{t.retentionNote}</p>
      </div>
    </>
  );
}
