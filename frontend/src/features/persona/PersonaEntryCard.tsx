/**
 * Вход в «Создать себя» (ТЗ Greeting 2.0 §4.1) — карточка над списком
 * бренд-буков: личный бренд-бук (§4.7) строится на персоне, и искать её
 * естественно рядом с ним.
 *
 * Прячется целиком, пока режим выключен флагом (`GET /personas/me` →
 * 404 `PERSONA_DISABLED`), для гостя, и пока ответ не пришёл — мигнуть входом,
 * который тут же исчезнет, хуже, чем показать его на полсекунды позже.
 * Сбой сети тоже прячет: это вход, а не экран, и красная ошибка над
 * чужим списком ничего человеку не даёт.
 */

import { UserRound } from 'lucide-react';
import { Button, Card } from '../../components/ui';
import { useI18n } from '../../lib/i18n-context';
import { navigate, routes } from '../../lib/router';
import { personaStage } from '../../lib/persona-flow';
import { usePersonaMe } from './usePersonaMe';

export function PersonaEntryCard() {
  const { dict } = useI18n();
  const t = dict.persona;
  const { load } = usePersonaMe();

  // Гостю вход не показываем (CONTRACT5): без входа через Telegram
  // персону не создать, а карточка вела бы на экран «войдите».
  if (load.kind !== 'ready') return null;
  // Режим выключен, а своей персоны нет — входить некуда. Персона есть —
  // вход остаётся: на экране её можно удалить и при выключенном флаге.
  if (load.me.enabled === false && !load.me.persona) return null;
  const started = personaStage(load.me) !== 'intro';

  return (
    <Card className="mb-4 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <UserRound size={20} className="shrink-0 text-accent" aria-hidden />
        <div className="min-w-0 flex-1 basis-48">
          <p className="text-sm font-semibold">
            {started ? t.entryContinueTitle : t.entryTitle}
          </p>
          <p className="mt-0.5 text-xs text-silver-400">{t.entryHint}</p>
        </div>
        <Button size="sm" onClick={() => navigate(routes.persona())}>
          {started ? t.entryContinue : t.entryOpen}
        </Button>
      </div>
    </Card>
  );
}
