import { Prisma } from '@prisma/client';
import { storyAudioReservation } from './story-budget';
import {
  normalizeStoryPhotoDescription,
  prepareStoryDraft,
  previewStoryDraft,
  storedStoryEstimate,
  type StoryDraftInput,
  type StoryPreviewOptions,
} from './story-draft'; // WP3
import { storyOccasionTheme } from './story-occasion'; // WP3
import { SonioxSttClient } from '../voice/soniox-stt.client';
import { storySpeechScore } from './story-audio-qa';
import { normalizeStoryPhoto } from './story-photo';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { ResembleService } from '../tts/resemble.service';
import { PlanService } from '../plan/plan.service';
import { AiUsageService } from '../ai-usage/ai-usage.service';
import { STORY_CATALOG, STORY_VOICE, storyText } from './story-catalog';

const digest = (v: string | Uint8Array) =>
  createHash('sha256').update(v).digest('hex');
/**
 * Render media/voice wipe shared by owner deletion and retention (WP1).
 *
 * Retention of a single render on a live gift (F1, A-S2-1/A-S2-2):
 * - `release` renames the (gift, config) slot to `<hash>:purged:<id>` so the
 *   same configuration can be ordered again instead of returning DELETED;
 * - `keepNarrationKey` keeps `parentNarrationKey` when the parent main
 *   narration was never saved: an unconfirmed (maybe billed) main synthesis
 *   stays blocked until an operator confirms, it is never re-bought silently.
 */
