/**
 * TelegramNotifyService — два служебных канала: ошибки и статистика
 * (ТЗ §28, этап 45; переписан на этапе 47).
 *
 * ## Зачем
 *
 * До этого о сбое узнавали, когда о нём писал пользователь. Логи Vercel
 * читают, когда уже знают, что искать; вкладка «Расходы» показывает
 * деньги, но не аварию. Два канала в Telegram — самая дешёвая правка из
 * оставшихся и единственная, которая окупается до первого платящего.
 *
 * ## Почему отправка синхронная, а не очередь с таймером (этап 47, В-2.5)
 *
 * Первая версия складывала сообщения в очередь и разбирала её
 * `setTimeout`-ом с `unref()` — «чтобы функция на Vercel могла
 * завершиться, не дожидаясь отправки». Ровно это и делало канал
 * ненадёжным: ответ отдан — экземпляр заморожен — таймер не сработал —
 * сообщение не ушло. Суточный отчёт был единственным запросом за час и
 * не доходил вовсе, а маршрут при этом отвечал `sent: true`.
 *
 * Теперь `alert`/`stat` — `async`, вызывающий их `await`-ит, и ответ
 * уходит только после того, как Telegram ответил (или отказал). Цена —
 * один сетевой запрос с потолком в пять секунд, и только там, где
 * что-то действительно случилось. Пауза между сообщениями против 429
 * не нужна: за один вызов функции уходит не больше двух сообщений, а
 * всплеск одинаковых тревог гасит дедупликация.
 *
 * ## Почему дедупликация в базе, а не в памяти
 *
 * Состояние «когда этот отпечаток уходил в последний раз» жило в `Map`
 * экземпляра. Экземпляров на Vercel много, и падающий провайдер — тот
 * самый случай, ради которого дедупликация существует, — разлетается
 * по всем сразу: у каждого свой пустой `Map`, и «три сотни одинаковых
 * строк равны нулю строк» не выполнялось. Решение принимает один
 * `INSERT … ON CONFLICT … RETURNING` в `alert_states`: он и проверяет,
 * и обновляет, и отдаёт вердикт атомарно для всех экземпляров.
 *
 * ## Три правила, без которых канал бесполезен или вреден
 *
 * 1. **Отправка не имеет права ломать запрос.** Ни один метод не
 *    бросает: сбой Telegram или базы пишется в лог, метод отдаёт
 *    `false`. Сбой базы при дедупликации — отправляем (лучше лишняя
 *    строка, чем молчание об аварии).
 * 2. **Дедупликация.** Первая тревога с отпечатком уходит сразу,
 *    повторы в течение окна (десять минут) копятся, первая тревога
 *    после окна несёт сводку «и ещё N раз».
 * 3. **Фильтр секретов и персональных данных** — `redact.ts`.
 *
 * ## Настройка
 *
 * `TELEGRAM_BOT_TOKEN` (тот же бот, что валидирует initData) плюс
 * `TELEGRAM_ALERTS_CHAT_ID` и `TELEGRAM_STATS_CHAT_ID`. Идентификаторы
 * чатов, а не список операторов в базе: добавление человека делается
 * правами внутри Telegram и не требует деплоя. Не задан чат — канал
 * молчит, и это нормальное состояние стенда, а не ошибка.
 */

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { redact } from './redact';

/** Окно тишины для повторов одной тревоги (ТЗ §28.3). */
export const DEFAULT_WINDOW_MS = 10 * 60 * 1000;

/** Потолок ожидания Telegram: дольше держать ответ пользователю нельзя. */
const SEND_TIMEOUT_MS = 5000;

/** Отпечатки, о которых не вспоминали неделю, из базы уходят. */
const STATE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

interface DedupVerdict {
  send: boolean;
  /** Сколько повторов накопилось за прошлое окно — попадает в сводку. */
  reported: number;
}

