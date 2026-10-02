/**
 * Обновления бота Помощника — H (§3.7 п.3–4; №11, №12; §4-тер.3
 * «кандидат с кнопкой в боте»). Вызывает telegram-webhook (после проверки
 * секрета); всегда 200 — ошибки обработки только в лог (id и код).
 *
 *  - `/start` — assist_bot_users.startedAt (+ language_code), снимает blockedAt;
 *  - my_chat_member kicked — blockedAt;
 *  - callback_query: `h:take:<handoffId>`, `h:draft:<id>`, `h:send:<id>`
 *    (отправить черновик как есть), `h:tpl:<id>:<n>`, `h:close:<id>`,
 *    `l:prop:<messageId>` (предложить ответ оператора как проверенный —
 *    LearningCandidates.proposeFromOperator, L);
 *  - message с reply_to_message на сообщение из assist_bot_messages →
 *    HandoffOperatorActions.reply (текст — только text, без вложений:
 *    «пока только текст» в ответ).
 * Права проверяются по telegramId → участник кабинета сайта передачи.
 */
import { HttpException, Injectable, Logger, Optional } from '@nestjs/common';
import { HANDOFF_DEFAULTS } from '../../../config/assist-defaults';
import { PrismaService } from '../../../prisma/prisma.service';
import { LearningCandidates } from '../../assist-site-learning/learning-queue.service';
import { effectiveHandoffConfig } from '../public/handoff-config';
import { parseDraft } from '../system/handoff-common';
import { HandoffDispatcher } from '../system/handoff-dispatcher.service';
import {
  HandoffOperatorActions,
  type OperatorActor,
} from '../system/handoff-operator.service';

type Obj = Record<string, unknown>;

function obj(v: unknown): Obj | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Obj)
    : null;
}

function int(v: unknown): number | null {
  return typeof v === 'number' && Number.isSafeInteger(v) ? v : null;
}

/** id чата/человека Telegram — целое (в JSON — число до 2^52). */
function tgId(v: unknown): bigint | null {
  return typeof v === 'number' && Number.isSafeInteger(v) ? BigInt(v) : null;
}

/** Ответы человеку в боте — по-русски, короткие (ошибка кабинета → понятный текст). */
const ERROR_TEXT: Record<string, string> = {
  HANDOFF_CLOSED: 'Передача уже закрыта — ответ не отправлен.',
  HANDOFF_NOT_ASSIGNED: 'Диалог взял другой оператор — ответ не отправлен.',
  HANDOFF_NOT_FOUND: 'Передача не найдена или нет доступа.',
  REPLY_INVALID: 'Ответ пустой или слишком длинный — не отправлен.',
  FORBIDDEN: 'Нет прав отвечать посетителям этого сайта.',
};

function errorCode(e: unknown): string {
  if (e instanceof HttpException) {
    const r = e.getResponse() as { code?: unknown };
    if (typeof r?.code === 'string') return r.code;
  }
  return 'INTERNAL';
}

const START_TEXT =
  'Готово: сюда будут приходить посетители сайта, которые просят человека. ' +
  'Нажмите «Взять» в карточке и отвечайте реплаем — ответ уйдёт посетителю в виджет.';
const HELP_TEXT =
  'Чтобы ответить посетителю, ответьте реплаем на карточку или его сообщение.';
const TEXT_ONLY = 'Пока посетителю можно отправить только текст.';

@Injectable()
export class AssistBotUpdates {
  private readonly logger = new Logger(AssistBotUpdates.name);
  now: () => Date = () => new Date();

  constructor(
    private readonly prisma: PrismaService,
    private readonly actions: HandoffOperatorActions,
    private readonly dispatcher: HandoffDispatcher,
    @Optional() private readonly candidates?: LearningCandidates,
  ) {}

