/**
 * Оркестрация text-card (ТЗ VEO-MODEL-VERSION-CHOICE-SPEC.md §20.3–
 * §20.4) — берёт `OnScreenTextMoment[]` (уже извлечены
 * `PromptService.extractLiteralTexts()`), рендерит каждый через
 * `common/text-card-render.ts` (настоящий шрифт, не догадка модели),
 * заливает в тот же Blob, что уже хранит референс-фото пользователя, и
 * обновляет сессию.
 *
 * Отдельный сервис, не метод `PromptService` — тому не нужен
 * `BlobService` ни для чего другого, а этому не нужен доступ к самой
 * генерации промпта.
 */
import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { SessionService } from '../../common/session.service';
import { BlobService } from '../storage/blob.service';
import { OnScreenTextMoment } from '../../common/types/prompt.types';
import { renderTextCard, TextCardRole } from '../../common/text-card-render';

/** §20.4 п.1 — порядок приоритета при нехватке слотов референсов:
 * персонажи (обрабатываются отдельно, в `reference-plan.ts`) важнее
 * всех текстовых карточек; среди самих карточек — cta (самый
 * конверсионный момент) > hook > callout. Тот же порядок здесь нужен,
 * чтобы при явном отказе рендерить не всё (§20.7 — например, лимит по
 * стоимости в будущем) render started с самой важной роли первой. */
const ROLE_PRIORITY: Record<TextCardRole, number> = {
  cta: 0,
  hook: 1,
  callout: 2,
};

/**
 * Найдено при повторном аудите собственной реализации: хэш раньше
 * учитывал только `role:text` — если пользователь МЕНЯЛ формат ролика
 * (аспект есть в мастере, `AspectRatioPicker.tsx`) ПОСЛЕ того, как
 * карточка уже отрендерена, сам текст не менялся, хэш совпадал бы, и
 * устаревшая карточка НЕПРАВИЛЬНЫХ пропорций тихо продолжала бы
 * использоваться как референс для нового формата.
 *
 * `brandColor` (был в этом хэше) убран целиком следующим проходом
 * аудита — он был произвольным клиентским параметром без реального
 * источника данных (`BrandManifestSnapshot` не хранит цвет), а раз он
 * входил в хэш устаревания, это был вектор злоупотребления: перебор
 * цветов от клиента заставлял бы рендерить и заливать в Blob заново
 * при каждом вызове, в обход идемпотентности. См.
 * `ensure-text-cards-request.dto.ts` за полным объяснением.
 */
function textHash(
  moment: Pick<OnScreenTextMoment, 'text' | 'role'>,
  aspectRatio: string,
): string {
  return createHash('sha256')
    .update(`${moment.role}:${moment.text}:${aspectRatio}`)
    .digest('hex')
    .slice(0, 16);
}

@Injectable()
export class TextCardService {
  private readonly logger = new Logger(TextCardService.name);

  constructor(
    private readonly sessionService: SessionService,
    private readonly blob: BlobService,
  ) {}

  /**
   * Рендерит недостающие/устаревшие карточки для сессии и обновляет
   * `generationPrompt.onScreenTextMoments` их URL и хэшем. Best-effort
   * по каждой карточке отдельно — сбой одной не должен останавливать
   * рендер остальных (тот же принцип, что уже применён к
   * `extractLiteralTexts()`/`rewriteForGrokReferences()`).
   *
   * Идемпотентно: карточка с совпадающим `cardTextHash` не
   * перерендеривается — вызывать можно на каждое открытие экрана
   * кастинга, не только один раз.
   */
  async ensureTextCards(
    sessionId: string,
    aspectRatio: '9:16' | '16:9' | '1:1',
  ): Promise<OnScreenTextMoment[]> {
    const session = await this.sessionService.getSession(sessionId);
    const moments = session?.generationPrompt?.onScreenTextMoments;
    if (!session || !moments?.length) return [];

    const sorted = [...moments].sort(
      (a, b) => ROLE_PRIORITY[a.role] - ROLE_PRIORITY[b.role],
    );

    const updated: OnScreenTextMoment[] = [];
    for (const moment of sorted) {
      const hash = textHash(moment, aspectRatio);
      if (moment.cardUrl && moment.cardTextHash === hash) {
        // Уже отрендерена и текст/формат не менялись с тех пор — не
        // трогаем.
        updated.push(moment);
        continue;
      }
      try {
        const png = await renderTextCard({
          text: moment.text,
          role: moment.role,
          aspectRatio,
        });
        const pathname = `sessions/${sessionId}/text-card-${moment.role}.png`;
        const { url } = await this.blob.uploadBuffer(
          pathname,
          png,
          'image/png',
        );
        updated.push({
          ...moment,
          cardPathname: pathname,
          cardUrl: url,
          cardTextHash: hash,
        });
      } catch (error) {
        // Best-effort — карточка этой роли останется без cardUrl,
        // `reference-plan.ts` просто не включит её в кандидаты
        // (текст всё равно уйдёт словами в промпт, §20.6 ТЗ).
        this.logger.warn(
          `TextCardService: рендер карточки роли "${moment.role}" для сессии ${sessionId} не удался (${error instanceof Error ? error.message : String(error)}) — текст останется только словами в промпте`,
        );
        updated.push(moment);
      }
    }

    // Возвращаем в исходном порядке ролей, не в порядке приоритета
    // рендера — порядок в массиве не несёт смысла, только сами роли.
    const byRole = new Map(updated.map((m) => [m.role, m] as const));
    const result = moments.map((m) => byRole.get(m.role) ?? m);

    // Найдено при повторном аудите §20: рендер (satori + resvg + заливка
    // в Blob) для нескольких карточек может занять несколько секунд —
    // если пользователь за это время отредактировал промпт
    // (`updatePrompt()`), запись ниже СО СТАРЫМ снимком
    // `generationPrompt`, прочитанным в начале метода, победила бы
    // последней и стёрла бы правку целиком (`updateSession` сливает
    // верхнеуровневые ключи атомарно, но `generationPrompt` как
    // значение одного ключа заменяется целиком, не глубоким слиянием
    // вложенных полей — см. доккомментарий `updateSession`).
    // Перечитываем сессию непосредственно перед записью, чтобы взять
    // ЗА ОСНОВУ самый свежий `generationPrompt`, а не тот, что был в
    // начале — не устраняет гонку полностью (окно между этим чтением
    // и записью всё ещё есть), но сокращает его с «время всего рендера»
    // до «время одной записи в БД».
    const fresh = await this.sessionService.getSession(sessionId);
    if (!fresh?.generationPrompt) {
      // Сессия удалена или промпт исчез, пока рендерили — сохранять
      // некуда, но сами карточки уже отрендерены и в Blob, не потеряны.
      return result;
    }
    await this.sessionService.updateSession(sessionId, {
      generationPrompt: {
        ...fresh.generationPrompt,
        onScreenTextMoments: result,
      },
    });

    return result;
  }
}
