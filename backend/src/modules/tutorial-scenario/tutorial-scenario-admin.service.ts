/**
 * TutorialScenarioAdminService — список сценариев и явное одобрение
 * costly=true перед автоматическим исполнением (§4.11 ТЗ, этап 94).
 * Тот же приём, что `AssistantAdminService`/`PublicationService.approve`
 * (см. их доккомментарии): читающая часть отдаёт «как в базе», пишущая
 * — только флаг одобрения, ничего не пересчитывает заново (прикидка
 * стоимости уже посчитана генератором, §4.11 — «число не гарантия, а
 * прикидка ДЛЯ РЕШЕНИЯ человека», не то, что стоит трогать на
 * одобрении).
 */

import {
  BadRequestException,
  Injectable,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { BlobService } from '../storage/blob.service';
import { voiceoverCachePrefix } from '../tutorial-runner/tutorial-voice';
import { validateScenarioSteps } from './tutorial-scenario-prompt';
import { estimateScenarioCost } from './scenario-cost';

export interface TutorialScenarioListFilter {
  subjectKey?: string;
  locale?: string;
  costly?: boolean;
  approved?: boolean;
  page: number;
  pageSize: number;
}

@Injectable()
export class TutorialScenarioAdminService {
  private readonly logger = new Logger(TutorialScenarioAdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly blob: BlobService,
  ) {}

  async list(filter: TutorialScenarioListFilter) {
    const where = {
      subjectKey: filter.subjectKey || undefined,
      locale: filter.locale || undefined,
      costly: filter.costly,
      approved: filter.approved,
    };
    const [rows, total] = await Promise.all([
      this.prisma.tutorialScenario.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (filter.page - 1) * filter.pageSize,
        take: filter.pageSize,
      }),
      this.prisma.tutorialScenario.count({ where }),
    ]);
    return { rows, total, page: filter.page, pageSize: filter.pageSize };
  }

  /**
   * Одобряет трату на costly=true сценарий (§4.11). Идемпотентно — если
   * уже одобрен, просто возвращает текущую строку, не переписывает
   * `approvedBy`/`approvedAt` второй раз (кто одобрил ПЕРВЫМ — то и
   * есть решение, не последний нажавший кнопку).
   */
  async approve(id: string, approvedBy: string) {
    const row = await this.prisma.tutorialScenario.findUnique({
      where: { id },
    });
    if (!row) throw new NotFoundException('Сценарий не найден');
    if (!row.costly) {
      throw new BadRequestException(
        'Этот сценарий бесплатный — одобрение траты ему не требуется',
      );
    }
    if (row.approved) return row;
    return this.prisma.tutorialScenario.update({
      where: { id },
      data: { approved: true, approvedBy, approvedAt: new Date() },
    });
  }

  /**
   * Заменяет шаги сценария на написанные оператором.
   *
   * **Без этого метода вся цепочка A+B+C была заперта.** Промпт
   * нарочно требует от модели плейсхолдеры `[data-testid="..."]`,
   * «которые оператор поправит на настоящие перед первым
   * исполнением», а §11 п.8 приёмки стоит на «фикстурном сценарии с
   * руками проставленными селекторами». Поправить их было нечем:
   * маршрута правки не существовало, и сгенерированный сценарий
   * падал на первом же `click`, не доходя ни до кадров, ни до
   * озвучки, ни до сборки. Заодно состояние `generatedBy: 'manual'`,
   * ради которого генератор заводил стоп-сигнал, было недостижимо
   * через продукт (находка сквозного аудита A+B+C).
   *
   * Шаги валидируются тем же `validateScenarioSteps`, что и ответ
   * модели: всё-или-ничего, каталог хуков, правило платных кнопок.
   * Ослаблять валидацию для человека незачем — он ошибается так же, а
   * исполняет их тот же ночной крон. До сквозного аудита 29.09.2026
   * этот абзац был верен только наполовину: звался `parseScenarioSteps`
   * напрямую, то есть без каталога и без правила платных кнопок.
   *
   * `generatedBy: 'manual'` — не ярлык, а договор: со следующей ночи
   * генератор эту строку не трогает. Вернуть её под автоматику можно
   * удалением (кнопка рядом) — строка пересоздастся ночью.
   *
   * Результат прошлого прогона стирается: он относился к другим
   * шагам. Одобрение — тоже, и без всяких условий: человек, который
   * только что переписал платные шаги, обязан посмотреть на них
   * заново, даже если переписал он их сам.
   */
  async replaceSteps(id: string, rawSteps: unknown, editedBy: string) {
    // `editedBy` не пишется отдельной колонкой: её нет, и заводить
    // миграцию ради подписи под правкой — лишнее. В лог она уходит.
    const row = await this.prisma.tutorialScenario.findUnique({
      where: { id },
    });
    if (!row) throw new NotFoundException('Сценарий не найден');

    // Та же проверка, что у ответа модели (сквозной аудит 29.09.2026):
    // ручная правка исполняется тем же ночным кроном, значит платные
    // кнопки в ней так же опасны — см. `validateScenarioSteps`.
    const parsed = validateScenarioSteps(rawSteps, row.subjectKey);
    if (!parsed.ok) {
      throw new BadRequestException(
        `Шаги не приняты: ${parsed.reason ?? 'не разобрались'}`,
      );
    }

    const cost = estimateScenarioCost(parsed.steps);
    const updated = await this.prisma.tutorialScenario.update({
      where: { id },
      data: {
        steps: parsed.steps as object,
        generatedBy: 'manual',
        costly: cost.costly,
        estimatedCostMicroUsd: cost.estimatedCostMicroUsd,
        costUnpriced: cost.unpriced,
        approved: false,
        approvedBy: null,
        approvedAt: null,
        lastRunStatus: null,
        lastRunError: null,
        // Отметка о вычитке реплик снимается вместе с шагами (§3-бис.5
        // ТЗ, этап D): вычитан был ПРЕЖНИЙ текст, и переносить
        // подпись человека на новый значит подписаться за то, чего он
        // не читал. Снимается безусловно — даже когда реплики не
        // менялись: разобрать, «та же ли это реплика», можно, но
        // тогда правка селектора в шаге с репликой оставляла бы
        // отметку, а правка самой реплики снимала бы, и оператор
        // должен был бы держать это правило в голове.
        narrationReviewedBy: null,
        narrationReviewedAt: null,
      },
    });
    const droppedNote =
      parsed.droppedNarrations.length > 0
        ? `, реплик отброшено ${parsed.droppedNarrations.length}`
        : '';
    this.logger.log(
      `сценарий ${id} (${row.subjectKey}/${row.locale}) переписан оператором ${editedBy}: ${parsed.steps.length} шагов${droppedNote}, одобрение и отметка о вычитке сброшены`,
    );
    // Отброшенные реплики уезжают ОПЕРАТОРУ, а не только в лог.
    // Валидация для человека такая же, как для модели (он ошибается
    // так же), но обратная связь у модели была — `failures[]`, — а у
    // человека не было никакой: он дописывал реплику в 235 символов,
    // видел зелёное «сохранено» и не находил её потом в списке
    // (находка аудита этапа D). Спрашивает-то как раз он.
    return { ...updated, droppedNarrations: parsed.droppedNarrations };
  }

  /**
   * Отметка «реплики прочитаны» (§3-бис.5 ТЗ, этап D).
   *
   * Снимаемая, а не одноразовая, — тот же приём, что у `reviewed` у
   * готового ролика и в отличие от `approve`, который необратим.
   * Причина разная: `approve` разрешает ТРАТИТЬ деньги, и отозвать
   * уже потраченное нельзя, а вычитка это про текст — перечитал,
   * передумал, снял.
   *
   * Сама по себе отметка ничего не решает: она начинает что-то
   * значить, только когда включена `tutorial.requireNarrationReview`.
   * Ставить её при выключенном требовании не бессмысленно — это
   * подготовка к включению.
   */
  async setNarrationReviewed(id: string, reviewed: boolean, by: string) {
    const row = (await this.prisma.tutorialScenario.findUnique({
      where: { id },
    })) as { subjectKey: string; locale: string } | null;
    if (!row) throw new NotFoundException('Сценарий не найден');

    const updated = await this.prisma.tutorialScenario.update({
      where: { id },
      data: {
        narrationReviewedBy: reviewed ? by : null,
        narrationReviewedAt: reviewed ? new Date() : null,
      },
    });
    this.logger.log(
      `сценарий ${id} (${row.subjectKey}/${row.locale}): реплики ${
        reviewed
          ? `отмечены вычитанными оператором ${by}`
          : 'помечены невычитанными'
      }`,
    );
    return updated;
  }

  /**
   * Удаляет сгенерированный сценарий (этап 106).
   *
   * Изначально кнопка была нужна из-за того, что генератор делал
   * `create()` на каждый прогон и строки копились. С этапа C
   * (`docs-tz/TZ-Tutorial-Video-Voiced.md`) пара (шаг, локаль)
   * уникальна, генератор правит свою же строку, и копиться нечему —
   * но кнопка нужна по-прежнему, и причин теперь две.
   *
   * **Сломанный сценарий.** Исполнитель берёт все подходящие
   * (`costly:false OR approved:true`) в порядке «кто дольше не
   * исполнялся»; сценарий с `route`, который `route-templates.ts` не
   * резолвит, будет падать на каждом прогоне и слать алерт. Правки
   * это не лечит: следующей же ночью генератор перепишет строку тем
   * же ответом модели.
   *
   * **Сброс устаревшего одобрения.** Генератор снимает `approved`
   * только когда шаги изменились и сценарий платный; отозвать
   * одобрение на неизменившемся сценарии больше нечем — кнопки
   * «отозвать» в админке нет. Удаление и есть этот сброс: строка
   * пересоздастся ночью неодобренной.
   */
  async remove(id: string): Promise<{ id: string }> {
    const row = await this.prisma.tutorialScenario.findUnique({
      where: { id },
    });
    if (!row) throw new NotFoundException('Сценарий не найден');
    await this.prisma.tutorialScenario.delete({ where: { id } });
    // Кеш озвучки этой пары — за строкой. Сверка кеша
    // (`reconcileVoiceCache`) ходит только по сценариям, которые
    // сегодня собираются; у удалённого сборки не будет никогда, и
    // его дорожки остались бы в Blob навсегда. До этапа D это был
    // один файл на пару, теперь до тридцати (находка аудита этапа D).
    //
    // Не относится к сужению `tutorial.scenarioLocales` (пятый
    // уровень отката §9): там строки сценариев остаются, дорожки
    // по-прежнему их, и расширив список обратно, оператор получит
    // готовый кеш вместо нового счёта за синтез.
    //
    // Best-effort: сценарий удалён, и падать из-за неубранного кеша
    // после этого поздно.
    try {
      await this.wipeVoiceCache(row.subjectKey, row.locale);
    } catch (e) {
      this.logger.warn(
        `сценарий ${id}: кеш озвучки не убрался (${
          e instanceof Error ? e.message : String(e)
        }) — файлы останутся в Blob`,
      );
    }
    return { id };
  }

  /** Постранично, как и остальные подметальщики префиксов. */
  private async wipeVoiceCache(
    subjectKey: string,
    locale: string,
  ): Promise<void> {
    const prefix = voiceoverCachePrefix(subjectKey, locale);
    let cursor: string | undefined;
    do {
      const page = await this.blob.listByPrefix(prefix, { cursor });
      if (page.blobs.length > 0) {
        await this.blob.deleteMany(page.blobs.map((b) => b.pathname));
      }
      cursor = page.cursor ?? undefined;
    } while (cursor);
  }
}
