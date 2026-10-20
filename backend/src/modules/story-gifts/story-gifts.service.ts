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
import { createHash, randomBytes } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { ResembleService } from '../tts/resemble.service';
import { PlanService } from '../plan/plan.service';
import { AiUsageService } from '../ai-usage/ai-usage.service';
import { STORY_CATALOG, STORY_VOICE, storyText } from './story-catalog';
import {
  StoryChargesService,
  storyVideoChargeKey,
} from './story-charges.service';
import {
  STORY_TERMS_VERSION,
  storyTalesMode,
  type StoryAccessFacts,
} from './story-access';
import { STORY_SHARE_DAYS, storyGiftRetention } from './story-retention-view';
import {
  storyPublicApiBase,
  storyRenderNeedsPublicConsent,
  storyTtsUnbilled,
} from './story-video-plan';
import { STORY_CHARGE_NONE } from './story-pricing';
import { STORY_SHARE_CLEARED } from './story-share';
import { storyRightsText, type StoryTextLocale } from './story-i18n';

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
    voiceConsentLocale: null,
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
  sharedAt: true, // ST3: public link window (90 days)
  shareExpiresAt: true,
  narratorPublicConsentRenderId: true, // ST3-S-04: the consented release
  createdAt: true,
  updatedAt: true,
} as const;
// ST3: re-exported for older imports; the source is story-share.ts.
export { STORY_SHARE_CLEARED } from './story-share';
/** Public URL of a gift link: `<API_PUBLIC_URL>/story-gift/<token>`. */
export function storyGiftUrl(token: string) {
  return new URL(`story-gift/${token}`, storyPublicApiBase()).toString();
}
@Injectable()
export class StoryGiftsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tts: ResembleService,
    private readonly plan: PlanService,
    private readonly usage: AiUsageService,
    private readonly stt: SonioxSttClient,
    private readonly charges: StoryChargesService,
  ) {
    this.stt.attemptDeadlineMs = 90_000;
  }
  /** ST3: `rights` in the request language (ru/uk/en). */
  catalog(locale: StoryTextLocale = 'ru') {
    return STORY_CATALOG.map((s) => ({
      ...s,
      rights: storyRightsText(s.rights, locale),
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
  async list(userId: string) {
    const rows = await this.prisma.storyGift.findMany({
      where: { userId, status: { not: 'DELETED' } },
      select: summary,
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    return this.decorate(userId, rows);
  }
  /**
   * ST3: `retention` (the cron's deletion date / end of the public link,
   * warning 14 days before) and `charge` of the audio step (Р-ST3-2).
   */
  private async decorate<
    T extends {
      id: string;
      status: string;
      updatedAt: Date;
      shareExpiresAt: Date | null;
      reservedMicroUsd: number;
    },
  >(userId: string, rows: T[]) {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const renders = (await this.prisma.storyVideoRender.groupBy({
      by: ['giftId'],
      where: { giftId: { in: ids } },
      _max: { updatedAt: true },
    })) as unknown as Array<{
      giftId: string;
      _max: { updatedAt: Date | null };
    }>;
    const last = new Map(renders.map((r) => [r.giftId, r._max.updatedAt]));
    const facts = await this.charges.facts(userId);
    const charged = await this.charges.audioCharges(ids);
    const now = new Date();
    return Promise.all(
      rows.map(async (row) => ({
        ...row,
        retention: storyGiftRetention(row, last.get(row.id) ?? null, now),
        charge:
          charged.get(row.id) ??
          (row.status === 'DRAFT'
            ? await this.charges.quote(facts, userId, {
                kind: 'audio',
                giftId: row.id,
                reserveMicroUsd: row.reservedMicroUsd,
              })
            : { ...STORY_CHARGE_NONE }),
      })),
    );
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
    const [row] = await this.decorate(userId, [
      this.present(await this.own(userId, id)),
    ]);
    const release = await this.latestRelease(id);
    const linkLive =
      !!row.shareExpiresAt && row.shareExpiresAt.getTime() > Date.now();
    return {
      ...row,
      narratorPublicConsentRequired: !!release?.needsConsent,
      // ST3-S-04: a live link serves the video only after the consent for
      // exactly this release; until then — the page without the video.
      narratorPublicConsentPending:
        !!release?.needsConsent &&
        linkLive &&
        row.narratorPublicConsentRenderId !== release.id,
    };
  }
  /**
   * ТЗ §11.1: the release a link would serve (the latest approved READY
   * video) has a non-Nova narrator — the share needs `narratorPublicConsent`.
   */
  async narratorPublicConsentRequired(giftId: string): Promise<boolean> {
    return !!(await this.latestRelease(giftId))?.needsConsent;
  }
  /** The release a link serves: the latest approved READY video, if any. */
  private async latestRelease(giftId: string) {
    const render = await this.prisma.storyVideoRender.findFirst({
      where: { giftId, status: 'READY', approvedAt: { not: null } },
      orderBy: { approvedAt: 'desc' },
      select: { id: true, userVoiceId: true, segments: true },
    });
    return render
      ? { id: render.id, needsConsent: storyRenderNeedsPublicConsent(render) }
      : null;
  }
  /**
   * WP3: точный текст озвучки, вставка, длительность и смета — без записей и
   * провайдеров. ST3: `charge` — цена аудио-сборки, `videoCharge` — видео.
   */
  preview(input: StoryDraftInput, options: StoryPreviewOptions = {}) {
    return previewStoryDraft(input, options);
  }
  async previewFor(
    userId: string,
    input: StoryDraftInput,
    options: StoryPreviewOptions = {},
  ) {
    const draft = this.preview(input, options);
    const facts = await this.charges.facts(userId);
    const charge = await this.charges.quote(facts, userId, {
      kind: 'audio',
      giftId: '',
      reserveMicroUsd: draft.estimate.audioReserveMicroUsd,
    });
    const videoCharge = options.includeVideo
      ? await this.charges.quote(facts, userId, {
          kind: 'video',
          giftId: '',
          reserveMicroUsd: draft.estimate.videoReserveMicroUsd,
        })
      : null;
    return { ...draft, charge, videoCharge };
  }
  async create(userId: string, input: StoryDraftInput) {
    // Validation (catalog, explicit gift-note opt-in, promise validator) runs
    // before the transaction: a rejected draft takes no lock and no quota.
    const draft = prepareStoryDraft(input);
    const { story } = draft;
    const created = await this.prisma.$transaction(async (tx) => {
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
    const [decorated] = await this.decorate(userId, [created]);
    return decorated;
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
  async render(
    userId: string,
    id: string,
    opts: { expectedCredits?: number } = {},
  ) {
    const row = await this.own(userId, id);
    if (row.status !== 'DRAFT') return row; // A retry never buys a second synthesis.
    if (!this.tts.configured())
      throw new ServiceUnavailableException('Озвучка временно недоступна');
    if (row.reservedMicroUsd > row.budgetCents * 10000)
      throw new BadRequestException('Расчётный бюджет превышен');
    await this.plan.assertCanSpendUser(userId);
    // ST3 (Р-ST3-2): the claim and the credit reserve commit together; a 402
    // rolls the claim back, a repeat of the same gift never charges twice.
    const facts: StoryAccessFacts = await this.charges.facts(userId);
    const claimed = await this.prisma.$transaction(async (tx) => {
      const claim = await tx.storyGift.updateMany({
        where: { id, userId, status: 'DRAFT' },
        data: { status: 'SYNTHESIZING' },
      });
      if (!claim.count) return false;
      await this.charges.reserve(
        tx,
        facts,
        userId,
        {
          kind: 'audio',
          giftId: id,
          reserveMicroUsd: row.reservedMicroUsd,
        },
        opts.expectedCredits,
      );
      return true;
    });
    if (!claimed) return this.own(userId, id);
    /** ST3-S-09: the provider certainly did not bill (skipped / final 4xx). */
    let unbilled = false;
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
      if (!audio.ok) {
        unbilled = storyTtsUnbilled(audio);
        throw new Error('Не удалось подтвердить результат синтеза');
      }
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
      const ready = await this.prisma.storyGift.updateMany({
        where: { id, userId, status: 'SYNTHESIZING' },
        data: {
          status: 'READY',
          audio: new Uint8Array(audio.audio),
          audioMime: audio.mimeType,
          durationSeconds: audio.durationSeconds,
          audioHash: digest(audio.audio),
        },
      });
      // ST3-S-14: delivered — the credits are captured (never auto-refunded).
      if (ready.count) await this.charges.captureQuietly({ audioGiftId: id });
      return this.own(userId, id);
    } catch {
      if (unbilled) {
        // Final: nothing was billed — FAILED and the credits go back.
        const failed = await this.prisma.storyGift.updateMany({
          where: { id, userId, status: 'SYNTHESIZING' },
          data: {
            status: 'FAILED',
            error:
              'Озвучка не выполнена: сервис синтеза отклонил запрос без оплаты. Кредиты возвращены; создайте сказку заново.',
          },
        });
        if (failed.count)
          await this.charges.refundAudio(id).catch(() => undefined);
        return this.own(userId, id);
      }
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
   * Р-ST3-3: «Публично по ссылке, без индексации» (ТЗ §11) — only in
   * `pilot`/`public` (in `owner` — 404, no token is generated). Approved
   * gifts only; the explicit acknowledgement is checked by the DTO. The
   * token is returned once, only its sha256 is stored; the link lives 90
   * days. A second link needs the previous one withdrawn (or expired).
   */
  async share(
    userId: string,
    id: string,
    opts: { narratorPublicConsent?: boolean } = {},
  ) {
    const row = await this.own(userId, id);
    if (storyTalesMode() === 'owner') throw new NotFoundException();
    if (row.status !== 'APPROVED')
      throw new ConflictException('Сначала одобрите готовую сказку');
    const release = await this.latestRelease(id);
    const needsConsent = !!release?.needsConsent;
    const consent = needsConsent && opts.narratorPublicConsent === true;
    if (needsConsent && !consent)
      throw new BadRequestException({
        code: 'STORY_NARRATOR_PUBLIC_CONSENT_REQUIRED',
        message:
          'В выпуске голос, запись или образ рассказчика: подтвердите, что рассказчик согласен на распространение по ссылке',
      });
    const token = randomBytes(32).toString('base64url');
    const now = new Date();
    const expiresAt = new Date(now.getTime() + STORY_SHARE_DAYS * 86_400_000);
    // The fact, the rules version and the exact release (§11.1, ST3-S-04).
    const consentData = consent
      ? {
          narratorPublicConsentAt: now,
          narratorPublicConsentVersion: STORY_TERMS_VERSION,
          narratorPublicConsentRenderId: release!.id,
        }
      : {
          narratorPublicConsentAt: null,
          narratorPublicConsentVersion: null,
          narratorPublicConsentRenderId: null,
        };
    const done = await this.prisma.storyGift.updateMany({
      where: {
        id,
        userId,
        status: 'APPROVED',
        OR: [{ shareHash: null }, { shareExpiresAt: { lte: now } }],
      },
      data: {
        shareHash: digest(token),
        sharedAt: now,
        shareExpiresAt: expiresAt,
        ...consentData,
      },
    });
    if (!done.count) {
      // ST3-S-04: a live link + the narrator's consent for the NEW release —
      // the consent moves to it, the link (and its date) stay the same.
      if (consent) {
        const updated = await this.prisma.storyGift.updateMany({
          where: {
            id,
            userId,
            status: 'APPROVED',
            shareHash: { not: null },
            shareExpiresAt: { gt: now },
          },
          data: consentData,
        });
        if (updated.count) {
          const live = await this.prisma.storyGift.findFirst({
            where: { id, userId },
            select: { shareExpiresAt: true },
          });
          return {
            url: null,
            expiresAt: live?.shareExpiresAt?.toISOString() ?? null,
            narratorConsentUpdated: true,
          };
        }
      }
      throw new ConflictException(
        'Ссылка уже создана либо выпуск изменён. Для новой ссылки сначала снимите прежнюю с публикации',
      );
    }
    return {
      url: storyGiftUrl(token),
      expiresAt: expiresAt.toISOString(),
      narratorConsentUpdated: false,
    };
  }
  async withdraw(userId: string, id: string) {
    await this.own(userId, id);
    await this.prisma.storyGift.updateMany({
      where: { id, userId },
      data: STORY_SHARE_CLEARED,
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
  ): Promise<{ deleted: boolean; raced?: boolean; creditsRefunded?: number }> {
    const current = await this.own(userId, id);
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`story-video:${id}`}))::text`;
      // ST3-S-02: steps the user never received (in flight or UNKNOWN) are
      // refunded with the deletion; the risk of a provider charge is ours.
      const steps = await tx.storyVideoRender.findMany({
        where: {
          giftId: id,
          status: { in: ['PREPARING', 'PENDING', 'UNKNOWN', 'READY'] },
        },
        select: { id: true, status: true },
      });
      const unfinished = steps.filter((r) => r.status !== 'READY');
      const gone = await tx.storyGift.updateMany({
        where: {
          id,
          userId,
          status: opts.expect?.status ?? { not: 'DELETED' },
          ...(opts.expect ? { updatedAt: opts.expect.updatedAt } : {}),
        },
        data: {
          status: 'DELETED',
          ...STORY_SHARE_CLEARED,
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
      let creditsRefunded = 0;
      const refunds: Array<{
        targetType: 'gift' | 'render';
        targetId: string;
        status: string;
        credits: number;
      }> = [];
      if (['SYNTHESIZING', 'UNKNOWN'].includes(current.status)) {
        const r = await this.charges.refundAudio(id, tx);
        if (r.refunded)
          refunds.push({
            targetType: 'gift',
            targetId: id,
            status: current.status,
            credits: r.credits,
          });
      }
      for (const render of unfinished) {
        const r = await this.charges.refund(storyVideoChargeKey(render.id), tx);
        if (r.refunded)
          refunds.push({
            targetType: 'render',
            targetId: render.id,
            status: render.status,
            credits: r.credits,
          });
      }
      // ST3-S-14: delivered steps of the deleted gift stay paid (CAPTURED).
      if (['READY', 'APPROVED'].includes(current.status))
        await this.charges.captureAudio(id, tx);
      for (const render of steps.filter((r) => r.status === 'READY'))
        await this.charges.capture(storyVideoChargeKey(render.id), tx);
      for (const r of refunds) {
        creditsRefunded += r.credits;
        await tx.storyOperatorAction.create({
          data: {
            actorKind: opts.journal ? 'cron' : 'owner',
            targetType: r.targetType,
            targetId: r.targetId,
            action: 'charge.auto-refund',
            reason:
              'Сказка удалена до получения результата: кредиты за незавершённый шаг возвращены автоматически',
            previousState: { status: r.status, charge: 'RESERVED' },
            result: { creditsRefunded: r.credits },
          },
        });
      }
      if (opts.journal) await opts.journal(tx);
      return { deleted: true, creditsRefunded };
    });
  }
  async publicGift(token: string, audio = false, photo = false) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new NotFoundException();
    const row = await this.prisma.storyGift.findFirst({
      where: {
        shareHash: digest(token),
        status: 'APPROVED',
        // ST3: 90 days, then 404 (ТЗ §11.4).
        shareExpiresAt: { gt: new Date() },
      },
      select: {
        shareExpiresAt: true,
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
