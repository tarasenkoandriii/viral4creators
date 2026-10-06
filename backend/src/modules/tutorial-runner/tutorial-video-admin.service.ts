/**
 * TutorialVideoAdminService — вкладка «Видео-контент»/«Состояние данных»
 * админки (doc/TMA-UI-SNAPSHOT-AND-TUTORIAL-VIDEO-SPEC.md §4.9, этап 99).
 * Тот же приём, что `TutorialScenarioAdminService`
 * (tutorial-scenario/tutorial-scenario-admin.service.ts): собственный
 * сервис/контроллер внутри фиче-модуля, читающая часть отдаёт «как в
 * базе», пишущая — только флаг `reviewed`, ничего не пересчитывает.
 *
 * Без `reviewed:true` собранное видео физически недоступно никому, кроме
 * прямого запроса к базе — ни консультанту (`AssistantService.
 * resolveVideoActions` фильтрует по этому же флагу), ни посетителю сайта.
 * Поэтому `setReviewed(id, true, ...)` — момент, когда видео становится
 * ЖИВЫМ для посетителей лендинга немедленно (см. предупреждение в
 * контроллере/фронтенде), а не «поставлено в очередь на публикацию».
 */
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { SUPPORTED_LOCALES, SupportedLocale } from '../../common/locale';
import { LandingVideosService } from '../client-site-media/landing-videos.service';
import { PlatformSettingsService } from '../../common/platform-settings.service';
import {
  APPROVAL_STAMPS_SETTING_KEY,
  recordApprovalStamp,
} from './tutorial-video-retention';
import {
  isSiteTutorialDemoKey,
  parseSiteTutorialDemoAssetIds,
  SITE_TUTORIAL_DEMO_ASSETS_SETTING_KEY,
  SITE_TUTORIAL_DEMO_MAX_MARKED,
} from '../tutorial-help/site-tutorial-demo';
import {
  ASSISTANT_KNOWLEDGE_BUILT_AT,
  ASSISTANT_KNOWLEDGE_COMMIT,
  ASSISTANT_STEPS,
} from '../../common/tutorial-knowledge/generated';

export interface TutorialVideoListFilter {
  subjectKey?: string;
  locale?: string;
  reviewed?: boolean;
  page: number;
  pageSize: number;
}

/** Джобы, относящиеся к этой подсистеме (генерация сценариев, этап 94, их
 * headless-исполнение + сборка видео, этап 97/98, и крон-обход
 * интерфейса Части А ТЗ, `ui-snapshot-run`, этап 100) — единственное
 * место, где этот короткий список держится как код для сводки «Состояние
 * данных» (§4.9). `ui-snapshot-run` добавлен здесь именно этапом 100 —
 * до этого его не было намеренно (показывать сводку по несуществующей
 * джобе значило бы либо врать нулями, либо путать оператора отсутствующей
 * строкой), см. `## Сделано (этап 99 — ...)` в
 * `PRODUCT-PROJECT-IMPLEMENTATION-PLAN.md`, где это было явно отложено. */
const RELEVANT_JOB_KEYS = [
  'tutorial-scenario-generate',
  'tutorial-scenario-run',
  // Добавлен 27.09.2026 (аудит): именно этот джоб теперь решает судьбу
  // сборок — суточный прогон их больше не подбирает в одиночку. Без
  // него сводка молчала бы ровно о том кроне, который и отвечает за
  // то, появится ли у человека ссылка на ролик.
  'tutorial-assembly-poll',
  'ui-snapshot-run',
] as const;

@Injectable()
export class TutorialVideoAdminService {
  private readonly logger = new Logger(TutorialVideoAdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    // Э-С Ш5: одобрение меняет и набор роликов сайта тенанта лендинга
    // (виджет платформы). Необязательный — тесты и окружение без
    // sites-backend работают как раньше.
    @Optional() private readonly landingVideos?: LandingVideosService,
    // Когда одобрен ролик (аудит кронов 06.10.2026): подметальщик
    // держит ПРЕДЫДУЩИЙ одобренный ещё сутки, пока кеши по дороге к
    // посетителю отдают его ссылку. Необязательный — без него
    // поведение прежнее (прежний одобренный уходит на ближайшем тике).
    @Optional() private readonly settings?: PlatformSettingsService,
  ) {}