export function storyRenderWipe(
  opts: {
    release?: { id: string; configHash: string };
    keepNarrationKey?: boolean;
  } = {},
): Prisma.StoryVideoRenderUpdateManyMutationInput {
  const { parentNarrationKey, ...rest } = storyRenderWipeData();
  return {
    ...rest,
    ...(opts.keepNarrationKey ? {} : { parentNarrationKey }),
    ...(opts.release
      ? {
          configHash: `${opts.release.configHash}:purged:${opts.release.id}`,
        }
      : {}),
  };
}
function storyRenderWipeData() {
  return {
    status: 'DELETED',
    video: null,
    videoHash: null,
    preambleAudio: null,
    mainAudio: null,
    voiceConsentAt: null,
    voiceConsentVersion: null,
    userVoiceId: null,
    narratorManifestId: null,
    preambleText: '',
    voiceId: '',
    voiceLabel: null,
    parentNarrationKey: null,
    mainAudioHash: '',
    mainDuration: null,
    assetExpiresAt: null,
    approvedAt: null,
    assetTokenHash: null,
    qa: Prisma.DbNull,
    segments: Prisma.DbNull, // WP4: segment texts/hashes
  } satisfies Prisma.StoryVideoRenderUpdateManyMutationInput;
}
const summary = {
  id: true,
  audioQaStatus: true,
  locale: true,
  countryCode: true,
  budgetCents: true,
  reservedMicroUsd: true,
  audioQa: true,
  hasGiftPhoto: true,
  title: true,
  chapters: true,
  catalogId: true,
  occasion: true,
  occasionKind: true, // WP3
  occasionTheme: true,
  giftNoteEnabled: true,
  giftPhotoDescription: true,
  narrationLayout: true,
  giftNote: true,
  giftNotePosition: true,
  status: true,
  voiceId: true,
  durationSeconds: true,
  textHash: true,
  audioHash: true,
  error: true,
  approvedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;
@Injectable()
export class StoryGiftsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tts: ResembleService,
    private readonly plan: PlanService,
    private readonly usage: AiUsageService,
    private readonly stt: SonioxSttClient,
  ) {
    this.stt.attemptDeadlineMs = 90_000;
  }
  catalog() {
    return STORY_CATALOG.map((s) => ({
      ...s,
      audioReserveUsd: storyAudioReservation(storyText(s.id)) / 1e6,
    }));
  }
  async own(userId: string, id: string) {
    const row = await this.prisma.storyGift.findFirst({
      where: { id, userId, status: { not: 'DELETED' } },
      select: summary,
    });
    if (!row) throw new NotFoundException('Сказка не найдена');
    if (
      row.status === 'SYNTHESIZING' &&
      row.updatedAt &&
      Date.now() - row.updatedAt.getTime() > 10 * 60 * 1000
    ) {
      await this.prisma.storyGift.updateMany({
        where: { id, userId, status: 'SYNTHESIZING', updatedAt: row.updatedAt },
        data: {
          status: 'UNKNOWN',
          error:
            'Ожидание результата истекло. Автоматический повтор отключён; нужна проверка оператором.',
        },
      });
      return this.prisma.storyGift.findFirstOrThrow({
        where: { id, userId, status: { not: 'DELETED' } },
        select: summary,
      });
    }
    if (
      row.audioQaStatus === 'RUNNING' &&
      row.updatedAt &&
      Date.now() - row.updatedAt.getTime() > 10 * 60 * 1000
    ) {
      await this.prisma.storyGift.updateMany({
        where: {
          id,
          userId,
          audioQaStatus: 'RUNNING',
          updatedAt: row.updatedAt,
        },
        data: { audioQaStatus: 'UNKNOWN' },
      });
      return this.prisma.storyGift.findFirstOrThrow({
        where: { id, userId, status: { not: 'DELETED' } },
        select: summary,
      });
    }
    return row;
  }
  list(userId: string) {
    return this.prisma.storyGift.findMany({
      where: { userId, status: { not: 'DELETED' } },
      select: summary,
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
  }
  /** WP3: ответ владельцу — строка + тема (с откатом для старых строк) + смета. */
  present<
    T extends {
      occasionKind: string | null;
      occasionTheme: string | null;
      catalogId: string;
      chapters: Prisma.JsonValue;
      title: string;
      giftNote: string | null;
      narrationLayout: Prisma.JsonValue;
      budgetCents: number;
    },
  >(row: T) {
    return {
      ...row,
      occasionTheme: row.occasionTheme ?? storyOccasionTheme(row.occasionKind),
      estimate: storedStoryEstimate(row),
    };
  }
  async view(userId: string, id: string) {
    return this.present(await this.own(userId, id));
  }
  /** WP3: точный текст озвучки, вставка, длительность и смета — без БД и провайдеров. */
  preview(input: StoryDraftInput, options: StoryPreviewOptions = {}) {
    return previewStoryDraft(input, options);
  }
  async create(userId: string, input: StoryDraftInput) {
    // Validation (catalog, explicit gift-note opt-in, promise validator) runs
    // before the transaction: a rejected draft takes no lock and no quota.
    const draft = prepareStoryDraft(input);
    const { story } = draft;
    return this.prisma.$transaction(async (tx) => {
      // Serialize quota checks for this owner across serverless instances.
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`story:${userId}`}))::text`;
      const day = new Date();
      day.setUTCHours(0, 0, 0, 0);
      const daily = await tx.storyGift.count({
        where: { userId, createdAt: { gte: day } },
      });
      const total = await tx.storyGift.count({
        where: { userId, status: { not: 'DELETED' } },
      });
      if (daily >= 3 || total >= 20)
        throw new BadRequestException(
          'Пилот: до трёх новых сказок в сутки и двадцати сохранённых',
        );
      const reserve = storyAudioReservation(draft.text);
      if (reserve > draft.budgetUsd * 1e6)
        throw new BadRequestException(
          'Сократите текст: расчётный резерв превышает выбранный бюджет',
        );
      const row = await tx.storyGift.create({
        data: {
          userId,
          catalogId: story.id,
          chapters: story.chapters.map((c) => ({ ...c })),
          locale: story.locale,
          countryCode: draft.countryCode,
          budgetCents: Math.round(draft.budgetUsd * 100),
          reservedMicroUsd: reserve,
          occasion: draft.occasion.label,
          occasionKind: draft.occasion.kind,
          occasionTheme: draft.occasion.theme,
          giftNote: draft.giftNote,
          giftNoteEnabled: draft.giftNoteEnabled,
          giftNotePosition: draft.giftNotePosition,
          giftPhotoDescription: draft.giftPhotoDescription,
          narrationLayout: draft.layout,
          title: story.title,
          text: draft.text,
          textHash: draft.textHash,
          voiceId: STORY_VOICE,
        },
        select: summary,
      });
      return this.present(row);
    });
  }
  /**
   * WP3: фото и/или описание подарка (оба необязательны и независимы от
   * реплики). `description` undefined — не менять; '' или null — очистить.
   */
  async photo(
    userId: string,
    id: string,
    base64?: string,
    description?: string | null,
  ) {
    const row = await this.own(userId, id);
    if (base64 === undefined && description === undefined)
      throw new BadRequestException('Нужно фото или описание подарка');
    const bytes = base64 === undefined ? null : normalizeStoryPhoto(base64);
    const text =
      description === undefined
        ? undefined
        : normalizeStoryPhotoDescription(description, row.locale);
    const saved = await this.prisma.storyGift.updateMany({
      where: { id, userId, status: 'DRAFT' },
      data: {
        ...(bytes
          ? { giftPhoto: new Uint8Array(bytes), hasGiftPhoto: true }
          : {}),
        ...(text === undefined ? {} : { giftPhotoDescription: text }),
      },
    });
    if (!saved.count)
      throw new ConflictException('Фото изменяется только до озвучки');
    return this.view(userId, id);
  }
  /** WP3: убрать фото подарка и его описание из черновика. */
  async removePhoto(userId: string, id: string) {
    await this.own(userId, id);
    const saved = await this.prisma.storyGift.updateMany({
      where: { id, userId, status: 'DRAFT' },
      data: {
        giftPhoto: null,
        hasGiftPhoto: false,
        giftPhotoDescription: null,
      },
    });
    if (!saved.count)
      throw new ConflictException('Фото изменяется только до озвучки');
    return this.view(userId, id);
  }
  async ownerPhoto(userId: string, id: string) {
    await this.own(userId, id);
    const row = await this.prisma.storyGift.findFirst({
      where: { id, userId },
      select: { giftPhoto: true },
    });
    if (!row?.giftPhoto) throw new NotFoundException();
    return { base64: Buffer.from(row.giftPhoto).toString('base64') };
  }
  async render(userId: string, id: string) {
    const row = await this.own(userId, id);
    if (row.status !== 'DRAFT') return row; // A retry never buys a second synthesis.
    if (!this.tts.configured())
      throw new ServiceUnavailableException('Озвучка временно недоступна');
    if (row.reservedMicroUsd > row.budgetCents * 10000)
      throw new BadRequestException('Расчётный бюджет превышен');
    await this.plan.assertCanSpendUser(userId);
    const claim = await this.prisma.storyGift.updateMany({
      where: { id, userId, status: 'DRAFT' },
      data: { status: 'SYNTHESIZING' },
    });
    if (!claim.count) return this.own(userId, id);
    try {
      const input = await this.prisma.storyGift.findUniqueOrThrow({
        where: { id },
        select: { text: true },
      });
      const audio = await this.tts.synthesize({
        text: input.text,
        voiceId: row.voiceId,
        language: row.locale,
      });
      if (!audio.ok)
        throw new Error('Не удалось подтвердить результат синтеза');
      await this.usage.record({
        operation: 'story-voiceover',
        model: 'resemble-tts',
        characters: audio.characters,
        userId,
      });
      if (
        audio.voiceId !== STORY_VOICE ||
        !audio.durationSeconds ||
        audio.durationSeconds < 8 ||
        audio.durationSeconds > 240 ||
        audio.audio.byteLength > 3 * 1024 * 1024 ||
        audio.mimeType !== 'audio/mpeg'
      )
        throw new Error(
          'Результат не прошёл проверку голоса, длительности или формата',
        );
      await this.prisma.storyGift.updateMany({
        where: { id, userId, status: 'SYNTHESIZING' },
        data: {
          status: 'READY',
          audio: new Uint8Array(audio.audio),
          audioMime: audio.mimeType,
          durationSeconds: audio.durationSeconds,
          audioHash: digest(audio.audio),
        },
      });
      return this.own(userId, id);
    } catch {
      // No blind repeat after a provider timeout: it may already have billed.
      await this.prisma.storyGift.updateMany({
        where: { id, userId, status: 'SYNTHESIZING' },
        data: {
          status: 'UNKNOWN',
          error:
            'Результат озвучки не подтверждён. Повтор автоматически не запускается; нужна проверка оператором.',
        },
      });
      return this.own(userId, id);
    }
  }
  async quality(userId: string, id: string) {
    const row = await this.own(userId, id);
    if (!['READY', 'APPROVED'].includes(row.status))
      throw new ConflictException('Дождитесь озвучки');
    if (!this.stt.configured())
      throw new ServiceUnavailableException(
        'Проверка озвучки временно недоступна',
      );
    if (row.audioQaStatus !== 'PENDING') return row;
    if (row.reservedMicroUsd > row.budgetCents * 10000)
      throw new BadRequestException('Расчётный бюджет превышен');
    await this.plan.assertCanSpendUser(userId);
    const claim = await this.prisma.storyGift.updateMany({
      where: {
        id,
        userId,
        audioQaStatus: 'PENDING',
        status: { in: ['READY', 'APPROVED'] },
      },
      data: { audioQaStatus: 'RUNNING' },
    });
    if (!claim.count) return this.own(userId, id);
    try {
      const source = await this.prisma.storyGift.findFirstOrThrow({
        where: { id, userId, status: { in: ['READY', 'APPROVED'] } },
        select: { text: true, audio: true },
      });
      const result = await this.stt.transcribe({
        audio: Buffer.from(source.audio!),
        mimeType: 'audio/mpeg',
        languageHints: [row.locale],
        strictLanguage: true,
      });
      if (result.billable)
        await this.usage.record({
          operation: 'story-audio-qa',
          model: 'soniox-stt-async',
          seconds: result.seconds,
          userId,
        });
      if (!result.text) throw new Error('No transcript');
      const score = storySpeechScore(source.text, result.text);
      const passed = result.language === row.locale && score.wer <= 0.05;
      await this.prisma.storyGift.updateMany({
        where: {
          id,
          userId,
          audioQaStatus: 'RUNNING',
          status: { in: ['READY', 'APPROVED'] },
        },
        data: {
          audioQaStatus: passed ? 'PASS' : 'WARN',
          audioQa: {
            ...score,
            language: result.language ?? null,
            confidence: result.speechConfidence ?? null,
            checkedAt: new Date().toISOString(),
            audioHash: row.audioHash,
          },
        },
      });
    } catch {
      await this.prisma.storyGift.updateMany({
        where: {
          id,
          userId,
          audioQaStatus: 'RUNNING',
          status: { in: ['READY', 'APPROVED'] },
        },
        data: { audioQaStatus: 'UNKNOWN' },
      });
    }
    return this.own(userId, id);
  }
  async audio(userId: string, id: string) {
    await this.own(userId, id);
    const row = await this.prisma.storyGift.findFirst({
      where: { id, userId, status: { in: ['READY', 'APPROVED'] } },
      select: { audio: true, audioMime: true },
    });
    if (!row?.audio) throw new NotFoundException('Аудио ещё не готово');
    return {
      base64: Buffer.from(row.audio).toString('base64'),
      mime: row.audioMime,
    };
  }
  async approve(userId: string, id: string, audioHash: string) {
    const row = await this.own(userId, id);
    if (!row.audioHash || row.audioHash !== audioHash)
      throw new ConflictException('Просмотрите текущий выпуск');
    if (row.status === 'APPROVED') return row;
    const done = await this.prisma.storyGift.updateMany({
      where: { id, userId, status: 'READY', audioHash },
      data: { status: 'APPROVED', approvedAt: new Date() },
    });
    if (!done.count) throw new ConflictException('Выпуск ещё не готов');
    return this.own(userId, id);
  }
  /**
   * ST2-R-02: Story-Tales is in closed development — public gift links are
   * not issued at all (the controller route answers 404 too). No token is
   * generated or stored here, whatever the caller; `withdraw` still clears an
   * old link and every public route stays behind `StoryPublicDisabledGuard`.
   */
  async share(userId: string, id: string): Promise<never> {
    await this.own(userId, id);
    throw new NotFoundException(
      'Публичные ссылки закрыты: Story-Tales в закрытой разработке',
    );
  }
  async withdraw(userId: string, id: string) {
    await this.own(userId, id);
    await this.prisma.storyGift.updateMany({
      where: { id, userId },
      data: { shareHash: null },
    });
    return { withdrawn: true };
  }
  /**
   * Owner deletion; also the retention purge (WP1). Serialized with video
   * create/segment claims by the same `story-video:<giftId>` advisory lock
   * (F1, A-S3-6). `expect` makes the deletion conditional on the state the
   * cron saw (A-S3-5): any change in between → `{ deleted: false, raced: true }`
   * and nothing is written; `journal` runs in the same transaction.
   */
  async remove(
    userId: string,
    id: string,
    opts: {
      expect?: { status: string; updatedAt: Date };
      journal?: (tx: Prisma.TransactionClient) => Promise<unknown>;
    } = {},
  ): Promise<{ deleted: boolean; raced?: boolean }> {
    await this.own(userId, id);
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`story-video:${id}`}))::text`;
      const gone = await tx.storyGift.updateMany({
        where: {
          id,
          userId,
          status: opts.expect?.status ?? { not: 'DELETED' },
          ...(opts.expect ? { updatedAt: opts.expect.updatedAt } : {}),
        },
        data: {
          status: 'DELETED',
          shareHash: null,
          audio: null,
          audioHash: null,
          giftPhoto: null,
          audioQa: Prisma.DbNull,
          hasGiftPhoto: false,
          giftNote: null,
          giftNotePosition: null,
          occasion: null,
          occasionKind: null, // WP3
          occasionTheme: null,
          giftNoteEnabled: false,
          giftPhotoDescription: null,
          narrationLayout: Prisma.DbNull,
          text: '',
          // ST2-S-08: no digest of the personal text survives deletion.
          textHash: '',
          chapters: [],
        },
      });
      // Changed since the cron looked (or deleted concurrently): touch nothing.
      if (!gone.count && opts.expect) return { deleted: false, raced: true };
      await tx.storyVideoRender.updateMany({
        where: { giftId: id },
        data: storyRenderWipe(),
      });
      // WP4: segment cache and the adult's own recordings of this gift.
      await tx.storyVideoSegment.updateMany({
        where: { giftId: id },
        data: {
          status: 'DELETED',
          audio: null,
          audioHash: null,
          durationSeconds: null,
          text: '',
        },
      });
      // ST2-S-08: configuration hashes (preamble, segment texts) and segment
      // cache keys (sha256 of the exact text) are digests of personal text,
      // checkable by dictionary. Replaced by values derived from the row id
      // only: unique per (gift, key) and matching the 64-hex CHECK of keys.
      await tx.$executeRaw`UPDATE "story_video_renders" SET "configHash" = 'deleted:' || "id" WHERE "giftId" = ${id}`;
      await tx.$executeRaw`UPDATE "story_video_segments" SET "cacheKey" = encode(sha256(convert_to('story-deleted:' || "id", 'UTF8')), 'hex') WHERE "giftId" = ${id}`;
      if (opts.journal) await opts.journal(tx);
      return { deleted: true };
    });
  }
  async publicGift(token: string, audio = false, photo = false) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new NotFoundException();
    const row = await this.prisma.storyGift.findFirst({
      where: { shareHash: digest(token), status: 'APPROVED' },
      select: {
        title: true,
        locale: true,
        chapters: true,
        catalogId: true,
        occasion: true,
        giftNote: true,
        giftNotePosition: true,
        durationSeconds: true,
        hasGiftPhoto: true,
        ...(audio ? { audio: true } : {}),
        ...(photo ? { giftPhoto: true } : {}),
      },
    });
    if (!row) throw new NotFoundException('Ссылка недоступна');
    return row;
  }
}
