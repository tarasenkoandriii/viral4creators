/**
 * Итог автопроверки (ТЗ Greeting 2.0 §4.1 п.3, §4.3, §4.4).
 *
 * Причины отказа — человеческими словами, а не кодами сервера
 * (`refusalLines` в lib/persona-flow.ts). Отказ по возрасту — отдельный
 * исход: «переснять» тут не поможет, дорога одна — апелляция через
 * поддержку (В-4, временно по рекомендации ТЗ).
 *
 * Ни «личность подтверждена», ни «вы прошли верификацию» (Т-16): это
 * заслон от чужого фото, а не проверка личности, и текст говорит ровно
 * это.
 */

import { Alert, Button, Card, CardHeader } from '../../components/ui';
import { useI18n } from '../../lib/i18n-context';
import { openTelegramLink } from '../../lib/telegram';
import {
  ageRangeLine,
  isUnderageRefusal,
  refusalLines,
  verifyRetryable,
  type RefusalReason,
} from '../../lib/persona-flow';
import type { VerifyResult } from '../../services/persona-api';

const SUPPORT_BOT = import.meta.env.VITE_TELEGRAM_BOT_USERNAME as
  | string
  | undefined;

export function PersonaVerifyResult({
  result,
  onRetake,
  onVerifyAgain,
  onContinue,
  busy,
}: {
  result: VerifyResult;
  onRetake: () => void;
  /** Проверка не состоялась (`check-unavailable`) — снимки целы, проверить ещё раз. */
  onVerifyAgain: () => void;
  onContinue: () => void;
  busy?: boolean;
}) {
  const { dict } = useI18n();
  const t = dict.persona;
  const age = ageRangeLine(t.ageRange, result.ageMin, result.ageMax);

  if (isUnderageRefusal(result)) {
    return (
      <Card className="p-4 sm:p-5">
        <CardHeader title={t.underageTitle} />
        <div className="space-y-3 text-sm leading-relaxed">
          {age && <p>{age}</p>}
          <p>{t.underageBody}</p>
          {SUPPORT_BOT && (
            <Button
              variant="outline"
              onClick={() => openTelegramLink(`https://t.me/${SUPPORT_BOT}`)}
            >
              {t.contactSupport}
            </Button>
          )}
          {/* Ни «Начать», ни «Переснять»: отказ по возрасту — надгробие
              (CONTRACT5), снимки сервер уже удалил, повторная попытка
              ответит 403. Дорога одна — апелляция через поддержку. */}
        </div>
      </Card>
    );
  }

  if (result.status === 'refused') {
    const reasons = t.reasons as Record<RefusalReason, string>;
    return (
      <Card className="p-4 sm:p-5">
        <CardHeader title={t.refusedTitle} hint={t.refusedLead} />
        <ul className="list-disc space-y-1 pl-5 text-sm" role="list">
          {refusalLines(result.reasons).map((line, i) => (
            <li key={i}>
              {line.kind === 'known'
                ? reasons[line.reason]
                : line.kind === 'text'
                  ? line.text
                  : t.refusedGeneric}
            </li>
          ))}
        </ul>
        {age && <p className="mt-3 text-xs text-silver-400">{age}</p>}
        <p className="mt-3 text-xs text-silver-400">{t.photoTips}</p>
        <div className="mt-4 flex flex-wrap gap-2">
          {verifyRetryable(result.reasons) && (
            <Button
              data-assist="confirm"
              loading={busy}
              onClick={onVerifyAgain}
            >
              {t.verifyAgain}
            </Button>
          )}
          <Button
            variant={verifyRetryable(result.reasons) ? 'outline' : 'solid'}
            loading={busy && !verifyRetryable(result.reasons)}
            disabled={busy}
            onClick={onRetake}
          >
            {t.retakeAll}
          </Button>
        </div>
      </Card>
    );
  }

  return (
    <Card className="p-4 sm:p-5">
      <CardHeader title={t.resultOkTitle} />
      <Alert tone="success">{t.resultOkBody}</Alert>
      {age && (
        <div className="mt-3 text-sm">
          <p className="font-medium">{age}</p>
          <p className="mt-0.5 text-xs text-silver-400">{t.ageNote}</p>
        </div>
      )}
      <div className="mt-4">
        <Button onClick={onContinue}>{t.toBaseLook}</Button>
      </div>
    </Card>
  );
}