  async list(filter: TutorialVideoListFilter) {
    const where = {
      subjectKey: filter.subjectKey || undefined,
      locale: filter.locale || undefined,
      reviewed: filter.reviewed,
      // Ролики обучалки по сайту ЗАКАЗЧИКА сюда не попадают (сквозной
      // аудит 29.09.2026).
      //
      // Они живут в той же таблице (`client-site-tutorial-admin.
      // service.ts` пишет `subjectKey: 'client-site'`, `locale: 'ru'`,
      // `title` — адрес сайта заказчика) и до этой строки показывались
      // вперемешку с десятью штатными шагами: тот же бейдж «готово»,
      // та же кнопка «Одобрить», то же подтверждение «видео станет
      // доступно посетителям». Нажатие делало `reviewed: true`, и
      // `AssistantService.availableVideoSubjectKeys` начинал предлагать
      // модели ключ `client-site` — то есть ролик по сайту одного
      // заказчика мог уехать любому посетителю лендинга.
      //
      // Одно неверное нажатие на экране, который ничем от него не
      // удерживает. Плюс `sweepOldAssets` такие строки намеренно не
      // трогает, значит они копятся здесь бессрочно и вероятность
      // промаха только растёт.
      //
      // У них своя витрина — «Черновики обучалок по сайту» — и своё
      // одобрение. Эта таблица про десять шагов обучалки продукта.
      clientSiteDraftId: null,
    };
    const [rows, total] = await Promise.all([
      this.prisma.tutorialVideoAsset.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        // Отпечаток сборки — служебный и тяжёлый (≈600 знаков на кадр с
        // 01.10.2026, до 24 КБ на ролик): админке он не нужен, а
        // страница в 100 строк весила бы мегабайты.
        omit: { contentHash: true },
        skip: (filter.page - 1) * filter.pageSize,
        take: filter.pageSize,
      }),
      this.prisma.tutorialVideoAsset.count({ where }),
    ]);
    return {
      rows,
      total,
      page: filter.page,
      pageSize: filter.pageSize,
      // Галочка «В демо обучающего лендинга» — по этому списку. Сбой
      // чтения — пустой список: список роликов важнее галочки.
      siteTutorialDemoAssetIds: await this.readSiteTutorialDemoIds().catch(
        () => [] as string[],
      ),
    };
  }

  private async readSiteTutorialDemoIds(): Promise<string[]> {
    if (!this.settings) return [];
    return parseSiteTutorialDemoAssetIds(
      await this.settings.get(SITE_TUTORIAL_DEMO_ASSETS_SETTING_KEY),
    );
  }

  /**
   * Галочка «В демо обучающего лендинга» — отметка оператора
   * `tutorial.siteTutorialDemoAssets` (JSON-массив id), по которой
   * публичная справка выдаёт ролики слотов `site-tutorial-demo-1..3`
   * (`tutorial-help/site-tutorial-demo.ts`).
   *
   * Отметить можно только строку, годную в публичное демо, — и это
   * проверяется ЗДЕСЬ, а не в разметке: ключ — ровно один из слотов
   * семейства, нет `clientSiteDraftId` (ролик сайта заказчика сюда не
   * попадает ни при каком нажатии), строка вычитана (`reviewed`) и
   * собрана (`blobUrl`). Снять отметку можно всегда — снятие ничего не
   * публикует.
   *
   * Значение настройки переписывается целиком: прочитали, поправили,
   * записали. Значение, которое не разбирается, при отметке НЕ
   * затирается молча — отказ с причиной: в нём могли быть отметки,
   * которые оператор не видит, и «починка» нажатием их бы потеряла.
   */
  async setSiteTutorialDemo(id: string, marked: boolean, by?: string) {
    if (!this.settings) {
      throw new BadRequestException(
        'Настройки платформы недоступны — отметку записать некуда',
      );
    }
    const row = (await this.prisma.tutorialVideoAsset.findUnique({
      where: { id },
    })) as {
      id: string;
      subjectKey: string;
      clientSiteDraftId?: string | null;
      reviewed?: boolean;
      blobUrl?: string | null;
    } | null;
    if (!row) throw new NotFoundException('Видео не найдено');
    if (marked) {
      if (row.clientSiteDraftId) {
        throw new BadRequestException(
          'Это ролик обучалки по сайту заказчика — в публичное демо он не попадает никогда',
        );
      }
      if (!isSiteTutorialDemoKey(row.subjectKey)) {
        throw new BadRequestException(
          `Ролик темы «${row.subjectKey}» — не из демо обучающего лендинга (site-tutorial-demo-1..3)`,
        );
      }
      if (!row.blobUrl) {
        throw new BadRequestException('Ролик ещё не собран — отмечать нечего');
      }
      if (!row.reviewed) {
        throw new BadRequestException(
          'Сначала одобрите ролик — в демо попадает только вычитанное',
        );
      }
    }
    const raw = await this.settings.get(SITE_TUTORIAL_DEMO_ASSETS_SETTING_KEY);
    const ids = parseSiteTutorialDemoAssetIds(raw);
    const trimmed = raw?.trim() ?? '';
    if (ids.length === 0 && trimmed !== '' && trimmed !== '[]') {
      throw new BadRequestException(
        `Настройка ${SITE_TUTORIAL_DEMO_ASSETS_SETTING_KEY} не разбирается — поправьте её в «Настройках» (JSON-массив id), отметка не записана`,
      );
    }
    const next = marked
      ? [...new Set([...ids, row.id])]
      : ids.filter((x) => x !== row.id);
    if (next.length > SITE_TUTORIAL_DEMO_MAX_MARKED) {
      throw new BadRequestException(
        `Отмечено уже ${ids.length} роликов — больше ${SITE_TUTORIAL_DEMO_MAX_MARKED} справка не примет; снимите лишние`,
      );
    }
    const changed =
      next.length !== ids.length || next.some((x, i) => x !== ids[i]);
    if (changed) {
      await this.settings.set(
        SITE_TUTORIAL_DEMO_ASSETS_SETTING_KEY,
        JSON.stringify(next),
        by,
      );
      this.logger.log(
        `ролик ${row.id} (${row.subjectKey}) ${marked ? 'отмечен' : 'снят'} в демо обучающего лендинга${by ? ` оператором ${by}` : ''}`,
      );
    }
    return { id: row.id, marked, siteTutorialDemoAssetIds: next };
  }

  /**
   * Переключает `reviewed` (§4.9 — «просмотр/одобрение»). Не одобрение
   * траты (в отличие от `TutorialScenarioAdminService.approve` — там
   * идемпотентно и необратимо), а публикационный флаг: оператор может
   * снять одобрение так же легко, как поставить (например, если после
   * публикации нашёлся брак в кадрах) — поэтому не идемпотентный
   * one-way, а обычная установка значения.
   */
  async setReviewed(id: string, reviewed: boolean) {
    const row = (await this.prisma.tutorialVideoAsset.findUnique({
      where: { id },
    })) as {
      clientSiteDraftId?: string | null;
      blobUrl?: string | null;
    } | null;
    if (!row) throw new NotFoundException('Видео не найдено');
    // Барьер И на самом действии, не только в выборке списка: прямой
    // вызов API мимо витрины отдал бы посетителям ролик по сайту
    // заказчика так же, как ошибочное нажатие.
    if (row.clientSiteDraftId) {
      throw new BadRequestException(
        'Это ролик обучалки по сайту заказчика — он одобряется на своей вкладке и посетителям лендинга не выдаётся',
      );
    }
    // Одобрить можно только СОБРАННЫЙ ролик (сквозной аудит
    // 29.09.2026). Барьер стоял только в разметке
    // (`disabled={!row.blobUrl}`), то есть прямой вызов API одобрял
    // строку в `preparing`. Консультант её потом отсеет по `blobUrl` —
    // но в админке она числилась бы одобренной и попадала бы в сводку
    // «Состояние данных», которая по `blobUrl` не фильтрует. Оператор
    // видел бы покрытие, которого нет.
    if (reviewed && !row.blobUrl) {
      throw new BadRequestException('Ролик ещё не собран — одобрять нечего');
    }
    const updated = await this.prisma.tutorialVideoAsset.update({
      where: { id },
      data: { reviewed },
    });
    if (reviewed) await this.stampApproval(id);
    // Набор роликов лендинга в тенанте — тем же барьером (clientSiteDraftId
    // уже отсеян выше). Не ждём сети и не роняем одобрение: сбой — в лог,
    // следующее одобрение пришлёт набор целиком.
    if (this.landingVideos) {
      void this.landingVideos
        .sync()
        .catch((e: unknown) =>
          this.logger.warn(
            `ролики лендинга после одобрения не отправлены: ${e instanceof Error ? e.name : 'error'}`,
          ),
        );
    }
    return updated;
  }

  /**
   * Отметка «одобрен тогда-то» в карте `APPROVAL_STAMPS_SETTING_KEY`.
   * Не бросает: одобрение уже записано, а без отметки худшее — прежний
   * одобренный ролик уйдёт на ближайшем тике подметальщика, как до
   * правки.
   */
  private async stampApproval(id: string): Promise<void> {
    if (!this.settings) return;
    try {
      const raw = await this.settings.get(APPROVAL_STAMPS_SETTING_KEY);
      await this.settings.set(
        APPROVAL_STAMPS_SETTING_KEY,
        recordApprovalStamp(raw, id, Date.now()),
      );
    } catch (e) {
      this.logger.warn(
        `отметка одобрения ролика ${id} не записана (${
          e instanceof Error ? e.message : String(e)
        }) — прежний одобренный ролик пары подметётся без суточной отсрочки`,
      );
    }
  }

  /** «Состояние данных» (§4.9) — агрегированная сводка, без фильтров. */
  async dataStatus() {
    const stepCounts: Record<string, number> = {};
    for (const locale of SUPPORTED_LOCALES) {
      stepCounts[locale] = ASSISTANT_STEPS[locale]?.length ?? 0;
    }

    const [coverageGroups, lastRuns] = await Promise.all([
      this.prisma.tutorialVideoAsset.groupBy({
        by: ['subjectKey', 'locale'],
        where: { reviewed: true },
        _count: { _all: true },
      }),
      Promise.all(
        RELEVANT_JOB_KEYS.map((jobKey) =>
          this.prisma.cronRunLog.findFirst({
            where: { jobKey },
            orderBy: { startedAt: 'desc' },
          }),
        ),
      ),
    ]);

    const videoCoverage = coverageGroups.map((g) => ({
      subjectKey: g.subjectKey,
      locale: g.locale as SupportedLocale,
      reviewedCount: g._count._all,
    }));

    return {
      knowledge: {
        builtAt: ASSISTANT_KNOWLEDGE_BUILT_AT,
        commit: ASSISTANT_KNOWLEDGE_COMMIT,
      },
      stepCounts,
      videoCoverage,
      lastRuns: RELEVANT_JOB_KEYS.map((jobKey, i) => {
        const run = lastRuns[i];
        return {
          jobKey,
          status: run?.status ?? null,
          startedAt: run?.startedAt ?? null,
          finishedAt: run?.finishedAt ?? null,
          summary: run?.summary ?? null,
          errorMessage: run?.errorMessage ?? null,
        };
      }),
    };
  }
}