  /** Обработать обновление; ошибки — только в лог (id обновления и код). */
  async handle(update: unknown): Promise<void> {
    const u = obj(update);
    if (!u) return;
    const updateId = int(u.update_id) ?? '—';
    try {
      if (obj(u.callback_query))
        return await this.callback(obj(u.callback_query) as Obj);
      if (obj(u.my_chat_member))
        return await this.chatMember(obj(u.my_chat_member) as Obj);
      if (obj(u.message)) return await this.message(obj(u.message) as Obj);
    } catch (e) {
      this.logger.warn(
        `бот: обновление ${updateId} не обработано (${errorCode(e)}/${(e as Error | null)?.name ?? 'Error'})`,
      );
    }
  }

  // ── /start, блокировка ────────────────────────────────────────────────

  private async start(from: Obj, chatId: bigint): Promise<void> {
    const telegramId = tgId(from.id);
    if (telegramId === null) return;
    const lang =
      typeof from.language_code === 'string'
        ? from.language_code.slice(0, 8)
        : null;
    const now = this.now();
    await this.prisma.assistBotUser.upsert({
      where: { telegramId },
      create: {
        telegramId,
        startedAt: now,
        blockedAt: null,
        languageCode: lang,
      },
      update: { startedAt: now, blockedAt: null, languageCode: lang },
    });
    this.dispatcher.forgetRecipients();
    this.logger.log('бот: /start — получатель передач отмечен');
    await this.dispatcher.bot().send({ chatId, text: START_TEXT });
  }

  private async chatMember(m: Obj): Promise<void> {
    const chat = obj(m.chat);
    if (chat?.type !== 'private') return;
    const telegramId = tgId(obj(m.from)?.id);
    const status = obj(m.new_chat_member)?.status;
    if (telegramId === null || typeof status !== 'string') return;
    if (status === 'kicked') {
      await this.prisma.assistBotUser.upsert({
        where: { telegramId },
        create: { telegramId, blockedAt: this.now() },
        update: { blockedAt: this.now() },
      });
      this.logger.log('бот: заблокирован человеком — карточки ему не шлём');
    } else if (status === 'member') {
      await this.prisma.assistBotUser.updateMany({
        where: { telegramId },
        data: { blockedAt: null },
      });
    }
    this.dispatcher.forgetRecipients();
  }

  // ── Сообщения: /start и реплаи ────────────────────────────────────────

  private async message(msg: Obj): Promise<void> {
    const chat = obj(msg.chat);
    const from = obj(msg.from);
    if (chat?.type !== 'private' || !from) return;
    const chatId = tgId(chat.id);
    const telegramId = tgId(from.id);
    if (chatId === null || telegramId === null) return;
    const text = typeof msg.text === 'string' ? msg.text : null;
    if (text && /^\/start(?:@\w+)?(?:\s|$)/.test(text)) {
      return this.start(from, chatId);
    }
    const replyTo = int(obj(msg.reply_to_message)?.message_id);
    const bot = this.dispatcher.bot();
    if (replyTo === null) {
      await bot.send({ chatId, text: HELP_TEXT });
      return;
    }
    const ref = await this.prisma.assistBotMessage.findUnique({
      where: { chatId_messageId: { chatId, messageId: replyTo } },
      select: {
        handoffId: true,
        expiresAt: true,
        accountId: true,
        siteId: true,
        conversationId: true,
      },
    });
    if (!ref?.handoffId || ref.expiresAt < this.now()) {
      await bot.send({ chatId, text: HELP_TEXT });
      return;
    }
    if (!text?.trim()) {
      await bot.send({
        chatId,
        text: TEXT_ONLY,
        replyToMessageId: int(msg.message_id) ?? undefined,
      });
      return;
    }
    const own = int(msg.message_id);
    // Повтор того же обновления (Telegram повторяет, если ответ 200 не
    // дошёл: долгий перевод, обрыв функции) — не второй ответ посетителю.
    // Ключ — id сообщения оператора в его чате (у бота и человека в личке
    // одна нумерация), запись — в assist_bot_messages: реплай на своё же
    // сообщение тоже найдёт эту передачу.
    if (own !== null) {
      const claimed = await this.prisma.assistBotMessage.createMany({
        data: [
          {
            chatId,
            messageId: own,
            accountId: ref.accountId,
            siteId: ref.siteId,
            kind: 'operator_in',
            handoffId: ref.handoffId,
            conversationId: ref.conversationId,
            expiresAt: new Date(
              this.now().getTime() + HANDOFF_DEFAULTS.botMessageTtlMs,
            ),
          },
        ],
        skipDuplicates: true,
      });
      if (claimed.count !== 1) {
        this.logger.log('бот: повтор реплая оператора — пропущен');
        return;
      }
    }
    await this.sendReply(
      { via: 'bot', telegramId },
      chatId,
      ref.handoffId,
      {
        text,
      },
      own,
    );
  }

