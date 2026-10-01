/**
 * Модерация черновиков обучалки по сайту заказчика — §5.2 (админские
 * эндпоинты) и §8.3 ТЗ (doc/CLIENT-SITE-TUTORIAL-SPEC.md), этап 113.
 *
 * ## Зачем вообще одобрение, если пользователь всё сделал сам
 *
 * §8.3 называет две причины, и обе появляются именно ИЗ-ЗА
 * self-service. Первая: пользователь мог записать шаг, который на сайте
 * заказчика делает необратимое — оформит настоящий заказ, отправит
 * письмо, — и видео с этим шагом не должно молча уйти в публикацию.
 * Вторая: в кадре чужой сайт, то есть чужой брендинг и чужие данные, а
 * решение «показываем это от имени продукта» по-прежнему решение
 * оператора. Тот же барьер, что уже стоит на штатной обучалке.
 *
 * ## Почему сборку видео запускает ИМЕННО одобрение
 *
 * `/finish` только замораживает черновик и заливает УЖЕ снятые кадры в
 * Blob — это дёшево, просто перекладывание готовых JPEG. Настоящая
 * сборка через внешний ffmpeg-api — самый дорогой шаг всего конвейера,
 * и запускать её до того, как человек посмотрел на кадры, значит
 * платить за право посмотреть. Поэтому шаги разведены: смотреть можно
 * бесплатно, собирать — только после «да» (§14 п.2).
 *
 * Собирается ролик из тех же кадров, что видели пользователь и
 * оператор, а не из свежего обхода сайта: дешевле, детерминированнее и
 * честнее — сайт заказчика мог за это время измениться.
 */

import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { BlobService } from '../storage/blob.service';
import { FfmpegApiService } from '../postprod/ffmpeg-api.service';
import { AiUsageService } from '../ai-usage/ai-usage.service';
import {
  planSlideshow,
  uniformFrames,
} from '../tutorial-runner/tutorial-video-assembly';
import { ScenarioStep } from '../tutorial-scenario/scenario-steps.types';
import { DraftStatus } from './draft-rounds';
import { draftFramePrefix, orderedFramePathnames } from './draft-frames';
import { createHash } from 'node:crypto';
import { alignRoundWarnings } from './client-site-tutorial.service';

/**
 * Потолок провалившихся сборок ОДНОГО И ТОГО ЖЕ содержимого черновика
 * (QA TMA §12, перенос 01.10.2026). То же число, что
 * `MAX_ASSEMBLY_ATTEMPTS` у ночной обучалки
 * (`tutorial-scenario-runner.service.ts`), но своя константа: та не
 * экспортируется, а этот путь живёт по кнопке оператора, не по
 * расписанию, и однажды может захотеть другое число.
 *
 * Зачем он здесь, где цикла по расписанию нет. Провал сборки
 * возвращает черновик на одобрение (`releaseClientSiteDraft` в
 * раннере), и кнопка «Одобрить» снова активна — с теми же кадрами.
 * Кадр, на котором внешний сервис спотыкается стабильно, превращал
 * каждое нажатие в оплаченную задачу, которая упадёт, а строки
 * `failed` копились без счёта.
 */
export const MAX_ASSEMBLY_ATTEMPTS = 3;

/**
 * Потолок ожидания одного кадра при одобрении. Оператор ждёт ответа
 * кнопки, а зависший запрос к хранилищу без потолка держал бы её до
 * таймаута функции. `downloadBuffer` сигнала отмены не принимает
 * (`BlobService` — общий сервис), поэтому это ограничение ОЖИДАНИЯ,
 * а не самого запроса: зависший fetch доживёт своё в фоне, но
 * одобрение откажет вовремя и с именем кадра.
 */
export const FRAME_DOWNLOAD_TIMEOUT_MS = 15_000;

