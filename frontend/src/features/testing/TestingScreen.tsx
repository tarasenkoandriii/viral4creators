/**
 * Экран `#/testing` — бриф тестировщика (этап 161,
 * `docs-tz/TZ-Rabota-s-Testirovshchikom.md` §2.3).
 *
 * Он же — ответ на вопрос «нужен ли отдельный лендинг»: нет. Лендинг
 * решал бы одну из двух задач — довести до бота или рассказать, что
 * тестировать. Первую решает сам `t.me`, вторую решает это место:
 * здесь человек уже аутентифицирован, здесь он и работает, и страницу
 * нельзя переслать кому угодно.
 *
 * Чего здесь нет: текста ответов оператора. Ответ приходит в личку, и
 * второе его место разошлось бы с первым.
 */

import { useEffect, useState } from 'react';
import type { Dictionary } from '../../lib/get-dictionary';
import { getTestingBrief, type TestingBrief } from '../../services/tickets-api';

function usd(microUsd: number): string {
  return `$${(microUsd / 1_000_000).toFixed(2)}`;
}

/**
 * Перевод по коду, пришедшему с сервера.
 *
 * Код — строка, а словарь типизирован по своим ключам: индексировать
 * его строкой напрямую запрещает компилятор, и правильно делает.
 * Незнакомый код (сервер знает статус, о котором словарь ещё не
 * слышал) показываем как есть: пустое место на экране хуже кода.
 */
function label(map: Record<string, string>, code: string): string {
  return map[code] ?? code;
}

export function TestingScreen({
  dict,
  locale,
}: {
  dict: Dictionary;
  locale: string;
}) {
  const t = dict.testing;
  const [brief, setBrief] = useState<TestingBrief | null>(null);
  // Отказ в доступе — не сбой (аудит этапа 161). Адрес открыт всем, и
  // нетестировщику надо сказать, что экран не для него, а не «не
  // удалось загрузить»: загрузка удалась, ответ получен и понят.
  const [error, setError] = useState<'failed' | 'forbidden' | null>(null);

  useEffect(() => {
    let alive = true;
    getTestingBrief()
      .then((b) => alive && setBrief(b))
      .catch((e: unknown) => {
        if (!alive) return;
        const status = (e as { response?: { status?: number } })?.response
          ?.status;
        setError(status === 403 ? 'forbidden' : 'failed');
      });
    return () => {
      alive = false;
    };
  }, []);

  if (error)
    return (
      <p className="p-4 text-sm opacity-60">
        {error === 'forbidden' ? t.noAccess : t.failed}
      </p>
    );
  if (!brief) return <p className="p-4 text-sm opacity-60">{t.loading}</p>;

  const scenarioNames = brief.scenarios
    .map((code) => label(dict.accountNotice.testAccess.scenarios, code))
    .filter(Boolean);

  return (
    <div className="mx-auto max-w-2xl px-4 py-4 text-sm">
      <h1 className="text-lg font-semibold">{t.title}</h1>
      <p className="mt-1 opacity-70">{t.brief}</p>

      {/* Что проверять — первый пункт §2.3 и главное, за чем сюда
          приходят. Текст пишет оператор в приглашении: участок у
          каждого свой, и общий бриф на всех означал бы, что каждый
          читает инструкцию для кого-то другого. */}
      {brief.brief && (
        <section className="mt-4 rounded-2xl border border-accent/40 bg-accent/5 p-3">
          <h2 className="text-[13px] font-semibold opacity-80">
            {t.whatToTest}
          </h2>
          <p className="mt-1 whitespace-pre-wrap opacity-90">{brief.brief}</p>
        </section>
      )}

      <section className="mt-4 rounded-2xl border border-silver-300 p-3 dark:border-silver-700">
        <h2 className="text-[13px] font-semibold opacity-80">{t.open}</h2>
        {scenarioNames.length === 0 && !brief.freeOutsideProject ? (
          <p className="mt-1 opacity-70">{t.nothingOpen}</p>
        ) : (
          <ul className="mt-1 list-disc pl-5 opacity-80">
            {scenarioNames.map((name) => (
              <li key={name}>{name}</li>
            ))}
            {brief.freeOutsideProject && <li>{t.outside}</li>}
          </ul>
        )}
        <p className="mt-2 text-[12px] opacity-60">
          {brief.accessUntil
            ? t.until.replace(
                '{date}',
                new Date(brief.accessUntil).toLocaleDateString(locale)
              )
            : t.forever}
        </p>
        {/* Потолок показан здесь, хотя в приветствии бота о нём молчат.
            Там число прилетает в первую же минуту, ничего не объясняя
            и уже тревожа; здесь человек пришёл сам, и рядом стоит
            потраченное — то есть у числа появилась шкала. */}
        <p className="text-[12px] opacity-60">
          {t.spent
            .replace('{spent}', usd(brief.spentTodayMicroUsd))
            .replace('{limit}', usd(brief.dailyLimitMicroUsd))}
        </p>
      </section>

      <h2 className="mt-5 text-[13px] font-semibold opacity-80">
        {t.myTickets}
      </h2>
      {/* Число — от сервера, а не длина списка: список обрезан, и
          выдавать его длину за общее значило бы повторить находку
          аудита этапа 158 на другом экране. */}
      {brief.ticketsTotal > brief.tickets.length && (
        <p className="mt-1 text-[11px] opacity-50">
          {t.shown
            .replace('{shown}', String(brief.tickets.length))
            .replace('{total}', String(brief.ticketsTotal))}
        </p>
      )}
      {brief.tickets.length === 0 ? (
        <p className="mt-1 opacity-70">{t.none}</p>
      ) : (
        <ul className="mt-2 space-y-2">
          {brief.tickets.map((ticket) => (
            <li
              key={ticket.number}
              className="rounded-xl border border-silver-300 p-3 dark:border-silver-700"
            >
              <div className="flex items-baseline gap-2">
                <span className="font-medium">#{ticket.number}</span>
                <span
                  className={
                    ticket.open
                      ? 'text-accent text-[12px]'
                      : 'text-[12px] opacity-60'
                  }
                >
                  {label(t.status, ticket.status)}
                </span>
                <span className="ml-auto text-[11px] opacity-50">
                  {new Date(ticket.createdAt).toLocaleDateString(locale)}
                </span>
              </div>
              <p className="mt-1 opacity-80">{ticket.preview}</p>
              <p className="mt-1 text-[11px] opacity-50">
                {ticket.source === 'BOT' ? t.fromBot : t.fromApp}
                {ticket.answered && ` · ${t.answered}`}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