  private async sendReply(
    actor: OperatorActor,
    chatId: bigint,
    handoffId: string,
    body: { text: string; noTranslate?: boolean },
    replyToMessageId: number | null,
  ): Promise<boolean> {
    const bot = this.dispatcher.bot();
    try {
      const r = await this.actions.reply(actor, handoffId, body);
      const h = await this.dispatcher.row(handoffId);
      const echo = await bot.send({
        chatId,
        text: r.translated
          ? `✓ Отправлено посетителю (в переводе):\n${r.sentText}`
          : '✓ Отправлено посетителю.',
        replyToMessageId: replyToMessageId ?? undefined,
        buttons: [
          [
            {
              text: 'Предложить как проверенный ответ',
              callback: `l:prop:${r.messageId}`,
            },
          ],
        ],
      });
      if (h && echo.ok && echo.messageId !== null) {
        await this.dispatcher.remember(
          chatId,
          echo.messageId,
          h,
          'operator_echo',
          h.assignedMemberId,
        );
      }
      return true;
    } catch (e) {
      const code = errorCode(e);
      this.logger.warn(
        `бот: ответ в передачу ${handoffId} не принят (${code})`,
      );
      await bot.send({
        chatId,
        text:
          ERROR_TEXT[code] ??
          'Не получилось отправить ответ — попробуйте ещё раз.',
        replyToMessageId: replyToMessageId ?? undefined,
      });
      return false;
    }
  }

  // ── Кнопки ────────────────────────────────────────────────────────────

