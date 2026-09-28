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
import { draftFramePathname } from './draft-frames';

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
}

interface DraftRow {
  id: string;
  projectId: string;
  baseUrl: string;
  title: string | null;
  status: DraftStatus;
  steps: unknown;
  stepsPerRound: number[];
  previewFrameCount: number | null;
  requiresLiveLoginReplay: boolean;
  rejectionReason: string | null;
  credentialsEnc: string | null;
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class ClientSiteTutorialAdminService {
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
    const count = row.previewFrameCount ?? 0;
    const frameUrls: string[] = [];
    for (let i = 0; i < count; i++) {
      try {
        frameUrls.push(await this.blob.getPublicUrl(draftFramePathname(id, i)));
      } catch {
        this.logger.warn(`черновик ${id}: кадр ${i} не найден в хранилище`);
      }
    }
    return {
      ...toQueueItem(row),
      steps: (row.steps as ScenarioStep[] | null) ?? [],
      frameUrls,
      hasCredentials: row.credentialsEnc !== null,
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
      await this.submitAssembly(row, frames, approvedBy);
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
    return toQueueItem(await this.require(id));
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
    approvedBy: string,
  ): Promise<void> {
    if (!this.ffmpeg.configured()) {
      throw new ServiceUnavailableException(
        'сборка видео не настроена на этом стенде (FFMPEG_API_KEY) — одобрять нечего собирать',
      );
    }

    const frameUrls: string[] = [];
    for (let i = 0; i < frames; i++) {
      frameUrls.push(
        await this.blob.getPublicUrl(draftFramePathname(row.id, i)),
      );
    }
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
        // строки обещала «вместе с кадрами» — неправда вдвойне:
        // подметальщик ходит по `tutorial-video-frames/{id актива}/`,
        // а кадры черновика лежат под его собственным префиксом
        // (`draft-frames.ts`), то есть стирался бы пустой префикс
        // (находка повторного сквозного аудита A+B+C).
        assemblyStatus: 'preparing',
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