function withTimeout<T>(
  work: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

export interface DraftQueueItem {
  id: string;
  projectId: string;
  baseUrl: string;
  title: string | null;
  status: DraftStatus;
  stepCount: number;
  roundCount: number;
  previewFrameCount: number | null;
  requiresLiveLoginReplay: boolean;
  rejectionReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface DraftDetails extends DraftQueueItem {
  steps: ScenarioStep[];
  /** Прямые ссылки на кадры предпросмотра в Blob — та же серия, что
   * пользователь видел на своём экране. Без них оператор одобрял бы
   * вслепую, а предпросмотр терял бы половину смысла (§5.2). */
  frameUrls: string[];
  hasCredentials: boolean;
  /** Сколько шагов дописал каждый раунд — один раунд = один кадр.
   * Без этого оператор сопоставлял «кадр ↔ шаги» на глаз, а раунд
   * бывает и из нескольких `fill` с одним `click` (перенос QA TMA §12). */
  stepsPerRound: number[];
  /** Предупреждение стоп-листа §8.3 по каждому раунду (`null` — не
   * было), длина = `stepsPerRound.length`. */
  roundDangerWarnings: (string | null)[];
}

interface DraftRow {
  id: string;
  projectId: string;
  baseUrl: string;
  title: string | null;
  status: DraftStatus;
  steps: unknown;
  stepsPerRound: number[];
  roundDangerWarnings?: unknown;
  previewFrameCount: number | null;
  requiresLiveLoginReplay: boolean;
  rejectionReason: string | null;
  credentialsEnc: string | null;
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class ClientSiteTutorialAdminService {
  /**
   * Имена итоговых кадров черновика — из хранилища, а не из счётчика в
   * строке: расширение следует за содержимым кадра (PNG у съёмочного,
   * JPEG у предпросмотрового), и собрать имя по номеру больше нельзя.
   * Страницы листинга проходим до конца — у черновика кадров немного,
   * но обрывать список на первой странице значило бы молча потерять
   * хвост ролика.
   */
  private async framePathnames(draftId: string): Promise<string[]> {
    const prefix = draftFramePrefix(draftId);
    const names: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.blob.listByPrefix(prefix, { cursor });
      names.push(...page.blobs.map((b) => b.pathname));
      cursor = page.cursor ?? undefined;
    } while (cursor);
    return orderedFramePathnames(draftId, names);
  }

  private readonly logger = new Logger(ClientSiteTutorialAdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly blob: BlobService,
    private readonly ffmpeg: FfmpegApiService,
    private readonly aiUsage: AiUsageService,
  ) {}

  async list(params: {
    status?: DraftStatus;
    page: number;
    pageSize: number;
  }): Promise<{
    items: DraftQueueItem[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    const where = params.status ? { status: params.status } : {};
    const [rows, total] = await Promise.all([
      this.prisma.clientSiteTutorialDraft.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        skip: (params.page - 1) * params.pageSize,
        take: params.pageSize,
      }) as Promise<DraftRow[]>,
      this.prisma.clientSiteTutorialDraft.count({ where }) as Promise<number>,
    ]);
    return {
      items: rows.map((r) => toQueueItem(r)),
      total,
      page: params.page,
      pageSize: params.pageSize,
    };
  }

  async details(id: string): Promise<DraftDetails> {
    const row = await this.require(id);
    // Пропавший кадр не должен ронять карточку целиком (аудит этапа
    // 116): `getPublicUrl` бросает, если файла нет, а счётчик в строке
    // мог разойтись с хранилищем — например, после оборвавшегося
    // повторного `/finish`. Оператору важнее увидеть шаги и решить, чем
    // получить 500 на всю заявку.
    const frameUrls: string[] = [];
    for (const pathname of await this.framePathnames(id)) {
      try {
        frameUrls.push(await this.blob.getPublicUrl(pathname));
      } catch {
        this.logger.warn(
          `черновик ${id}: кадр ${pathname} не найден в хранилище`,
        );
      }
    }
    return {
      ...toQueueItem(row),
      steps: (row.steps as ScenarioStep[] | null) ?? [],
      frameUrls,
      hasCredentials: row.credentialsEnc !== null,
      stepsPerRound: row.stepsPerRound,
      roundDangerWarnings: alignRoundWarnings(
        row.roundDangerWarnings,
        row.stepsPerRound.length,
      ),
    };
  }

  /**
   * Одобрение: статус → APPROVED и отправка слайд-шоу на сборку.
   *
   * Строка `TutorialVideoAsset` заводится с `clientSiteDraftId` (§6.2 —
   * мягкая ссылка, не Prisma-связь) и `assemblyStatus: 'preparing'`, а
   * в `pending` переводится только после того, как `submit` вернул
   * `jobId` (см. `submitAssembly` ниже — там и записано, почему
   * именно так). Дальше её подхватывает УЖЕ СУЩЕСТВУЮЩИЙ опрос
   * сборок в крон-джобе обучалки: он ищет все `pending` без разбора,
   * кем они заведены. Второй воркер специально под этот вид проекта
   * не нужен.
   */
  async approve(id: string, approvedBy: string): Promise<DraftQueueItem> {
    const row = await this.require(id);
    if (row.status !== 'PENDING_REVIEW') {
      throw new ConflictException(
        'одобрить можно только черновик, отправленный на проверку',
      );
    }
    const frames = row.previewFrameCount ?? 0;
    if (frames === 0) {
      throw new BadRequestException(
        'у черновика нет залитых кадров — собирать нечего',
      );
    }

    // Дешёвые отказы — до скачивания кадров (аудит 01.10.2026): на
    // стенде без ffmpeg-api незачем тянуть все кадры из хранилища, чтобы
    // потом сказать «собирать нечем». Раньше эта проверка жила в
    // `submitAssembly`, уже после захвата статуса, и отказ приходилось
    // откатывать.
    if (!this.ffmpeg.configured()) {
      throw new ServiceUnavailableException(
        'сборка видео не настроена на этом стенде (FFMPEG_API_KEY) — одобрять нечего собирать',
      );
    }

    // Кадры и их отпечаток — ДО смены статуса: потолок попыток ниже
    // обязан отказать, не трогая черновик, иначе отказ пришлось бы
    // откатывать так же, как неудачную отправку.
    const prepared = await this.prepareFrames(row.id);
    // Число кадров в хранилище обязано совпасть с тем, что `/finish`
    // записал в строку. Не совпало — какой-то кадр пропал (или лишний
    // остался от чужого прогона), и сборка дала бы молча короткий или
    // перемешанный ролик, который оператор одобрил, глядя на другой.
    if (prepared.frameUrls.length !== frames) {
      throw new BadRequestException(
        `в хранилище ${prepared.frameUrls.length} кадр(ов), а при завершении записи было ${frames} — ролик вышел бы не тем, что вы видите. Отклоните черновик, чтобы пользователь заново нажал «Готово»`,
      );
    }
    const failedSame = await this.prisma.tutorialVideoAsset.count({
      where: {
        clientSiteDraftId: row.id,
        assemblyStatus: 'failed',
        contentHash: prepared.contentHash,
      },
    });
    if (failedSame >= MAX_ASSEMBLY_ATTEMPTS) {
      throw new BadRequestException(
        `сборка ролика из этих же кадров уже проваливалась ${failedSame} раз(а) — повтор оплатит ещё одну неудачу. Отклоните черновик с причиной: после правки шагов кадры изменятся, и счёт попыток начнётся заново`,
      );
    }

    // Статус меняется ПЕРВЫМ и условно: два оператора, нажавшие
    // «Одобрить» одновременно, не должны отправить две задачи сборки за
    // одни и те же деньги.
    const claim = await this.prisma.clientSiteTutorialDraft.updateMany({
      where: { id, status: 'PENDING_REVIEW' },
      data: { status: 'APPROVED', rejectionReason: null },
    });
    if (claim.count === 0) {
      throw new ConflictException('черновик уже обработан другим оператором');
    }

    try {
      await this.submitAssembly(row, frames, prepared, approvedBy);
    } catch (err) {
      // Одобрение ОТКАТЫВАЕТСЯ, если сборку отправить не удалось (аудит
      // этапа 116). Раньше неудача была best-effort: статус оставался
      // APPROVED, а из него нет выхода ни у кого — `approve`/`reject`
      // требуют PENDING_REVIEW, пользовательский `resume` требует
      // REJECTED, редактировать APPROVED нельзя. Оператор получал
      // «готово», ролика не было, и единственным ходом оставалось
      // удалить черновик и переписать сценарий с нуля. Возврат в
      // PENDING_REVIEW стоит одного запроса и оставляет кнопку
      // «Одобрить» рабочей.
      await this.prisma.clientSiteTutorialDraft
        .updateMany({
          where: { id, status: 'APPROVED' },
          data: { status: 'PENDING_REVIEW' },
        })
        .catch(() => undefined);
      throw err;
    }
    await this.pruneFailedAssets(row.id);
    return toQueueItem(await this.require(id));
  }

  /**
   * Ссылки на итоговые кадры и ТОЧНЫЙ отпечаток их байтов — для
   * `contentHash` строки ролика и потолка попыток.
   *
   * Точный sha, а не перцептивное сличение, как у ночной обучалки:
   * там кадры каждую ночь снимаются заново и побайтово не повторяются,
   * а здесь это одни и те же файлы в Blob, пока пользователь не
   * перезапишет черновик. Совпадение байтов здесь и есть «то же
   * содержимое», без порогов, которые пришлось бы настраивать.
   *
   * Голый hex — формат, который `sameSlideshowContent` понимает как
   * старый, если строка когда-нибудь попадёт в общее сличение.
   */
  private async prepareFrames(
    draftId: string,
  ): Promise<{ frameUrls: string[]; contentHash: string }> {
    const frameUrls: string[] = [];
    const whole = createHash('sha256');
    for (const pathname of await this.framePathnames(draftId)) {
      let bytes: Buffer;
      try {
        bytes = await withTimeout(
          this.blob.downloadBuffer(pathname),
          FRAME_DOWNLOAD_TIMEOUT_MS,
          `скачивание дольше ${FRAME_DOWNLOAD_TIMEOUT_MS} мс`,
        );
      } catch (err) {
        // Кадр, который мы не можем прочитать, не прочитает и внешний
        // ffmpeg-api — отправлять такую задачу значит заплатить за
        // провал. Называем, какой именно кадр.
        this.logger.warn(
          `черновик ${draftId}: кадр ${pathname} не читается (${err instanceof Error ? err.message : String(err)})`,
        );
        throw new ServiceUnavailableException(
          `кадр ${pathname.split('/').pop()} не читается из хранилища — попросите пользователя повторить «Готово» или отклоните черновик`,
        );
      }
      whole.update(createHash('sha256').update(bytes).digest('hex'));
      whole.update(',');
      frameUrls.push(await this.blob.getPublicUrl(pathname));
    }
    return { frameUrls, contentHash: whole.digest('hex') };
  }

  /**
   * Строки `failed` черновика не копятся вечно: держим
   * `MAX_ASSEMBLY_ATTEMPTS` последних — ровно столько, сколько нужно
   * потолку попыток выше. Ночная метла (`sweepOldAssets`) роликов
   * черновиков сознательно не трогает, так что убирать их больше
   * некому.
   *
   * Только строки без файла: у `failed` бывает частичный mp4 прошлой
   * попытки, и удалить строку раньше файла значило бы потерять путь к
   * нему навсегда. Таких единицы, а уборка — best-effort: одобрение уже
   * состоялось, и сбой здесь не повод его ронять.
   */
  private async pruneFailedAssets(draftId: string): Promise<void> {
    try {
      const stale = (await this.prisma.tutorialVideoAsset.findMany({
        where: { clientSiteDraftId: draftId, assemblyStatus: 'failed' },
        orderBy: { createdAt: 'desc' },
        skip: MAX_ASSEMBLY_ATTEMPTS,
        select: { id: true, blobUrl: true },
      })) as { id: string; blobUrl: string | null }[];
      const ids = stale.filter((r) => !r.blobUrl).map((r) => r.id);
      if (ids.length === 0) return;
      await this.prisma.tutorialVideoAsset.deleteMany({
        where: { id: { in: ids }, assemblyStatus: 'failed' },
      });
    } catch (err) {
      this.logger.warn(
        `черновик ${draftId}: старые провалы сборки не убраны (${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }

  async reject(id: string, reason: string): Promise<DraftQueueItem> {
    const row = await this.require(id);
    if (row.status !== 'PENDING_REVIEW') {
      throw new ConflictException(
        'отклонить можно только черновик, отправленный на проверку',
      );
    }
    const claim = await this.prisma.clientSiteTutorialDraft.updateMany({
      where: { id, status: 'PENDING_REVIEW' },
      data: { status: 'REJECTED', rejectionReason: reason.trim() },
    });
    if (claim.count === 0) {
      throw new ConflictException('черновик уже обработан другим оператором');
    }
    // Кадры НЕ стираются: пользователь может вернуть черновик в работу
    // (`POST .../resume`) и дописать сценарий, а повторный `/finish`
    // перезальёт префикс целиком.
    return toQueueItem(await this.require(id));
  }

  /**
   * Отправка слайд-шоу на сборку. Бросает наружу — вызывающий откатит
   * одобрение (см. `approve`).
   *
   * Порядок «строка → задача → запись jobId» тоже не произволен (аудит
   * этапа 116). Если сначала отправить задачу, а потом не суметь
   * записать строку, деньги за сборку уже потрачены, а `assemblyJobId`
   * не сохранён — результат не подберёт никто, задача оплачена впустую
   * и невидима.
   *
   * Но строка заводится в статусе `preparing`, а не `pending` — это
   * правка сквозного аудита A+B+C, и без неё порядок выше сам
   * приводил к потере денег. Опрос сборок ходит каждые две минуты и
   * выбирает `pending`: попав в окно между `create` и записью
   * `assemblyJobId`, он видел строку без задачи, помечал её
   * провалившейся и возвращал черновик на одобрение. Оператор
   * одобрял снова — и платил второй раз за ту же сборку, первая из
   * которых к тому моменту уже выполнялась. `preparing` опрос не
   * выбирает; зависшую строку через десять минут подметает
   * `abandonStalePreparing`.
   */
  private async submitAssembly(
    row: DraftRow,
    frames: number,
    prepared: { frameUrls: string[]; contentHash: string },
    approvedBy: string,
  ): Promise<void> {
    const { frameUrls, contentHash } = prepared;
    // `uniformFrames` — все кадры по `SECONDS_PER_FRAME`, то же
    // поведение, что до этапа A ТЗ `TZ-Tutorial-Video-Voiced.md`.
    // Без движения — явно, а не умолчанием: §8 того же ТЗ этот путь
    // не трогает, и переключатель движения на витрине к нему не
    // относится (этап G). У обучалки по сайту заказчика своя логика
    // одобрения, и менять её картинку оператор ночной обучалки не
    // должен.
    const plan = planSlideshow(uniformFrames(frameUrls), { motion: 'none' });
    if (!plan) {
      throw new BadRequestException(
        `${frames} кадров не годятся для сборки: их либо нет, либо больше потолка слайд-шоу, либо у кадра неположительная длительность`,
      );
    }

    const asset = (await this.prisma.tutorialVideoAsset.create({
      data: {
        // `subjectKey` у штатной обучалки — шаг воркфлоу НАШЕГО
        // продукта; здесь такого понятия нет, поэтому ключ —
        // служебный и одинаковый для всего вида, а настоящая привязка
        // идёт через `clientSiteDraftId` (§6.2).
        subjectKey: 'client-site',
        locale: 'ru',
        title: row.title ?? row.baseUrl,
        clientSiteDraftId: row.id,
        frameCount: frames,
        // `preparing`, а НЕ `pending` — как на сценарном пути.
        // Опрос сборок выбирает только `pending`, и до этой правки
        // он мог вклиниться в окно между `create` и записью
        // `assemblyJobId`: увидел бы строку без задачи, пометил бы
        // её `failed` и вернул бы черновик в `PENDING_REVIEW`. Задача
        // при этом уже отправлена и оплачена, результат подобрать
        // некому, а оператор видит «сборка не удалась» и одобряет
        // повторно — платим второй раз. Прежний доккомментарий выше
        // взвешивал только случай «submit бросил» и этот не
        // рассматривал (находка сквозного аудита A+B+C).
        //
        // Зависшую `preparing` через десять минут снимает
        // `abandonStalePreparing` и возвращает черновик на
        // одобрение. Кадры при этом остаются, и это правильно: у
        // обучалки по сайту заказчика они не транзит, а ПРЕДПРОСМОТР,
        // который видят оператор и пользователь, и живут они до
        // удаления черновика (§5.2 `DELETE`). Прежняя редакция этой
        // строки обещала «вместе с кадрами» — неправда: стирался бы
        // пустой префикс (находка повторного сквозного аудита A+B+C).
        //
        // ВНИМАНИЕ. Следующая редакция этого же абзаца говорила, что
        // «кадры черновика лежат под его собственным префиксом», и
        // читалась как «под ДРУГИМ префиксом». Это неверно, и ошибка
        // стоила удалённых кадров (аудит 29.09.2026): верхний префикс
        // ОБЩИЙ — `tutorial-video-frames/`, — различаются владельцы
        // внутри него (`{assetId}` у роликов мастера, `{draftId}`
        // здесь, см. `draft-frames.ts`). Метла осиротевших файлов
        // ходит по общему префиксу и обязана знать обоих владельцев;
        // первая её редакция знала одного и сносила кадры ЖИВЫХ
        // черновиков.
        assemblyStatus: 'preparing',
        // Точный отпечаток кадров — по нему `approve` считает провалы
        // того же содержимого (`MAX_ASSEMBLY_ATTEMPTS`).
        contentHash,
        // Из плана, а не произведением у писателя — см. `durationMs`
        // в `SlideshowPlan` (этап A).
        durationMs: plan.durationMs,
      },
    })) as { id: string };

    // Владелец расхода — хозяин проекта, а не оператор, нажавший
    // «Одобрить»: платит за сборку продукт по заказу этого клиента.
    //
    // Ищется ДО `submit`, и это правка повторного сквозного аудита
    // A+B+C. Между `submit` и записью `assemblyJobId` нельзя класть
    // ничего, что может бросить (см. доккомментарий метода): задача
    // уже оплачена, а без `jobId` её результат не подберёт никто —
    // `abandonStalePreparing` через десять минут вернёт черновик на
    // одобрение, оператор одобрит снова, и мы заплатим второй раз.
    // Первая редакция этой правки ставила запрос ровно туда.
    const owner = (await this.prisma.project.findUnique({
      where: { id: row.projectId },
      select: { userId: true },
    })) as { userId: string } | null;
    if (!owner) {
      // Строка расхода без владельца считается АНОНИМНОЙ и выбирает
      // общий суточный потолок анонимных посетителей (≈$5) — то
      // самое, от чего эта правка и уводит. Проект у черновика
      // обязателен по схеме, так что это «не бывает»; но «не бывает»
      // молча — это и есть способ вернуть себе тот же потолок.
      throw new ServiceUnavailableException(
        `проект ${row.projectId} черновика ${row.id} не найден — расход за сборку записать не на кого`,
      );
    }

    const job = await this.ffmpeg.submit({
      inputs: plan.inputs,
      outputs: plan.outputs,
      commands: plan.commands,
    });

    // Расход за сборку. До сквозного аудита A+B+C он не писался ни
    // здесь, ни на сценарном пути: одобрение черновика стоило денег
    // молча, и в отчёте расходов обучалки по сайту заказчика не было
    // ни строки. Пишем сразу после отправки: деньги списываются за
    // приём задачи, а не за её результат. `record` наружу не бросает
    // (внутри свой `catch`), поэтому окно до записи `assemblyJobId`
    // она не удлиняет.
    await this.aiUsage.record({
      operation: 'tutorial-video-assembly',
      model: 'ffmpeg-api',
      userId: owner.userId,
    });

    await this.prisma.tutorialVideoAsset.update({
      where: { id: asset.id },
      data: {
        assemblyStatus: 'pending',
        assemblyJobId: job.jobId,
        assemblyStartedAt: new Date(),
      },
    });

    this.logger.log(
      `черновик ${row.id} одобрен (${approvedBy}), слайд-шоу отправлено на сборку (задача ${job.jobId}, ${frames} кадров)`,
    );
  }

  private async require(id: string): Promise<DraftRow> {
    const row = (await this.prisma.clientSiteTutorialDraft.findUnique({
      where: { id },
    })) as DraftRow | null;
    if (!row) throw new NotFoundException(`черновик ${id} не найден`);
    return row;
  }
}

function toQueueItem(row: DraftRow): DraftQueueItem {
  const steps = (row.steps as ScenarioStep[] | null) ?? [];
  return {
    id: row.id,
    projectId: row.projectId,
    baseUrl: row.baseUrl,
    title: row.title,
    status: row.status,
    stepCount: steps.length,
    roundCount: row.stepsPerRound.length,
    previewFrameCount: row.previewFrameCount,
    requiresLiveLoginReplay: row.requiresLiveLoginReplay,
    rejectionReason: row.rejectionReason,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
