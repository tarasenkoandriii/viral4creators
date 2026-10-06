'use client';

import { useEffect, useState } from 'react';
import {
  browserEntryLink,
  entryReferralCode,
  telegramEntryLink,
  type LandingEntry,
} from '../lib/telegram-entry';

/**
 * Две дороги из лендинга в один и тот же сценарий мини-аппа: браузерная
 * кнопка (как была) и «Открыть в Telegram» рядом с ней
 * (`lib/telegram-entry.ts`).
 *
 * Клиентский компонент только ради `?ref=`: страницы лендинга
 * статические, и код приглашения из адреса узнаётся уже в браузере. До
 * этого (и без JavaScript) обе ссылки рабочие — просто без кода.
 *
 * Имени бота нет (или оно негодное) — кнопки Telegram нет, остаётся
 * браузерная: та же политика, что у страницы приглашения `/r/<код>`.
 */
export function EntryActions({
  entry,
  tmaUrl,
  botUsername,
  browserLabel,
  telegramLabel,
}: {
  entry: LandingEntry;
  tmaUrl: string;
  botUsername: string | null;
  browserLabel: string;
  telegramLabel: string;
}) {
  const [refCode, setRefCode] = useState<string | null>(null);
  useEffect(() => {
    setRefCode(entryReferralCode(new URLSearchParams(window.location.search).get('ref')));
  }, []);
  const telegramHref = telegramEntryLink(entry, botUsername, refCode);
  return (
    <>
      <a className="cta" href={browserEntryLink(entry, tmaUrl, refCode)}>
        {browserLabel}
      </a>
      {telegramHref ? (
        <a className="cta cta-ghost cta-telegram" href={telegramHref} data-entry={entry}>
          {telegramLabel}
        </a>
      ) : null}
    </>
  );
}