@Injectable()
export class TelegramNotifyService {
  private readonly logger = new Logger(TelegramNotifyService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Живые настройки: `process.env` читается на каждом вызове — как во
   * вкладке «Настройки», чтобы правка окружения не требовала пересборки. */
  private get botToken(): string | undefined {
    return process.env.TELEGRAM_BOT_TOKEN?.trim() || undefined;
  }
  private get alertsChat(): string | undefined {
    return process.env.TELEGRAM_ALERTS_CHAT_ID?.trim() || undefined;
  }
  private get statsChat(): string | undefined {
    return process.env.TELEGRAM_STATS_CHAT_ID?.trim() || undefined;
  }

  /**
   * Тревога в канал ошибок. Возвращает, ушло ли сообщение.
   *
   * @param fingerprint что делает две тревоги «одинаковыми»: тип плюс
   *        место, БЕЗ переменной части (id сессии, текста ответа) —
   *        иначе дедупликация не сработает никогда.
   */
  async alert(fingerprint: string, text: string): Promise<boolean> {
    const chatId = this.alertsChat;
    if (!chatId || !this.botToken) return false;

    const verdict = await this.decide(fingerprint, new Date());
    if (!verdict.send) return false;

    const summary =
      verdict.reported > 0
        ? `\n(и ещё ${verdict.reported} раз за последние ${Math.round(DEFAULT_WINDOW_MS / 60000)} мин)`
        : '';
    return this.send(chatId, `🔴 ${redact(text)}${summary}`);
  }

  /** Событие в канал статистики. Без дедупликации: события разные. */
  async stat(text: string): Promise<boolean> {
    const chatId = this.statsChat;
    if (!chatId || !this.botToken) return false;
    return this.send(chatId, redact(text));
  }

  /** Суточный/недельный отчёт — тот же канал статистики, отдельный метод
   * ради читаемости вызывающего кода. */
  report(text: string): Promise<boolean> {
    return this.stat(text);
  }

  /**
   * Личное сообщение конкретному пользователю (ТЗ §20 №18 — уведомление
   * исполнителю о лайках/публикации). Транзакционное, не маркетинговое:
   * НЕ проверяет marketingConsentAt/marketingConsentRevokedAt (тот гейт —
   * для опционального дайджеста от marketing-broadcast.service.ts, это
   * разные вещи), без дедупликации (каждое такое сообщение — про разное
   * событие, дедуп между разными portfolioItemId только помешал бы).
   * Молча проглатывает провал (заблокировал бота и т.п.) — это не тревога
   * для оператора, это обычное, ожидаемое поведение части пользователей.
   */
  async dm(telegramId: string, text: string): Promise<boolean> {
    if (!this.botToken) return false;
    return this.send(telegramId, text);
  }

  /**
   * Повторы, которые дедупликация проглотила и ещё не показала (этап 52,
   * В-2.10). Сводка «и ещё N раз» уходит только с первой тревогой ПОСЛЕ
   * окна; если провайдер починился и тревог больше не было, оператор
   * видел одну строку и не знал, что их было триста. Суточный отчёт
   * забирает эти хвосты отсюда.
   */
  async suppressedSummary(
    now: Date = new Date(),
  ): Promise<Array<{ fingerprint: string; suppressed: number }>> {
    const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    try {
      const rows = await this.prisma.$queryRaw<
        Array<{ fingerprint: string; suppressed: number }>
      >`
        SELECT "fingerprint", "suppressed"
        FROM "alert_states"
        WHERE "suppressed" > 0 AND "lastSentAt" >= ${since}
        ORDER BY "suppressed" DESC
        LIMIT 10
      `;
      return rows.map((r: { fingerprint: string; suppressed: number }) => ({
        fingerprint: r.fingerprint,
        suppressed: Number(r.suppressed),
      }));
    } catch (error) {
      this.logger.warn(
        `сводка подавленных тревог недоступна: ${message(error)}`,
      );
      return [];
    }
  }

  /**
   * Забытые отпечатки. Строк — по числу разных отпечатков, то есть
   * десятки; чистка нужна не ради места, а чтобы таблица не была
   * единственной в базе, которая не убирается ничем.
   */
  async pruneStates(now: Date = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - STATE_MAX_AGE_MS);
    try {
      return await this.prisma.$executeRaw`
        DELETE FROM "alert_states" WHERE "lastSentAt" < ${cutoff}
      `;
    } catch (error) {
      this.logger.warn(
        `не удалось убрать старые отпечатки тревог: ${message(error)}`,
      );
      return 0;
    }
  }

  /**
   * Правило дедупликации одним запросом (ТЗ §28.3):
   *   - отпечатка нет → строка создаётся, `send = true`;
   *   - есть, окно ещё открыто → счётчик +1, `send = false`;
   *   - есть, окно закрылось → накопленное уходит в `reported`, счётчик
   *     обнуляется, `lastSentAt = now`, `send = true`.
   *
   * `send` вычисляется как `"lastSentAt" = now`: только в двух ветках
   * из трёх строка получает именно это время.
   */
  private async decide(
    fingerprint: string,
    now: Date,
    windowMs: number = DEFAULT_WINDOW_MS,
  ): Promise<DedupVerdict> {
    const windowStart = new Date(now.getTime() - windowMs);
    try {
      const rows = await this.prisma.$queryRaw<
        { send: boolean; reported: number }[]
      >`
        INSERT INTO "alert_states" ("fingerprint", "lastSentAt", "suppressed", "reported")
        VALUES (${fingerprint}, ${now}, 0, 0)
        ON CONFLICT ("fingerprint") DO UPDATE SET
          "reported" = CASE
            WHEN "alert_states"."lastSentAt" <= ${windowStart} THEN "alert_states"."suppressed"
            ELSE "alert_states"."reported" END,
          "suppressed" = CASE
            WHEN "alert_states"."lastSentAt" <= ${windowStart} THEN 0
            ELSE "alert_states"."suppressed" + 1 END,
          "lastSentAt" = CASE
            WHEN "alert_states"."lastSentAt" <= ${windowStart} THEN ${now}
            ELSE "alert_states"."lastSentAt" END
        RETURNING ("lastSentAt" = ${now}) AS "send", "reported"
      `;
      const row = rows[0];
      return row
        ? { send: row.send, reported: Number(row.reported) }
        : { send: true, reported: 0 };
    } catch (error) {
      // База недоступна — это само по себе повод для тревоги; молчать
      // из-за того, что не удалось проверить повтор, было бы наоборот.
      this.logger.warn(`дедупликация тревог недоступна: ${message(error)}`);
      return { send: true, reported: 0 };
    }
  }

  private async send(chatId: string, text: string): Promise<boolean> {
    try {
      const res = await fetch(
        `https://api.telegram.org/bot${this.botToken}/sendMessage`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text,
            disable_web_page_preview: true,
          }),
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        },
      );
      if (!res.ok) {
        this.logger.warn(`Telegram ответил ${res.status} на сообщение в чат`);
        return false;
      }
      return true;
    } catch (error) {
      this.logger.warn(
        `не удалось отправить сообщение в Telegram: ${message(error)}`,
      );
      return false;
    }
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