  private async callback(q: Obj): Promise<void> {
    const id = typeof q.id === 'string' ? q.id : null;
    const data = typeof q.data === 'string' ? q.data : '';
    const telegramId = tgId(obj(q.from)?.id);
    const message = obj(q.message);
    const chatId = tgId(obj(message?.chat)?.id);
    const messageId = int(message?.message_id);
    const bot = this.dispatcher.bot();
    const answer = (text?: string) =>
      id
        ? bot.answerCallback({ callbackQueryId: id, text })
        : Promise.resolve();
    if (telegramId === null || chatId === null) return answer();
    const actor: OperatorActor = { via: 'bot', telegramId };

    const prop = /^l:prop:([A-Za-z0-9_-]{1,64})$/.exec(data);
    if (prop) {
      if (!this.candidates) return answer('Пока недоступно');
      const r = await this.candidates
        .proposeFromOperator({ telegramId, messageId: prop[1] })
        .catch(() => 'not_found' as const);
      const text: Record<string, string> = {
        proposed: 'Предложено — менеджер увидит в «Обучении».',
        duplicate: 'Уже предложено.',
        forbidden: 'Нет прав.',
        not_found: 'Ответ не найден.',
      };
      return answer(text[r] ?? 'Готово');
    }

    const m =
      /^h:(take|draft|send|tpl|close):([A-Za-z0-9_-]{1,40})(?::(l|\d{1,2}))?$/.exec(
        data,
      );
    if (!m) return answer();
    const [, action, handoffId, arg] = m;
    try {
      if (action === 'take') {
        const r = await this.actions.take(actor, handoffId);
        return answer(
          r.result === 'taken'
            ? 'Диалог ваш — отвечайте реплаем на карточку.'
            : r.result === 'already_taken'
              ? 'Диалог уже взял другой оператор.'
              : 'Передача уже закрыта.',
        );
      }
      if (action === 'close') {
        await this.actions.close(actor, handoffId);
        return answer('Передача закрыта.');
      }
      if (action === 'draft') {
        await answer('Готовлю черновик…');
        const d = await this.actions.regenerateDraft(actor, handoffId);
        if (!d) {
          await bot.send({
            chatId,
            text: 'Черновика нет: в знаниях сайта не нашлось ответа на вопрос посетителя.',
          });
          return;
        }
        const h = await this.dispatcher.row(handoffId);
        const src = d.sources
          .map((s) => s.url ?? s.title)
          .filter(Boolean)
          .slice(0, 3)
          .join('\n');
        const sent = await bot.send({
          chatId,
          text: `Черновик из знаний сайта (${d.lang}):\n${d.text}${src ? `\n\nИсточники:\n${src}` : ''}\n\nОтправьте как есть или ответьте реплаем своим текстом.`,
          replyToMessageId: messageId ?? undefined,
          buttons: [
            [{ text: 'Отправить как есть', callback: `h:send:${handoffId}` }],
          ],
        });
        if (h && sent.ok && sent.messageId !== null) {
          await this.dispatcher.remember(
            chatId,
            sent.messageId,
            h,
            'draft',
            null,
          );
        }
        return;
      }
      if (action === 'send') {
        const h = await this.dispatcher.row(handoffId);
        const d = parseDraft(h?.draft);
        if (!h || !d) return answer('Черновика нет.');
        // Двойное нажатие / повтор обновления — черновик уходит посетителю
        // один раз: сообщение черновика помечается условным UPDATE.
        const draftMsg =
          messageId === null
            ? null
            : { chatId_messageId: { chatId, messageId } };
        if (draftMsg) {
          const claim = await this.prisma.assistBotMessage.updateMany({
            where: { chatId, messageId: messageId as number, kind: 'draft' },
            data: { kind: 'draft_sent' },
          });
          if (claim.count !== 1) {
            const known = await this.prisma.assistBotMessage.findUnique({
              where: draftMsg,
              select: { kind: true },
            });
            if (known?.kind === 'draft_sent')
              return answer('Черновик уже отправлен.');
          }
        }
        await answer();
        const ok = await this.sendReply(
          actor,
          chatId,
          handoffId,
          {
            text: d.text,
            // Черновик уже на языке посетителя — второй перевод не нужен.
            noTranslate: !!h.visitorLang && d.lang === h.visitorLang,
          },
          messageId,
        );
        if (!ok && draftMsg) {
          // Не ушёл (закрыто, взял другой) — кнопку можно нажать снова.
          await this.prisma.assistBotMessage.updateMany({
            where: {
              chatId,
              messageId: messageId as number,
              kind: 'draft_sent',
            },
            data: { kind: 'draft' },
          });
        }
        return;
      }
      if (action === 'tpl') {
        // Права — тем же разбором, что у ответа (чужой — «не найдено»).
        const { h } = await this.actions.resolve(actor, handoffId);
        const site = await this.prisma.assistSite.findUnique({
          where: { siteId: h.siteId },
          select: { handoffConfig: true },
        });
        const templates = effectiveHandoffConfig(site?.handoffConfig).templates;
        if (!templates.length)
          return answer('Шаблонов нет — добавьте их в настройках передачи.');
        if (arg === undefined || arg === 'l') {
          await answer();
          await bot.send({
            chatId,
            text: 'Выберите шаблон ответа:',
            replyToMessageId: messageId ?? undefined,
            buttons: templates.map((t, i) => [
              {
                text: t.title.slice(0, 60),
                callback: `h:tpl:${handoffId}:${i}`,
              },
            ]),
          });
          return;
        }
        const t = templates[Number(arg)];
        if (!t) return answer('Шаблон не найден.');
        await answer();
        await this.sendReply(
          actor,
          chatId,
          handoffId,
          { text: t.text },
          messageId,
        );
        return;
      }
      return answer();
    } catch (e) {
      const code = errorCode(e);
      this.logger.warn(`бот: кнопка ${action} передачи ${handoffId} (${code})`);
      return answer(ERROR_TEXT[code] ?? 'Не получилось — попробуйте ещё раз.');
    }
  }
}
