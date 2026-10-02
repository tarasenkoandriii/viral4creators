/**
 * Хвост права посетителя на удаление — L (ТЗ §4-тер.12, §4-тер.15 п.12).
 * `POST /widget/v1/forget` (W) удаляет диалоги — каскады FK уносят
 * очередь, кейсы eval из диалога, передачи; у проверенного ответа
 * `fromConversationId` и у события цели `conversationId` обнуляет база.
 * Остаётся то, что роль виджета сделать не может: дословный вопрос
 * посетителя в `assist_site_faq.variants` (по variantRefs). W ДО удаления
 * диалогов зовёт `enqueue` с их id; системный код L (крон
 * assist-learn-rollup и assist-handoff-tick — `processForgetJobs`, чтобы
 * хвост закрывался за минуты, а не за сутки) удаляет варианты и ставит
 * processedAt.
 *
 * Ошибка записи НЕ глотается: без строки задания хвост не закроется
 * никогда, поэтому W должен отказать посетителю (повтор), а не удалить
 * диалоги «наполовину».
 */
import { Injectable } from '@nestjs/common';
import { AssistPublicDb } from '../../../prisma/assist-public-db.service';

/** id диалогов в одном задании: больше — несколько строк. */
export const FORGET_IDS_PER_JOB = 500;

@Injectable()
export class ForgetJobs {
  constructor(readonly db: AssistPublicDb) {}

  /** Только INSERT (createMany без RETURNING); пустой список — ничего. */
  async enqueue(siteId: string, conversationIds: string[]): Promise<void> {
    const ids = [
      ...new Set(
        (conversationIds ?? []).filter(
          (x): x is string =>
            typeof x === 'string' && x.length > 0 && x.length <= 64,
        ),
      ),
    ];
    if (!ids.length) return;
    const data: Array<{ siteId: string; conversationIds: string[] }> = [];
    for (let i = 0; i < ids.length; i += FORGET_IDS_PER_JOB) {
      data.push({
        siteId,
        conversationIds: ids.slice(i, i + FORGET_IDS_PER_JOB),
      });
    }
    await this.db.assistSiteForgetJob.createMany({ data });
  }
}
