import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { FfmpegApiService } from '../postprod/ffmpeg-api.service';
import { ResembleService } from '../tts/resemble.service';
import { PlanService } from '../plan/plan.service';
import { AiUsageService } from '../ai-usage/ai-usage.service';
import { SonioxSttClient } from '../voice/soniox-stt.client';
import {
  fetchPubliclyRoutable,
  readBodyWithLimit,
} from '../../common/external-url-guard';
import {
  downloadStoryVideo,
  STORY_MAX_VIDEO,
  StoryVideoRejectedError,
} from './story-video-result';
import { storySpeechScore } from './story-audio-qa';
import { STORY_VOICE } from './story-catalog';
import {
  STORY_VIDEO_BASE as BASE,
  storyVideoBaseFor,
  storyVideoBaseRevision,
} from './story-video-base';
import {
  StoryChargesService,
  storyVideoChargeKey,
} from './story-charges.service';
import { STORY_CHARGE_NONE } from './story-pricing';
import { withdrawStoryShares } from './story-share';
import {
  STORY_PARENT_CONSENT_TEXTS,
  STORY_RECORDING_CONSENT_TEXTS,
  type StoryTextLocale,
} from './story-i18n';
import {
  planStorySegments,
  storyDigest as digest,
  storyVideoConfigHash,
  storyVideoReserve,
  storyPublicApiBase,
  storyTtsUnbilled,
  storyRenderNeedsPublicConsent,
  storyVideoQaEstimate,
  storyVideoTtsReserve,
  StoryVideoInput,
  StoryVoiceChoice,
  STORY_PARENT_CONSENT_VERSION,
  STORY_RECORDING_CONSENT_VERSION,
  STORY_SEGMENT_MAX_SECONDS,
  STORY_SEGMENT_MIN_SECONDS,
  STORY_VIDEO_MAX_SECONDS,
} from './story-video-plan';
import {
  applyStoryPronunciations,
  buildStoryVtt,
  parseStoryPronunciations,
  parseStoryWav,
  storyChaptersSha256,
  storyRecordingKey,
  storySegmentKey,
  storyVideoLayout,
  stripStoryLoneSurrogates,
  STORY_PRONUNCIATION_CHARS,
  STORY_PRONUNCIATION_MAX,
  STORY_RECORDING_MAX_BYTES,
  STORY_RECORDING_MAX_SECONDS,
  STORY_RECORDING_MIN_SECONDS,
  STORY_VIDEO_MIX,
  type StoryManifestSegment,
  type StoryVideoSegmentsManifest,
} from './story-video-segments';
import { storyNarrationParts } from './story-gift-note';
import { assertStoryPromiseFree, checkStoryPromises } from './story-promise';
import { storyOccasionLines, type StoryOccasionKind } from './story-occasion';
import { STORY_SPEECH_CHARS_PER_SECOND } from './story-budget';
import { storyEdition } from './story-editions';
import { NARRATOR_LOOK_MAX_BYTES } from '../brand-manifest/narrator-looks.rules';
import {
  NarratorLooksService,
  type NarratorImage,
} from '../brand-manifest/narrator-looks.service';
import type { StoryNarratorImageSnapshot } from './story-video-segments';
/** Intro still from the profile narrator image: formats FFmpeg reads, bounded size. */
export const STORY_NARRATOR_IMAGE_MIMES = [
  'image/png',
  'image/jpeg',
  'image/webp',
] as const;
/**
 * A-S2-4: the provider fetches the still from our render-input route, whose
 * response must stay under the 4.5 MB serverless limit. There is no image
 * codec in the backend (no sharp), so a larger image is refused with a clear
 * 409 before any paid call (quote and create) instead of being re-encoded.
 */
export const STORY_NARRATOR_IMAGE_MAX_BYTES = NARRATOR_LOOK_MAX_BYTES; // 4 000 000 (ST2-S-07: one threshold)
function narratorSnapshot(image: NarratorImage): StoryNarratorImageSnapshot {
  return {
    manifestId: image.manifestId,
    characterId: image.characterId,
    kind: image.kind,
    lookId: image.lookId,
    asset: image.asset,
    assetHash: image.assetHash,
    style: image.style,
    sketchRendering: image.sketchRendering,
    consentVersion: image.consentVersion,
    mimeType: image.mimeType,
    bytes: image.bytes.length,
  };
}
/**
 * B-S2-1: the validator on the exact TTS input, also with the respelling
 * stress marks («+», U+0301) removed — "за+втра" is still "завтра".
 */
function assertSpokenPromiseFree(text: string, locale: string) {
  assertStoryPromiseFree(text, locale);
  const plain = text
    .replace(/\+/g, '')
    .normalize('NFD')
    .replace(/\u0301/g, '')
    .normalize('NFC');
  if (plain !== text) assertStoryPromiseFree(plain, locale);
}
/** Same image the adult saw at create time: identity, asset and consent snapshot. */
function sameNarrator(
  a: StoryNarratorImageSnapshot,
  b: StoryNarratorImageSnapshot,
) {
  return (
    a.manifestId === b.manifestId &&
    a.kind === b.kind &&
    a.lookId === b.lookId &&
    a.assetHash === b.assetHash &&
    a.consentVersion === b.consentVersion
  );
}
/** Planned segment of one export before/after its speech is resolved. */
type PlannedSegment = StoryManifestSegment & {
  /** Recording row id (recorded intro). */
  recordingId?: string;
};
type SegmentRow = {
  id: string;
  cacheKey: string;
  status: string;
  audioHash: string | null;
  durationSeconds: number | null;
};
const segmentStage = {
  intro: 'voice',
  gift_note: 'note',
  outro: 'outro',
  main: 'main',
} as const;
/**
 * A-S2-2: one rule for the (gift, configuration) slot. Only a live render
 * occupies it — PREPARING, PENDING, READY or UNKNOWN (the latter blocks a
 * paid repeat until an operator decides). DELETED and FAILED renders are
 * history: create() moves them aside (`<hash>:retired:<id>`) under the gift
 * lock and starts a new, explicitly requested attempt; quote() ignores them.
 */
const DEAD_RENDER = ['DELETED', 'FAILED'];
function storyManifest(raw: unknown): StoryVideoSegmentsManifest | null {
  const m = raw as StoryVideoSegmentsManifest | null;
  return m && m.version === 1 && Array.isArray(m.segments) ? m : null;
}
const select = {
  id: true,
  giftId: true,
  status: true,
  preambleText: true,
  preambleDuration: true,
  baseRevision: true,
  baseHash: true,
  mainAudioHash: true,
  voiceId: true,
  voiceLabel: true,
  narratorManifestId: true,
  userVoiceId: true,
  voiceConsentAt: true,
  voiceConsentVersion: true,
  reservedMicroUsd: true,
  videoHash: true,
  durationSeconds: true,
  approvedAt: true,
  qaStatus: true,
  qa: true,
  error: true,
  segments: true,
  createdAt: true,
  updatedAt: true,
} as const;
const MAX_VIDEO = STORY_MAX_VIDEO;
const publicApi = storyPublicApiBase;
export function storyAssetUrl(
  part: 'base' | 'cover',
  revision: string = BASE.revision,
) {
  const u = new URL(process.env.TMA_PUBLIC_URL || 'https://viral4creators.app');
  if (u.protocol !== 'https:' || u.username || u.password)
    throw new ServiceUnavailableException('Адрес базового видео не настроен');
  const base = storyVideoBaseRevision(revision);
  if (!base) throw new NotFoundException('Базовый видеопакет не опубликован');
  return new URL(
    `/story-assets/${base.revision}/${part === 'base' ? base.tracks.video : base.tracks.cover}`,
    u,
  ).toString();
}
@Injectable()
export class StoryVideoService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ffmpeg: FfmpegApiService,
    private readonly tts: ResembleService,
    private readonly plan: PlanService,
    private readonly usage: AiUsageService,
    private readonly stt: SonioxSttClient,
    private readonly looks: NarratorLooksService,
    private readonly charges: StoryChargesService,
  ) {}
  /** ST3: credits of a render that ended in a final FAILED go back. */
  private refundRender(giftId: string, renderId: string) {
    return this.charges.refundQuietly(storyVideoChargeKey(renderId));
  }
  /**
   * WP5↔WP4: the profile narrator image (applied look, else the original
   * photo/sketch of the narrator character). A 409 from WP5 (revoked image
   * consent, deleted/stale look, no image) is returned as is: no silent
   * fallback to the original or to the cover.
   */
  private async narratorImage(manifestId: string, userId: string) {
    const image = await this.looks.resolveNarratorImage(manifestId, userId);
    if (
      !(STORY_NARRATOR_IMAGE_MIMES as readonly string[]).includes(
        image.mimeType,
      ) ||
      !image.bytes.length ||
      image.bytes.length > STORY_NARRATOR_IMAGE_MAX_BYTES ||
      digest(image.bytes) !== image.assetHash
    )
      throw new ConflictException(
        'Изображение рассказчика не подходит для кадра вступления (PNG/JPEG/WebP до 4 МБ); выберите другой образ или отключите его',
      );
    return image;
  }
  private async gift(userId: string, giftId: string) {
    const g = await this.prisma.storyGift.findFirst({
      where: { id: giftId, userId, status: { in: ['READY', 'APPROVED'] } },
      select: {
        id: true,
        userId: true,
        catalogId: true,
        voiceId: true,
        audioHash: true,
        durationSeconds: true,
        giftNote: true,
        giftNotePosition: true,
        narrationLayout: true,
        hasGiftPhoto: true,
        occasionKind: true,
        chapters: true,
        audioQaStatus: true,
        locale: true,
        text: true,
        budgetCents: true,
        reservedMicroUsd: true,
      },
    });
    if (!g) throw new NotFoundException('Готовая сказка не найдена');
    return g;
  }
  private async profiles(userId: string) {
    const voices = await this.prisma.userVoice.findMany({
      where: { userId, status: 'READY', resembleVoiceId: { not: null } },
      select: { id: true, resembleVoiceId: true, label: true, consentAt: true },
    });
    const manifests = await this.prisma.brandManifest.findMany({
      where: {
        userId,
        ttsProvider: 'resemble',
        ttsVoiceId: { in: voices.map((v) => v.resembleVoiceId!) },
      },
      select: { id: true, title: true, ttsVoiceId: true },
      orderBy: { createdAt: 'desc' },
    });
    return manifests.flatMap((m) => {
      const v = voices.find(
        (v) => v.resembleVoiceId === m.ttsVoiceId && v.consentAt,
      );
      return v ? [{ id: m.id, title: m.title, voiceLabel: v.label }] : [];
    });
  }
  private async parent(userId: string, choice: StoryVoiceChoice) {
    if (!choice.narratorManifestId) return null;
    if (
      choice.voiceConsentAccepted !== true ||
      choice.voiceConsentVersion !== STORY_PARENT_CONSENT_VERSION
    )
      throw new BadRequestException(
        'Подтвердите согласие на озвучку этой сказки выбранным голосом',
      );
    const manifest = await this.prisma.brandManifest.findFirst({
      where: { id: choice.narratorManifestId, userId, ttsProvider: 'resemble' },
      select: { id: true, ttsVoiceId: true },
    });
    const voice = manifest?.ttsVoiceId
      ? await this.prisma.userVoice.findFirst({
          where: {
            userId,
            resembleVoiceId: manifest.ttsVoiceId,
            status: 'READY',
          },
          select: {
            id: true,
            resembleVoiceId: true,
            consentAt: true,
            label: true,
          },
        })
      : null;
    if (!voice?.consentAt || !voice.resembleVoiceId)
      throw new ConflictException(
        'В профиле нужен собственный готовый клон Resemble с согласием владельца',
      );
    return {
      manifestId: manifest!.id,
      userVoiceId: voice.id,
      voiceId: voice.resembleVoiceId,
      label: voice.label,
      cloneConsentAt: voice.consentAt,
    };
  }
  private async assertParentActive(
    userId: string,
    userVoiceId: string | null | undefined,
    voiceId: string,
  ) {
    if (!userVoiceId) return;
    const voice = await this.prisma.userVoice.findFirst({
      where: {
        id: userVoiceId,
        userId,
        resembleVoiceId: voiceId,
        status: 'READY',
      },
      select: { consentAt: true },
    });
    if (!voice?.consentAt)
      throw new ConflictException(
        'Голос отозван или больше не готов; подмена на Nova не выполняется',
      );
  }
  async list(userId: string, giftId: string, locale: StoryTextLocale = 'ru') {
    const g = await this.gift(userId, giftId);
    const renders = await this.prisma.storyVideoRender.findMany({
      where: { giftId, status: { not: 'DELETED' } },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select,
    });
    const sum = await this.prisma.storyVideoRender.aggregate({
      where: { giftId },
      _sum: { reservedMicroUsd: true },
    });
    const base = storyVideoBaseFor(g.catalogId);
    const recordings = await this.prisma.storyVideoSegment.findMany({
      where: { giftId, source: 'recorded', status: 'READY' },
      select: {
        id: true,
        durationSeconds: true,
        audioHash: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 5,
    });
    let giftNote: { text: string; position: string } | null = null;
    try {
      giftNote = storyNarrationParts(g).giftNote;
    } catch {
      giftNote = null;
    }
    return {
      supported: !!base && g.voiceId === STORY_VOICE,
      base: base ?? BASE,
      baseUrl: storyAssetUrl('base', (base ?? BASE).revision),
      coverUrl: storyAssetUrl('cover', (base ?? BASE).revision),
      budgetUsd: g.budgetCents / 100,
      reservedUsd:
        (g.reservedMicroUsd + (sum._sum.reservedMicroUsd ?? 0)) / 1e6,
      // U-07: Soniox QA price of each render by its export length.
      renders: renders.map((r) => ({
        ...r,
        qaEstimateMicroUsd: r.durationSeconds
          ? storyVideoQaEstimate(r.durationSeconds)
          : null,
      })),
      narratorProfiles: await this.profiles(userId),
      voiceConsentVersion: STORY_PARENT_CONSENT_VERSION,
      // ST3: the consent texts in the request language (same version).
      voiceConsentText: STORY_PARENT_CONSENT_TEXTS[locale],
      voiceConsentLocale: locale,
      recordingConsentVersion: STORY_RECORDING_CONSENT_VERSION,
      recordingConsentText: STORY_RECORDING_CONSENT_TEXTS[locale],
      recordings: recordings.map((r) => ({
        id: r.id,
        seconds: r.durationSeconds,
        sha256: r.audioHash,
        createdAt: r.createdAt,
      })),
      giftNote,
      hasGiftPhoto: g.hasGiftPhoto,
      preambleSuggestions: storyOccasionLines(
        (g.occasionKind as StoryOccasionKind | null) ?? null,
        g.locale,
      ),
      limits: {
        preambleChars: 180,
        outroChars: 180,
        pronunciations: STORY_PRONUNCIATION_MAX,
        pronunciationChars: STORY_PRONUNCIATION_CHARS,
        recordingSeconds: {
          min: STORY_RECORDING_MIN_SECONDS,
          max: STORY_RECORDING_MAX_SECONDS,
        },
        recordingBytes: STORY_RECORDING_MAX_BYTES,
        totalSeconds: STORY_VIDEO_MAX_SECONDS,
      },
    };
  }
  private async own(userId: string, giftId: string, id: string) {
    await this.gift(userId, giftId);
    const r = await this.prisma.storyVideoRender.findFirst({
      where: { id, giftId, status: { not: 'DELETED' } },
      select,
    });
    if (!r) throw new NotFoundException('Сборка сказки не найдена');
    await this.assertParentActive(userId, r.userVoiceId, r.voiceId);
    return r;
  }
  /**
   * Р-ST-WP4-2. Resolves the ordered segment plan of one export without any
   * write or provider call. Shared by `quote()` (preview) and `create()`.
   * The video speaks exactly the approved gift words: preamble, the gift's
   * own note (WP3 layout) and the exact edition text — only voice and
   * segmentation differ.
   */
  private async prepare(
    userId: string,
    giftId: string,
    preambleText: string,
    choice: StoryVideoInput,
    quote: boolean,
  ) {
    const g = await this.gift(userId, giftId);
    // B-S3-7(2): lone surrogates are dropped at the video entry points.
    const preamble = stripStoryLoneSurrogates(preambleText ?? '').trim();
    if (!preamble || preamble.length > 180)
      throw new BadRequestException('Преамбула: от 1 до 180 символов');
    assertStoryPromiseFree(preamble, g.locale);
    const outro =
      stripStoryLoneSurrogates(choice.outroText ?? '').trim() || null;
    if (outro && outro.length > 180)
      throw new BadRequestException('Завершение: до 180 символов');
    if (outro) assertStoryPromiseFree(outro, g.locale);
    let pronunciations: ReturnType<typeof parseStoryPronunciations>;
    try {
      pronunciations = parseStoryPronunciations(choice.pronunciations);
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
    const base = storyVideoBaseFor(g.catalogId);
    if (
      !base ||
      g.voiceId !== STORY_VOICE ||
      !g.audioHash ||
      !g.durationSeconds ||
      g.audioQaStatus !== 'PASS'
    )
      throw new ConflictException(
        'Нужна проверенная точная сказка Nova с опубликованным базовым видеопакетом этой редакции',
      );
    if (storyChaptersSha256(g.chapters) !== base.textSha256)
      throw new ConflictException(
        'Текст подарка не совпадает с редакцией базового видео: нужна совместимая новая версия видеопакета',
      );
    let parts: ReturnType<typeof storyNarrationParts>;
    try {
      parts = storyNarrationParts(g);
    } catch {
      throw new ConflictException(
        'Раскладка текста подарка не сходится с записью; сборка остановлена без оплаты',
      );
    }
    // B-S3-6: the gift note enters the video (also inside the Nova MP3 of
    // pre-WP3 gifts, narrationLayout = null) — same validator before any cost.
    if (parts.giftNote) assertStoryPromiseFree(parts.giftNote.text, g.locale);
    const consentMissing =
      !!choice.narratorManifestId &&
      (choice.voiceConsentAccepted !== true ||
        choice.voiceConsentVersion !== STORY_PARENT_CONSENT_VERSION);
    // A quote only resolves ownership/readiness; consent still gates paid work.
    const parent = await this.parent(
      userId,
      quote && choice.narratorManifestId
        ? {
            ...choice,
            voiceConsentAccepted: true,
            voiceConsentVersion: STORY_PARENT_CONSENT_VERSION,
          }
        : choice,
    );
    if (choice.useNarratorImage === true && !parent)
      throw new BadRequestException(
        'Образ рассказчика в кадре вступления доступен только с голосом из профиля',
      );
    const narrator =
      choice.useNarratorImage === true && parent
        ? narratorSnapshot(await this.narratorImage(parent.manifestId, userId))
        : null;
    const introVisual = narrator ? ('narrator' as const) : ('cover' as const);
    const voiceId = parent?.voiceId ?? STORY_VOICE;
    const userVoiceId = parent?.userVoiceId ?? null;
    const consent = parent
      ? `${STORY_PARENT_CONSENT_VERSION}:${parent.cloneConsentAt.toISOString()}`
      : 'nova';
    const synth = (
      kind: 'intro' | 'gift_note' | 'outro',
      text: string,
      extra: Partial<PlannedSegment> = {},
    ): PlannedSegment => {
      const tts = applyStoryPronunciations(text, pronunciations);
      if (tts.text.length > 400)
        throw new BadRequestException('Текст для озвучки слишком длинный');
      // B-S2-1: what TTS actually says passes the same validator.
      assertSpokenPromiseFree(tts.text, g.locale);
      return {
        kind,
        source: 'synth',
        text,
        ...(tts.text !== text ? { ttsText: tts.text } : {}),
        ...(tts.applied.length ? { pronunciations: tts.applied } : {}),
        cacheKey: storySegmentKey({
          text: tts.text,
          voiceId,
          userVoiceId,
          consent,
          language: g.locale,
        }),
        voiceId,
        visual: 'cover',
        mime: 'audio/mpeg',
        audioHash: null,
        seconds: null,
        ...extra,
      };
    };
    // Main speech: pinned Nova MP3 of the gift, or the clone's narration of the
    // exact edition text (reused by parentNarrationKey across preambles/notes).
    const mainTts = applyStoryPronunciations(parts.main, pronunciations);
    if (parent && mainTts.applied.length) {
      // B-S2-1: a classic edition is spoken exactly as published.
      if ((storyEdition(g.catalogId)?.kind ?? 'classic') === 'classic')
        throw new BadRequestException(
          `Произношение не применяется к тексту классической редакции: «${mainTts.applied.join('», «')}» есть в самой сказке, а она озвучивается точно по изданию. Уберите эти пары; для вступления, реплики и завершения подходят пары со словами, которых нет в тексте сказки`,
        );
      assertSpokenPromiseFree(mainTts.text, g.locale);
    }
    const narrationKey = parent
      ? digest(
          JSON.stringify({
            giftId,
            text: parts.main,
            userVoiceId: parent.userVoiceId,
            voiceId,
            consentAt: parent.cloneConsentAt.toISOString(),
            ...(mainTts.applied.length ? { tts: mainTts.text } : {}),
          }),
        )
      : null;
    const segments: PlannedSegment[] = [];
    if (choice.preambleSource === 'recorded') {
      const rec = choice.recordingId
        ? await this.prisma.storyVideoSegment.findFirst({
            where: {
              id: choice.recordingId,
              giftId,
              source: 'recorded',
              status: 'READY',
            },
            select: {
              id: true,
              cacheKey: true,
              audioHash: true,
              durationSeconds: true,
            },
          })
        : null;
      if (!rec)
        throw new BadRequestException(
          'Запись вступления не найдена: загрузите её снова',
        );
      segments.push({
        kind: 'intro',
        source: 'recorded',
        text: preamble,
        cacheKey: rec.cacheKey,
        voiceId: null,
        visual: introVisual,
        mime: 'audio/wav',
        audioHash: rec.audioHash,
        seconds: rec.durationSeconds,
        recordingId: rec.id,
      });
    } else segments.push(synth('intro', preamble, { visual: introVisual }));
    // Nova: the note is already inside the approved, QA-checked gift MP3 (WP3
    // keeps the glued text for the audio version) — reused as is, no new
    // synthesis. A profile voice speaks it as a separate segment instead.
    const separateNote = parent && parts.giftNote ? parts.giftNote : null;
    const note = separateNote
      ? synth('gift_note', separateNote.text, {
          position: separateNote.position,
          visual: g.hasGiftPhoto ? 'photo' : 'cover',
        })
      : null;
    if (note?.position === 'beginning') segments.push(note);
    segments.push(
      parent
        ? {
            kind: 'main',
            source: 'parent',
            text: parts.main,
            ...(mainTts.text !== parts.main ? { ttsText: mainTts.text } : {}),
            ...(mainTts.applied.length
              ? { pronunciations: mainTts.applied }
              : {}),
            cacheKey: narrationKey!,
            voiceId,
            visual: 'base',
            mime: 'audio/mpeg',
            audioHash: null,
            seconds: null,
          }
        : {
            kind: 'main',
            source: 'gift',
            text: g.text,
            cacheKey: g.audioHash,
            voiceId: STORY_VOICE,
            visual: 'base',
            mime: 'audio/mpeg',
            audioHash: g.audioHash,
            seconds: g.durationSeconds,
            ...(parts.giftNote ? { includes: ['gift_note' as const] } : {}),
          },
    );
    if (note?.position === 'end') segments.push(note);
    if (outro) segments.push(synth('outro', outro));
    const intro = segments[0];
    const legacy =
      segments.length === 2 &&
      intro.source === 'synth' &&
      intro.visual === 'cover' &&
      !intro.ttsText &&
      // Nova main speech is the pinned MP3: pairs matching its words change
      // nothing audible, so they must not fork the legacy config hash.
      !(parent && mainTts.applied.length);
    const mainKey = parent
      ? digest(
          `${narrationKey}:${parent.manifestId}:${STORY_PARENT_CONSENT_VERSION}`,
        )
      : g.audioHash;
    // Version-1 key for the legacy layout keeps old renders deduplicating.
    const configHash = storyVideoConfigHash(
      mainKey,
      preamble,
      legacy
        ? undefined
        : segments.map((s) => [
            s.kind,
            s.position ?? null,
            s.source,
            s.cacheKey,
            s.visual,
            // Narrator frame only: the exact image and its consent snapshot.
            // Absent from every earlier layout, so their keys stay unchanged.
            ...(s.visual === 'narrator' && narrator
              ? [narrator.assetHash, narrator.lookId, narrator.consentVersion]
              : []),
          ]),
      base.baseSha256,
    );
    const hints = [preamble, outro]
      .filter((t): t is string => !!t)
      .flatMap((t) => checkStoryPromises(t, g.locale).hints);
    return {
      g,
      base,
      preamble,
      parent,
      voiceId,
      narrationKey,
      mainTts: mainTts.text,
      segments,
      configHash,
      consentMissing,
      hints,
      narrator,
    };
  }
  /** Cached synth segments of this gift only (never another owner/gift). */
  private async segmentRows(
    db: Pick<PrismaService, 'storyVideoSegment'>,
    giftId: string,
    keys: string[],
  ) {
    if (!keys.length) return new Map<string, SegmentRow>();
    const rows = await db.storyVideoSegment.findMany({
      where: { giftId, cacheKey: { in: keys } },
      select: {
        id: true,
        cacheKey: true,
        status: true,
        audioHash: true,
        durationSeconds: true,
      },
    });
    return new Map<string, SegmentRow>(rows.map((r) => [r.cacheKey, r]));
  }
  /**
   * A-S2-1: the parent main narration for `key`. A render that stored it is
   * reused; otherwise any render still holding the key — in progress,
   * UNKNOWN, FAILED or even purged by retention while unconfirmed — blocks a
   * new paid synthesis (`mainAudio: null`). The key is released only by an
   * operator with confirmed absence of a provider charge.
   */
  private async priorNarration(
    db: Pick<PrismaService, 'storyVideoRender'>,
    giftId: string,
    key: string | null,
  ) {
    if (!key) return null;
    const select = { mainAudio: true, mainAudioHash: true, mainDuration: true };
    return (
      (await db.storyVideoRender.findFirst({
        where: {
          giftId,
          parentNarrationKey: key,
          status: { not: 'DELETED' },
          mainDuration: { not: null },
        },
        select,
      })) ??
      (await db.storyVideoRender.findFirst({
        where: { giftId, parentNarrationKey: key },
        select,
      }))
    );
  }
  /**
   * Р-ST-WP4-6. Repeat-order estimate with no side effects: no writes, no
   * provider calls. Shows which segments are reused, which would be
   * synthesized, the reserve and whether the remaining budget covers it.
   */
  async quote(
    userId: string,
    giftId: string,
    preambleText: string,
    choice: StoryVideoInput = {},
  ) {
    const p = await this.prepare(userId, giftId, preambleText, choice, true);
    const slot = await this.prisma.storyVideoRender.findUnique({
      where: { giftId_configHash: { giftId, configHash: p.configHash } },
      select: { id: true, status: true },
    });
    const existing = slot && !DEAD_RENDER.includes(slot.status) ? slot : null;
    const synthKeys = p.segments
      .filter((s) => s.source === 'synth')
      .map((s) => s.cacheKey);
    const rows = await this.segmentRows(this.prisma, giftId, synthKeys);
    const prior = await this.priorNarration(
      this.prisma,
      giftId,
      p.narrationKey,
    );
    const pending = new Set<string>();
    const lines = p.segments.map((s) => {
      const row = rows.get(s.cacheKey);
      let state: 'reuse' | 'synthesize' | 'blocked' = 'reuse';
      let seconds = s.seconds;
      if (s.source === 'synth') {
        if (row?.status === 'READY') seconds = row.durationSeconds;
        else if (row && row.status !== 'DELETED') state = 'blocked';
        else if (pending.has(s.cacheKey)) state = 'reuse';
        else {
          state = 'synthesize';
          pending.add(s.cacheKey);
        }
      } else if (s.source === 'parent') {
        if (!prior) state = 'synthesize';
        else if (!prior.mainAudio) state = 'blocked';
        else seconds = prior.mainDuration;
      }
      return {
        kind: s.kind,
        ...(s.position ? { position: s.position } : {}),
        source: s.source,
        text: s.text,
        ttsText: s.ttsText ?? s.text,
        pronunciations: s.pronunciations ?? [],
        ...(s.includes ? { includes: s.includes } : {}),
        visual: s.visual,
        state,
        seconds,
        characters:
          state === 'synthesize'
            ? (s.source === 'parent' ? p.mainTts : (s.ttsText ?? s.text)).length
            : 0,
      };
    });
    const synthText = lines
      .filter((l) => l.state === 'synthesize' && l.source === 'synth')
      .map((l) => l.ttsText)
      .join('');
    const reserve = storyVideoReserve(
      synthText,
      lines.some((l) => l.source === 'parent' && l.state === 'synthesize')
        ? p.mainTts
        : '',
    );
    const day = new Date();
    day.setUTCHours(0, 0, 0, 0);
    const daily = await this.prisma.storyVideoRender.count({
      where: { giftId, createdAt: { gte: day } },
    });
    const sum = await this.prisma.storyVideoRender.aggregate({
      where: { giftId },
      _sum: { reservedMicroUsd: true },
    });
    const reserved = p.g.reservedMicroUsd + (sum._sum.reservedMicroUsd ?? 0);
    const budget = p.g.budgetCents * 10000;
    const blockers: string[] = [];
    if (p.consentMissing)
      blockers.push(
        'Нужно подтверждение согласия на озвучку выбранным голосом',
      );
    if (lines.some((l) => l.state === 'blocked'))
      blockers.push(
        'Часть речи этого голоса уже готовится либо требует проверки оператором; повторная оплата отключена',
      );
    if (!existing && daily >= 3)
      blockers.push('Пилот: три сборки одного подарка в сутки');
    if (!existing && reserved + reserve > budget)
      blockers.push('Оставшегося бюджета не хватит на эту версию');
    // Unknown durations (not synthesized yet) are estimated from the text:
    // ≈14 characters per second of calm reading (story-budget.ts).
    const estimated = lines.some((l) => !l.seconds);
    const timed = lines.map((l) => ({
      kind: l.kind,
      position: l.position,
      seconds:
        l.seconds ||
        Math.max(
          1,
          Math.round(
            ((l.source === 'parent' ? p.mainTts : l.ttsText).length /
              STORY_SPEECH_CHARS_PER_SECOND) *
              10,
          ) / 10,
        ),
    }));
    const layout = storyVideoLayout(timed, p.base);
    // ST3 (Р-ST3-2): what this version costs in credits (0 — reused render, owner).
    const charge = existing
      ? { ...STORY_CHARGE_NONE }
      : await this.charges.quote(await this.charges.facts(userId), userId, {
          kind: 'video',
          giftId,
          reserveMicroUsd: reserve,
        });
    const warnings: string[] = [];
    if (layout.durationSeconds > STORY_VIDEO_MAX_SECONDS)
      warnings.push(
        `Итог ${estimated ? 'по оценке ' : ''}${layout.durationSeconds.toFixed(1)} с — длиннее ${STORY_VIDEO_MAX_SECONDS} с: сократите вступление или завершение`,
      );
    return {
      sideEffects: 'none' as const,
      configHash: p.configHash,
      existingRender: existing,
      baseRevision: p.base.revision,
      baseHash: p.base.baseSha256,
      voice: {
        label: p.parent?.label ?? 'Nova',
        profile: p.parent ? ('parent' as const) : ('nova' as const),
        /** The existing clone is reused; a repeat order never re-clones. */
        cloning: false as const,
      },
      segments: lines,
      narrator: p.narrator
        ? {
            kind: p.narrator.kind,
            lookId: p.narrator.lookId,
            asset: p.narrator.asset,
            style: p.narrator.style,
            assetHash: p.narrator.assetHash,
            consentVersion: p.narrator.consentVersion,
          }
        : null,
      tracks: { speech: lines.map((l) => l.kind), music: [], effects: [] },
      layout,
      layoutEstimated: estimated,
      warnings,
      reserveMicroUsd: existing ? 0 : reserve,
      charge,
      /**
       * U-07: Soniox check of the finished video (by the layout length,
       * ai-pricing `soniox-stt-async`); the reserve holds a fixed
       * STORY_VIDEO_QA_RESERVE_MICRO_USD for it.
       */
      qaEstimateMicroUsd: storyVideoQaEstimate(layout.durationSeconds),
      reservedMicroUsd: reserved,
      budgetMicroUsd: budget,
      remainingMicroUsd: Math.max(0, budget - reserved),
      fits: !blockers.length,
      blockers,
      hints: p.hints,
    };
  }
  async create(
    userId: string,
    giftId: string,
    preambleText: string,
    choice: StoryVideoInput = {},
    /** ST3: language of the consent text the adult confirmed. */
    consentLocale: StoryTextLocale = 'ru',
  ) {
    const p = await this.prepare(userId, giftId, preambleText, choice, false);
    const { g, base, parent, voiceId, narrationKey, configHash } = p;
    // B-S3-7(1): a repeat of an existing configuration re-runs every current
    // check above (validator, consent, voice, image) before it gets the
    // existing render back — no paid call either way.
    const existing = await this.prisma.storyVideoRender.findUnique({
      where: { giftId_configHash: { giftId, configHash } },
      select,
    });
    if (existing && !DEAD_RENDER.includes(existing.status)) return existing;
    const needsTts = !!parent || p.segments.some((s) => s.source === 'synth');
    if (!this.ffmpeg.configured() || (needsTts && !this.tts.configured()))
      throw new ServiceUnavailableException(
        'Сборка или озвучка временно недоступны',
      );
    const api = publicApi(); // Validate before spending.
    await this.plan.assertCanSpendUser(userId);
    const facts = await this.charges.facts(userId);
    const synthKeys = [
      ...new Set(
        p.segments.filter((s) => s.source === 'synth').map((s) => s.cacheKey),
      ),
    ];
    const claim = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`story-video:${giftId}`}))::text`;
      const cached = await tx.storyVideoRender.findUnique({
        where: { giftId_configHash: { giftId, configHash } },
        select,
      });
      if (cached && !DEAD_RENDER.includes(cached.status))
        return { fresh: false, row: cached, claimed: [] };
      const current = await tx.storyGift.findFirst({
        where: {
          id: giftId,
          userId,
          status: { in: ['READY', 'APPROVED'] },
          audioHash: g.audioHash,
        },
      });
      if (!current) throw new ConflictException('Выпуск изменился');
      const prior = await this.priorNarration(tx, giftId, narrationKey);
      if (prior && !prior.mainAudio)
        throw new ConflictException(
          'Основная речь этого голоса уже готовится либо требует проверки; повторная оплата отключена',
        );
      const rows = await this.segmentRows(tx, giftId, synthKeys);
      const toSynth = synthKeys.filter((k) => {
        const row = rows.get(k);
        if (row && row.status !== 'READY' && row.status !== 'DELETED')
          throw new ConflictException(
            'Часть речи этого голоса уже готовится либо требует проверки оператором; повторная оплата отключена',
          );
        return !row || row.status === 'DELETED';
      });
      const recording = p.segments.find((s) => s.recordingId);
      if (
        recording &&
        !(await tx.storyVideoSegment.findFirst({
          where: {
            id: recording.recordingId,
            giftId,
            status: 'READY',
            audioHash: recording.audioHash,
          },
          select: { id: true },
        }))
      )
        throw new BadRequestException('Запись вступления была удалена');
      const ttsOf = (key: string) => {
        const s = p.segments.find((x) => x.cacheKey === key)!;
        return s.ttsText ?? s.text;
      };
      const reserve = storyVideoReserve(
        toSynth.map(ttsOf).join(''),
        parent && !prior ? p.mainTts : '',
      );
      const day = new Date();
      day.setUTCHours(0, 0, 0, 0);
      const daily = await tx.storyVideoRender.count({
        where: { giftId, createdAt: { gte: day } },
      });
      const sum = await tx.storyVideoRender.aggregate({
        where: { giftId },
        _sum: { reservedMicroUsd: true },
      });
      if (daily >= 3)
        throw new BadRequestException(
          'Пилот: три сборки одного подарка в сутки',
        );
      if (
        current.reservedMicroUsd + (sum._sum.reservedMicroUsd ?? 0) + reserve >
        current.budgetCents * 10000
      )
        throw new BadRequestException(
          'Оставшегося бюджета не хватит на эту версию',
        );
      // Claim each new segment once: a concurrent render sees PENDING and stops.
      for (const key of toSynth) {
        const data = {
          source: 'synth',
          status: 'PENDING',
          text: ttsOf(key),
          voiceId,
          userVoiceId: parent?.userVoiceId ?? null,
          mime: 'audio/mpeg',
          audio: null,
          audioHash: null,
          durationSeconds: null,
        };
        const old = rows.get(key);
        if (old)
          await tx.storyVideoSegment.updateMany({
            where: { id: old.id, status: 'DELETED' },
            data,
          });
        else
          await tx.storyVideoSegment.create({
            data: { giftId, cacheKey: key, ...data },
          });
      }
      const manifest: StoryVideoSegmentsManifest = {
        version: 1,
        baseRevision: base.revision,
        baseHash: base.baseSha256,
        segments: p.segments.map(({ recordingId: _r, ...s }) => {
          void _r;
          const row = rows.get(s.cacheKey);
          return row?.status === 'READY'
            ? { ...s, audioHash: row.audioHash, seconds: row.durationSeconds }
            : s;
        }),
        tracks: {
          speech: p.segments.map((s) => s.cacheKey),
          music: [],
          effects: [],
        },
        mix: STORY_VIDEO_MIX,
        layout: null,
        ...(p.narrator ? { narrator: p.narrator } : {}),
      };
      // A-S2-2: a FAILED/DELETED attempt of this configuration is history.
      if (cached) {
        const moved = await tx.storyVideoRender.updateMany({
          where: { id: cached.id, status: cached.status, configHash },
          data: { configHash: `${configHash}:retired:${cached.id}` },
        });
        if (!moved.count) throw new ConflictException('Сборка изменилась');
      }
      const row = await tx.storyVideoRender.create({
        data: {
          giftId,
          configHash,
          preambleText: p.preamble,
          baseRevision: base.revision,
          baseHash: base.baseSha256,
          mainAudioHash: g.audioHash!,
          voiceId,
          voiceLabel: parent?.label ?? 'Nova',
          segments: manifest as unknown as Prisma.InputJsonValue,
          ...(parent
            ? {
                narratorManifestId: parent.manifestId,
                userVoiceId: parent.userVoiceId,
                voiceConsentAt: new Date(),
                voiceConsentVersion: STORY_PARENT_CONSENT_VERSION,
                voiceConsentLocale: consentLocale,
                parentNarrationKey: narrationKey,
                ...(prior
                  ? {
                      mainAudio: prior.mainAudio,
                      mainAudioHash: prior.mainAudioHash,
                      mainDuration: prior.mainDuration,
                    }
                  : {}),
              }
            : {}),
          reservedMicroUsd: reserve,
        },
        select,
      });
      // ST3 (Р-ST3-2): credits for this paid export, in the claim transaction
      // (402 rolls the render and the segment claims back).
      await this.charges.reserve(
        tx,
        facts,
        userId,
        {
          kind: 'video',
          giftId,
          renderId: row.id,
          reserveMicroUsd: reserve,
        },
        choice.expectedCredits,
      );
      return { fresh: true, row, claimed: toSynth };
    });
    const id = claim.row.id;
    if (!claim.fresh) return claim.row;
    const claimed = new Set(claim.claimed);
    const attempted = new Set<string>();
    let stage:
      | 'base'
      | 'main'
      | 'voice'
      | 'note'
      | 'outro'
      | 'spend'
      | 'plan'
      | 'narrator'
      | 'submit' = 'base';
    let narratorProblem = '';
    let spendProblem = '';
    /** Characters this attempt actually sent to TTS (A-S3-4). */
    let paidChars = 0;
    /**
     * ST3-S-08/S-09: a paid call is in flight or ended without a certain
     * outcome. False — every provider call so far either was not made or
     * ended certainly (saved result, or skipped / final 4xx: not billed).
     */
    let uncertain = false;
    /** Segment keys whose synthesis was certainly not billed. */
    const unbilledKeys = new Set<string>();
    try {
      // Fail before synthesis if the published master does not match the approved version.
      const source = await fetchPubliclyRoutable(
        storyAssetUrl('base', base.revision),
        { signal: AbortSignal.timeout(20000) },
      );
      if (
        !source.ok ||
        digest(await readBodyWithLimit(source, MAX_VIDEO)) !== base.baseSha256
      )
        throw new Error('Base mismatch');
      let mainSeconds = g.durationSeconds!;
      if (parent) {
        await this.assertParentActive(userId, parent.userVoiceId, voiceId);
        const row = await this.prisma.storyVideoRender.findUniqueOrThrow({
          where: { id },
          select: { mainAudio: true, mainDuration: true },
        });
        if (row.mainAudio) mainSeconds = row.mainDuration!;
        else {
          stage = 'main';
          paidChars += p.mainTts.length;
          uncertain = true;
          const main = await this.tts.synthesize({
            text: p.mainTts,
            voiceId,
            language: g.locale,
          });
          if (!main.ok) {
            if (storyTtsUnbilled(main)) {
              uncertain = false;
              paidChars -= p.mainTts.length;
            }
            throw new Error('Main synthesis unconfirmed');
          }
          await this.usage.record({
            operation: 'story-voiceover',
            model: 'resemble-tts',
            characters: main.characters,
            userId,
          });
          if (
            main.voiceId !== voiceId ||
            main.mimeType !== 'audio/mpeg' ||
            !main.durationSeconds ||
            main.durationSeconds < 40 ||
            main.durationSeconds > 90 ||
            main.audio.length > 2097152
          )
            throw new Error('Invalid main narration');
          mainSeconds = main.durationSeconds;
          const saved = await this.prisma.storyVideoRender.updateMany({
            where: {
              id,
              status: 'PREPARING',
              gift: { status: { in: ['READY', 'APPROVED'] } },
            },
            data: {
              mainAudio: new Uint8Array(main.audio),
              mainAudioHash: digest(main.audio),
              mainDuration: mainSeconds,
              // ST2-S-01: confirmed, saved speech of this render — an
              // operator close keeps its TTS reserve.
              paidSpeechChars: { increment: p.mainTts.length },
            },
          });
          if (!saved.count) throw new Error('Render cancelled');
          uncertain = false;
        }
      }
      const done = new Map<string, { audioHash: string; seconds: number }>();
      let introAudio: Uint8Array<ArrayBuffer> | null = null;
      for (const s of p.segments) {
        if (s.source !== 'synth' || !claimed.has(s.cacheKey)) continue;
        if (done.has(s.cacheKey) || attempted.has(s.cacheKey)) continue;
        stage = segmentStage[s.kind];
        await this.assertParentActive(userId, parent?.userVoiceId, voiceId);
        attempted.add(s.cacheKey);
        paidChars += (s.ttsText ?? s.text).length;
        uncertain = true;
        const audio = await this.tts.synthesize({
          text: s.ttsText ?? s.text,
          voiceId,
          language: g.locale,
        });
        if (!audio.ok) {
          if (storyTtsUnbilled(audio)) {
            uncertain = false;
            unbilledKeys.add(s.cacheKey);
            paidChars -= (s.ttsText ?? s.text).length;
          }
          throw new Error('Segment synthesis unconfirmed');
        }
        await this.usage.record({
          operation: 'story-voiceover',
          model: 'resemble-tts',
          characters: audio.characters,
          userId,
        });
        if (
          audio.voiceId !== voiceId ||
          audio.mimeType !== 'audio/mpeg' ||
          !audio.durationSeconds ||
          audio.durationSeconds < STORY_SEGMENT_MIN_SECONDS ||
          audio.durationSeconds > STORY_SEGMENT_MAX_SECONDS ||
          audio.audio.length > 1048576
        )
          throw new Error('Invalid segment media');
        const audioHash = digest(audio.audio);
        // A-S3-6: never store speech for a gift deleted meanwhile.
        const saved = await this.prisma.storyVideoSegment.updateMany({
          where: {
            giftId,
            cacheKey: s.cacheKey,
            status: 'PENDING',
            gift: { status: { in: ['READY', 'APPROVED'] } },
          },
          data: {
            status: 'READY',
            audio: new Uint8Array(audio.audio),
            audioHash,
            durationSeconds: audio.durationSeconds,
          },
        });
        if (!saved.count) throw new Error('Segment cancelled');
        // ST2-S-01: the saved segment was bought by this render.
        await this.prisma.storyVideoRender.updateMany({
          where: { id, status: { not: 'DELETED' } },
          data: {
            paidSpeechChars: { increment: (s.ttsText ?? s.text).length },
          },
        });
        done.set(s.cacheKey, { audioHash, seconds: audio.durationSeconds });
        uncertain = false;
        if (s.kind === 'intro') introAudio = new Uint8Array(audio.audio);
      }
      // A-S3-3: the plan's spend gate is its own stage (known stop, no submit).
      stage = 'spend';
      try {
        await this.plan.assertCanSpendUser(userId);
      } catch (e) {
        spendProblem = e instanceof Error ? e.message : 'расходы недоступны';
        throw e;
      }
      stage = 'plan';
      const stored = storyManifest(
        (
          await this.prisma.storyVideoRender.findUniqueOrThrow({
            where: { id },
            select: { segments: true },
          })
        ).segments,
      )!;
      const segments = stored.segments.map((s) => {
        const fresh = done.get(s.cacheKey);
        if (fresh) return { ...s, ...fresh };
        if (s.kind === 'main')
          return {
            ...s,
            seconds: mainSeconds,
            audioHash:
              s.source === 'gift' ? g.audioHash : (s.audioHash ?? null),
          };
        return s;
      });
      if (segments.some((s) => !s.seconds))
        throw new Error('Segment duration unknown');
      const introSeg = segments[0];
      if (!introAudio) {
        const row = await this.prisma.storyVideoSegment.findFirst({
          where: {
            giftId,
            cacheKey: introSeg.cacheKey,
            status: 'READY',
            audioHash: introSeg.audioHash!,
          },
          select: { audio: true },
        });
        if (!row?.audio) throw new Error('Intro audio missing');
        introAudio = new Uint8Array(row.audio);
      }
      if (digest(introAudio) !== introSeg.audioHash)
        throw new Error('Intro audio mismatch');
      const planned = planStorySegments({
        segments: segments.map((s) => ({
          kind: s.kind,
          ...(s.position ? { position: s.position } : {}),
          seconds: s.seconds!,
          visual: s.visual,
          ...(s.source === 'recorded' ? { normalize: true } : {}),
        })),
        baseSeconds: base.durationSeconds,
      });
      const layout = storyVideoLayout(
        segments.map((s) => ({
          kind: s.kind,
          position: s.position,
          seconds: s.seconds!,
        })),
        base,
      );
      const token = randomBytes(32).toString('base64url');
      const saved = await this.prisma.storyVideoRender.updateMany({
        where: {
          id,
          status: 'PREPARING',
          gift: { status: { in: ['READY', 'APPROVED'] } },
        },
        data: {
          preambleAudio: introAudio,
          preambleDuration: introSeg.seconds,
          durationSeconds: planned.durationSeconds,
          segments: {
            ...stored,
            segments,
            layout,
          } as unknown as Prisma.InputJsonValue,
          assetTokenHash: digest(token),
          assetExpiresAt: new Date(Date.now() + 30 * 60000),
        },
      });
      if (!saved.count) throw new Error('Render cancelled');
      const input = (kind: string) =>
        `${api}story-render-input/${token}/${kind}`;
      if (p.narrator) {
        // Re-check like assertParentActive: consent/look may change while TTS ran.
        stage = 'narrator';
        try {
          const now = narratorSnapshot(
            await this.narratorImage(p.narrator.manifestId, userId),
          );
          if (!sameNarrator(now, p.narrator))
            throw new ConflictException(
              'Образ рассказчика изменился после запуска сборки',
            );
        } catch (e) {
          narratorProblem =
            e instanceof Error ? e.message : 'Образ рассказчика недоступен';
          throw e;
        }
      }
      stage = 'submit';
      await this.assertParentActive(userId, parent?.userVoiceId, voiceId);
      uncertain = true;
      const job = await this.ffmpeg.submit({
        inputs: Object.fromEntries(
          Object.entries(planned.inputs).map(([key, part]) => [
            key,
            input(part),
          ]),
        ),
        outputs: planned.outputs,
        commands: planned.commands,
        retrySubmit: false,
      });
      await this.prisma.storyVideoRender.updateMany({
        where: {
          id,
          status: 'PREPARING',
          gift: { status: { in: ['READY', 'APPROVED'] } },
        },
        data: { status: 'PENDING', jobId: job.jobId },
      });
      await this.usage.record({
        operation: 'story-video-assembly',
        model: 'ffmpeg-api',
        userId,
      });
    } catch {
      // Unattempted claims cost nothing: release them. An attempted segment
      // without a confirmed result may have been billed: UNKNOWN, no retry.
      for (const key of claimed)
        await this.prisma.storyVideoSegment
          .updateMany({
            where: { giftId, cacheKey: key, status: 'PENDING' },
            data:
              attempted.has(key) && !unbilledKeys.has(key)
                ? { status: 'UNKNOWN' }
                : { status: 'DELETED', text: '' },
          })
          .catch(() => undefined);
      const what = {
        base: 'проверка базового видео',
        main: 'озвучка основной сказки',
        voice: 'озвучка преамбулы',
        note: 'озвучка реплики о подарке',
        outro: 'озвучка завершения',
        spend: 'проверка лимита расходов',
        plan: 'проверка длительностей сегментов',
        narrator: 'проверка образа рассказчика',
        submit: 'отправка сборщику',
      }[stage];
      // A-S3-4: stopped before the provider submit (spend/plan/narrator) is a
      // known FAILED: FFmpeg never ran, so the assembly + QA reserve is
      // released; only the speech this attempt really requested stays reserved
      // (it is READY in the cache and the next attempt reuses it for free).
      const stopped = {
        status: 'FAILED',
        assetTokenHash: null,
        assetExpiresAt: null,
        reservedMicroUsd: storyVideoTtsReserve(paidChars),
      };
      const kept =
        ' Готовые сегменты речи сохранены и переиспользуются без новой оплаты; резерв сборки освобождён; кредиты за эту попытку, если были списаны, возвращены.';
      // ST3-S-08: no paid call in flight or uncertain → a known, final stop.
      const stoppedBeforeSubmit = !uncertain;
      const closed = await this.prisma.storyVideoRender.updateMany({
        where: { id, status: 'PREPARING' },
        data:
          stage === 'narrator'
            ? {
                ...stopped,
                error: `Сборка остановлена до отправки: образ рассказчика недоступен (${narratorProblem.slice(0, 200)}). Обложка или оригинал молча не подставляются.${kept}`,
              }
            : stage === 'spend'
              ? {
                  ...stopped,
                  error: `Сборка остановлена до отправки: тариф сейчас не разрешает новые расходы (${spendProblem.slice(0, 200)}).${kept}`,
                }
              : stage === 'plan'
                ? {
                    ...stopped,
                    error: `Сборка остановлена до отправки: ${what} (итог до ${STORY_VIDEO_MAX_SECONDS} с, основная речь 40–90 с, остальные сегменты ${STORY_SEGMENT_MIN_SECONDS}–${STORY_SEGMENT_MAX_SECONDS} с).${kept}`,
                  }
                : stoppedBeforeSubmit
                  ? {
                      ...stopped,
                      error: `Сборка остановлена на этапе «${what}» без оплаты провайдеру (вызов не выполнялся или отклонён до списания).${kept}`,
                    }
                  : {
                      status: 'UNKNOWN',
                      // A-S3-9: at submit the token hash stays as the job's input
                      // fingerprint for bind-job; expired, so nothing is served.
                      ...(stage === 'submit'
                        ? { assetExpiresAt: new Date() }
                        : { assetTokenHash: null }),
                      error: `Сборка не подтверждена на этапе «${what}». Платный повтор отключён; нужна проверка оператором.`,
                    },
      });
      // ST3: a known stop before the provider submit is final — refund; an
      // UNKNOWN stage keeps the credits until the operator reconciles.
      if (stoppedBeforeSubmit && closed.count)
        await this.refundRender(giftId, id);
    }
    return this.own(userId, giftId, id);
  }
  /**
   * ST-P1: the adult's own preamble recording. Canonical WAV only (the client
   * re-encodes its MediaRecorder file), 1–20 s, not silent; stored privately
   * in this gift, content-addressed, never sent anywhere until a render.
   */
  async uploadRecording(
    userId: string,
    giftId: string,
    dto: { base64: string; consentVersion?: string; consentAccepted?: boolean },
    consentLocale: StoryTextLocale = 'ru',
  ) {
    await this.gift(userId, giftId);
    if (
      dto.consentAccepted !== true ||
      dto.consentVersion !== STORY_RECORDING_CONSENT_VERSION
    )
      throw new BadRequestException(
        'Подтвердите согласие на использование своей записи',
      );
    const raw = dto.base64 ?? '';
    if (
      !/^[A-Za-z0-9+/]+={0,2}$/.test(raw) ||
      raw.length > Math.ceil((STORY_RECORDING_MAX_BYTES * 4) / 3) + 4
    )
      throw new BadRequestException('Запись: до 1 МБ в base64');
    const bytes = Buffer.from(raw, 'base64');
    const wav =
      bytes.length <= STORY_RECORDING_MAX_BYTES ? parseStoryWav(bytes) : null;
    if (!wav)
      throw new BadRequestException(
        'Нужна запись WAV (PCM 16 бит, моно, 16–48 кГц) до 1 МБ',
      );
    if (
      wav.seconds < STORY_RECORDING_MIN_SECONDS ||
      wav.seconds > STORY_RECORDING_MAX_SECONDS
    )
      throw new BadRequestException(
        `Длительность вступления — от ${STORY_RECORDING_MIN_SECONDS} до ${STORY_RECORDING_MAX_SECONDS} секунд`,
      );
    if (wav.peak < 0.02 || wav.rms < 0.003)
      throw new BadRequestException(
        'Запись почти беззвучна — проверьте микрофон',
      );
    const sha256 = digest(bytes);
    const cacheKey = storyRecordingKey(sha256);
    const data = {
      source: 'recorded',
      status: 'READY',
      text: '',
      voiceId: null,
      userVoiceId: null,
      mime: 'audio/wav',
      audio: new Uint8Array(bytes),
      audioHash: sha256,
      durationSeconds: wav.seconds,
      consentVersion: STORY_RECORDING_CONSENT_VERSION,
      consentAt: new Date(),
      consentLocale, // ST3: language of the consent text shown
    };
    // A-S3-11: limit check and write under the gift lock (no 6th via a race).
    const row = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`story-video:${giftId}`}))::text`;
      if (
        !(await tx.storyGift.findFirst({
          where: { id: giftId, userId, status: { in: ['READY', 'APPROVED'] } },
          select: { id: true },
        }))
      )
        throw new NotFoundException('Готовая сказка не найдена');
      const active = await tx.storyVideoSegment.count({
        where: {
          giftId,
          source: 'recorded',
          status: 'READY',
          cacheKey: { not: cacheKey },
        },
      });
      if (active >= 5)
        throw new BadRequestException(
          'Не больше пяти записей на подарок: удалите прежнюю',
        );
      return tx.storyVideoSegment.upsert({
        where: { giftId_cacheKey: { giftId, cacheKey } },
        create: { giftId, cacheKey, ...data },
        update: data,
        select: { id: true, durationSeconds: true, createdAt: true },
      });
    });
    return {
      id: row.id,
      seconds: row.durationSeconds,
      sha256,
      createdAt: row.createdAt,
    };
  }
  /**
   * ST2-S-09 (variant a): deleting the adult's own recorded preamble withdraws
   * consent to it, so every render that used it loses its copy: the intro
   * audio, the finished video, its subtitles text and manifest. Under the gift
   * lock, like render create and the segment claims.
   *
   * ST2-S-10: the parent main narration (TTS of the gift text by the profile
   * voice, its own consent) is not part of the recording. The render becomes
   * FAILED (the slot renamed `:purged:`) and keeps `mainAudio` and
   * `parentNarrationKey`: priorNarration() reuses it for the next order for
   * free, exactly like a FAILED-before-submit render. Retention, voice
   * deletion and gift deletion still erase it as before.
   *
   * ST2-S-11: a render with this recording that is still running
   * (PREPARING/PENDING) or awaits the operator with an unconfirmed main
   * narration (UNKNOWN, main not saved) is not touched — 409 and nothing is
   * deleted, so a paid synthesis is never lost and its key never orphaned.
   */
  async deleteRecording(userId: string, giftId: string, recordingId: string) {
    await this.gift(userId, giftId);
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`story-video:${giftId}`}))::text`;
      const rec = await tx.storyVideoSegment.findFirst({
        where: { id: recordingId, giftId, source: 'recorded' },
        select: { cacheKey: true },
      });
      if (!rec) throw new NotFoundException('Запись не найдена');
      const renders = (
        await tx.storyVideoRender.findMany({
          where: { giftId, status: { not: 'DELETED' } },
          select: {
            id: true,
            status: true,
            configHash: true,
            segments: true,
            parentNarrationKey: true,
            mainDuration: true,
            approvedAt: true,
          },
        })
      ).filter((r) =>
        storyManifest(r.segments)?.segments.some(
          (s) => s.source === 'recorded' && s.cacheKey === rec.cacheKey,
        ),
      );
      if (renders.some((r) => ['PREPARING', 'PENDING'].includes(r.status)))
        throw new ConflictException({
          code: 'STORY_RECORDING_IN_USE',
          message:
            'Сборка с этой записью выполняется — дождитесь окончания и удалите запись снова',
        });
      if (
        renders.some(
          (r) =>
            r.status === 'UNKNOWN' &&
            !!r.parentNarrationKey &&
            r.mainDuration == null,
        )
      )
        throw new ConflictException({
          code: 'STORY_RECORDING_IN_USE',
          message:
            'Сборка с этой записью ждёт сверки оператора (основная речь не подтверждена) — удалите запись после её закрытия',
        });
      await tx.storyVideoSegment.updateMany({
        where: { id: recordingId, giftId, source: 'recorded' },
        data: {
          status: 'DELETED',
          audio: null,
          audioHash: null,
          durationSeconds: null,
        },
      });
      let rendersDeleted = 0;
      let segmentsErased = 0;
      let mainNarrationKeptCount = 0;
      for (const r of renders) {
        const m = storyManifest(r.segments)!;
        const wiped = await tx.storyVideoRender.updateMany({
          where: { id: r.id, status: r.status, configHash: r.configHash },
          data: {
            status: 'FAILED',
            configHash: `${r.configHash}:purged:${r.id}`,
            preambleAudio: null,
            preambleDuration: null,
            preambleText: '',
            video: null,
            videoHash: null,
            approvedAt: null,
            assetTokenHash: null,
            assetExpiresAt: null,
            qa: Prisma.DbNull,
            segments: Prisma.DbNull,
            error:
              r.mainDuration != null
                ? 'Запись вступления удалена владельцем: сборка недоступна. Основная речь сохранена и переиспользуется без новой оплаты.'
                : 'Запись вступления удалена владельцем: сборка недоступна.',
          },
        });
        if (!wiped.count) continue;
        rendersDeleted++;
        if (r.mainDuration != null) mainNarrationKeptCount++;
        // Their UNKNOWN synth segments (exact text of an unconfirmed attempt)
        // lose text/audio at once, like retention; the key stays blocked.
        const keys = [
          ...new Set(
            m.segments
              .filter((s) => s.source === 'synth')
              .map((s) => s.cacheKey),
          ),
        ];
        if (!keys.length) continue;
        const unknown = await tx.storyVideoSegment.findMany({
          where: {
            giftId,
            cacheKey: { in: keys },
            source: 'synth',
            status: 'UNKNOWN',
            text: { not: '' },
          },
          select: { id: true, cacheKey: true },
        });
        for (const seg of unknown) {
          const erased = await tx.storyVideoSegment.updateMany({
            where: { id: seg.id, status: 'UNKNOWN', cacheKey: seg.cacheKey },
            data: {
              audio: null,
              audioHash: null,
              durationSeconds: null,
              text: '',
            },
          });
          if (!erased.count) continue;
          segmentsErased++;
          await tx.storyOperatorAction.create({
            data: {
              actorKind: 'owner',
              targetType: 'segment',
              targetId: seg.id,
              action: 'owner.recording-delete',
              reason:
                'Владелец удалил запись вступления: сборка с ней удалена, текст её неподтверждённой озвучки стёрт; ключ остаётся заблокирован до решения оператора',
              previousState: {
                status: 'UNKNOWN',
                renderId: r.id,
                keyBlocked: true,
              },
              result: { textErased: true },
            },
          });
        }
      }
      // ST3-S-03/R-04: deleting the recording withdraws its consent — an
      // approved release with it leaves the public link at once.
      const linksWithdrawn = renders.some((r) => r.approvedAt)
        ? await withdrawStoryShares(tx, { id: giftId })
        : 0;
      return {
        deleted: true,
        rendersDeleted,
        segmentsErased,
        linksWithdrawn,
        mainNarrationKept: mainNarrationKeptCount > 0,
        mainNarrationKeptCount,
      };
    });
  }
  /** WebVTT from segment texts and the export layout (no paid STT). */
  async subtitles(userId: string, giftId: string, id: string) {
    const r = await this.own(userId, giftId, id);
    // ST2-S-12: only a finished render (like its video file); a FAILED one —
    // e.g. after its recording was deleted — never serves the story text.
    if (r.status !== 'READY')
      throw new NotFoundException(
        'Субтитры доступны только для готовой сборки',
      );
    const g = await this.gift(userId, giftId);
    const m = storyManifest(r.segments);
    if (m?.layout)
      return buildStoryVtt(
        m.layout.segments.map((l, i) => ({
          text: m.segments[i]?.text ?? '',
          start: l.start,
          end: l.end,
        })),
      );
    if (!m && r.preambleDuration && r.durationSeconds)
      return buildStoryVtt([
        { text: r.preambleText, start: 0, end: r.preambleDuration },
        { text: g.text, start: r.preambleDuration, end: r.durationSeconds },
      ]);
    throw new NotFoundException('Субтитры появятся после подготовки сборки');
  }
  async status(userId: string, giftId: string, id: string) {
    let r = await this.own(userId, giftId, id);
    if (
      r.qaStatus === 'RUNNING' &&
      Date.now() - r.updatedAt.getTime() > 10 * 60000
    )
      await this.prisma.storyVideoRender.updateMany({
        where: { id, qaStatus: 'RUNNING', updatedAt: r.updatedAt },
        data: { qaStatus: 'UNKNOWN' },
      });
    const job = await this.prisma.storyVideoRender.findUniqueOrThrow({
      where: { id },
      select: { jobId: true },
    });
    const recoverable = ['PREPARING', 'PENDING', 'UNKNOWN'];
    if (
      recoverable.includes(r.status) &&
      !job.jobId &&
      Date.now() - r.createdAt.getTime() > 30 * 60000
    ) {
      await this.prisma.storyVideoRender.updateMany({
        where: { id, status: { in: ['PREPARING', 'PENDING'] } },
        data: {
          status: 'UNKNOWN',
          // A-S3-9: the token hash stays as the input fingerprint (expired).
          assetExpiresAt: new Date(),
          error:
            'Нет сохранённого задания сборщика. Нужна сверка оператором; повторная оплата отключена.',
        },
      });
    } else if (recoverable.includes(r.status) && job.jobId) {
      try {
        const result = await this.ffmpeg.status(job.jobId, 20000);
        if (result.status === 'failed') {
          const failed = await this.prisma.storyVideoRender.updateMany({
            where: { id, status: { in: recoverable } },
            data: {
              status: 'FAILED',
              assetTokenHash: null,
              error: `Внешняя сборка завершилась ошибкой: ${(result.error || 'детали не получены').replace(/https?:\/\/[^\s"'<>]+/g, '[источник]').slice(0, 300)}`,
            },
          });
          if (failed.count) await this.refundRender(giftId, id);
        } else if (result.status === 'completed') {
          // Same validation as the operator binding of a confirmed job (WP1).
          const out = await downloadStoryVideo(
            result.outputs?.['story.mp4'],
            r.durationSeconds!,
          );
          await this.prisma.storyVideoRender.updateMany({
            where: {
              id,
              status: { in: recoverable },
              gift: { status: { in: ['READY', 'APPROVED'] } },
            },
            data: {
              status: 'READY',
              video: new Uint8Array(out.bytes),
              videoHash: out.videoHash,
              durationSeconds: out.durationSeconds,
              assetTokenHash: null,
              error: null,
            },
          });
          // ST3-S-14: the export is delivered — its credits are captured.
          await this.charges.captureQuietly({ key: storyVideoChargeKey(id) });
        } else if (Date.now() - r.createdAt.getTime() > 30 * 60000) {
          await this.prisma.storyVideoRender.updateMany({
            where: { id, status: { in: ['PREPARING', 'PENDING'] } },
            data: {
              status: 'UNKNOWN',
              assetTokenHash: null,
              error:
                'Задание ещё не завершено; продолжим опрос без новой сборки и оплаты.',
            },
          });
        }
      } catch (e) {
        if (e instanceof Error && e.message === 'Invalid container') {
          const rejected = await this.prisma.storyVideoRender.updateMany({
            where: { id, status: { in: recoverable } },
            data: {
              status: 'FAILED',
              assetTokenHash: null,
              // ST2-S-05: final — the same output is never downloaded again.
              error:
                e instanceof StoryVideoRejectedError && e.tooLarge
                  ? `Готовое видео больше ${STORY_MAX_VIDEO / 1048576} МиБ и не может быть принято; повторного скачивания не будет. Новую сборку можно запустить вручную.`
                  : 'Готовое видео не прошло проверку формата, размера или длительности.',
            },
          });
          if (rejected.count) await this.refundRender(giftId, id);
        }
        // Keep a durable job id for a later read-only reconciliation.
        if (Date.now() - r.createdAt.getTime() > 30 * 60000)
          await this.prisma.storyVideoRender.updateMany({
            where: { id, status: { in: ['PREPARING', 'PENDING'] } },
            data: {
              status: 'UNKNOWN',
              assetTokenHash: null,
              error:
                'Статус сборщика пока не подтверждён; сохранённое задание будет проверено снова без оплаты.',
            },
          });
      }
    }
    r = await this.own(userId, giftId, id);
    return r;
  }
  /** Read-only provider reconciliation: never synthesize, submit, run QA or publish. */
  async finalizePending() {
    const started = Date.now();
    const result = {
      scanned: 0,
      ready: 0,
      failed: 0,
      unknown: 0,
      blocked: 0,
      staleAudio: 0,
      staleQa: 0,
      /** ST3-S-02: steps UNKNOWN for 14 days — credits returned. */
      autoRefunded: 0,
      /** ST3-S-14: RESERVED charges of delivered steps captured. */
      captured: 0,
    };
    const stale = new Date(Date.now() - 10 * 60000);
    const rows = await this.prisma.storyVideoRender.findMany({
      where: {
        gift: { status: { in: ['READY', 'APPROVED'] } },
        OR: [
          {
            status: { in: ['PREPARING', 'PENDING', 'UNKNOWN'] },
            jobId: { not: null },
          },
          {
            status: 'PREPARING',
            createdAt: { lt: new Date(Date.now() - 30 * 60000) },
          },
          { qaStatus: 'RUNNING', updatedAt: { lt: stale } },
        ],
      },
      select: { id: true, giftId: true, gift: { select: { userId: true } } },
      orderBy: { updatedAt: 'asc' },
      take: 10,
    });
    for (const row of rows) {
      if (Date.now() - started > 90000) break;
      result.scanned++;
      try {
        const r = await this.status(row.gift.userId, row.giftId, row.id);
        if (r.status === 'READY') result.ready++;
        else if (r.status === 'FAILED') result.failed++;
        else if (r.status === 'UNKNOWN') result.unknown++;
        if (r.status !== 'UNKNOWN' && r.qaStatus === 'UNKNOWN')
          result.unknown++;
      } catch {
        result.blocked++;
      }
      // Rotate even blocked/network-failed rows so a revoked voice cannot starve others.
      await this.prisma.storyVideoRender.updateMany({
        where: { id: row.id, status: { not: 'DELETED' } },
        data: { updatedAt: new Date() },
      });
    }
    const synth = await this.prisma.storyGift.updateMany({
      where: { status: 'SYNTHESIZING', updatedAt: { lt: stale } },
      data: {
        status: 'UNKNOWN',
        error:
          'Ожидание синтеза истекло; нужна сверка оператором, повторная оплата отключена.',
      },
    });
    result.staleAudio = synth.count;
    const qa = await this.prisma.storyGift.updateMany({
      where: {
        status: { in: ['READY', 'APPROVED'] },
        audioQaStatus: 'RUNNING',
        updatedAt: { lt: stale },
      },
      data: { audioQaStatus: 'UNKNOWN' },
    });
    result.staleQa = qa.count;
    // A segment synthesis that never confirmed is as uncertain as a gift one.
    const segments = await this.prisma.storyVideoSegment.updateMany({
      where: { status: 'PENDING', updatedAt: { lt: stale } },
      data: { status: 'UNKNOWN' },
    });
    result.staleAudio += segments.count;
    // ST3-S-14: delivered steps' RESERVED → CAPTURED (sweep / data fix).
    result.captured = await this.charges.captureDelivered().catch(() => 0);
    // ST3-S-02 (правила 7.5): UNKNOWN 14 days without an operator — refund.
    result.autoRefunded = await this.charges.autoRefundStale().catch(() => 0);
    return result;
  }
  async file(
    userId: string,
    giftId: string,
    id: string,
    kind: 'video' | 'intro' | 'main',
  ) {
    const r = await this.own(userId, giftId, id);
    const data = await this.prisma.storyVideoRender.findUniqueOrThrow({
      where: { id },
      select: {
        video: true,
        preambleAudio: true,
        mainAudio: true,
        gift: { select: { audio: true } },
      },
    });
    const bytes =
      kind === 'video'
        ? data.video
        : kind === 'main'
          ? r.userVoiceId
            ? data.mainAudio
            : data.gift.audio
          : data.preambleAudio;
    if (!bytes || (kind === 'video' && r.status !== 'READY'))
      throw new NotFoundException('Файл ещё не готов');
    const introMime =
      storyManifest(r.segments)?.segments[0]?.mime ?? 'audio/mpeg';
    return {
      base64: Buffer.from(bytes).toString('base64'),
      mime:
        kind === 'video'
          ? 'video/mp4'
          : kind === 'intro'
            ? introMime
            : 'audio/mpeg',
    };
  }
  async quality(userId: string, giftId: string, id: string) {
    const r = await this.own(userId, giftId, id),
      g = await this.gift(userId, giftId);
    if (r.status !== 'READY')
      throw new ConflictException('Сначала дождитесь видео');
    if (r.qaStatus !== 'PENDING') return r;
    if (!this.stt.configured())
      throw new ServiceUnavailableException(
        'Проверка речи временно недоступна',
      );
    await this.plan.assertCanSpendUser(userId);
    const lock = await this.prisma.storyVideoRender.updateMany({
      where: { id, qaStatus: 'PENDING', status: 'READY' },
      data: { qaStatus: 'RUNNING' },
    });
    if (!lock.count) return this.own(userId, giftId, id);
    try {
      const row = await this.prisma.storyVideoRender.findUniqueOrThrow({
        where: { id },
        select: { video: true },
      });
      const result = await this.stt.transcribe({
        audio: Buffer.from(row.video!),
        mimeType: 'video/mp4',
        languageHints: [g.locale],
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
      // Same check for every segment layout: all spoken display texts in order.
      const manifest = storyManifest(r.segments);
      const score = storySpeechScore(
        manifest
          ? manifest.segments.map((s) => s.text).join('\n\n')
          : `${r.preambleText}\n\n${g.text}`,
        result.text,
      );
      await this.prisma.storyVideoRender.updateMany({
        where: { id, qaStatus: 'RUNNING', status: 'READY' },
        data: {
          qaStatus:
            score.wer <= 0.05 && result.language === g.locale ? 'PASS' : 'WARN',
          qa: {
            ...score,
            videoHash: r.videoHash,
            language: result.language ?? null,
            checkedAt: new Date().toISOString(),
          },
        },
      });
    } catch {
      await this.prisma.storyVideoRender.updateMany({
        where: { id, qaStatus: 'RUNNING' },
        data: { qaStatus: 'UNKNOWN' },
      });
    }
    return this.own(userId, giftId, id);
  }
  async approve(userId: string, giftId: string, id: string, videoHash: string) {
    await this.own(userId, giftId, id);
    const where = {
      id,
      giftId,
      status: 'READY',
      qaStatus: 'PASS',
      videoHash,
      gift: { userId, status: 'APPROVED' },
    };
    const r = await this.prisma.storyVideoRender.updateMany({
      where: { ...where, approvedAt: null },
      data: { approvedAt: new Date() },
    });
    // A delayed retry must not move an older release ahead of a newer one.
    // Still require the exact hash, READY/PASS and the approved parent gift.
    const alreadyApproved =
      !r.count &&
      (await this.prisma.storyVideoRender.findFirst({
        where: { ...where, approvedAt: { not: null } },
        select: { id: true },
      }));
    if (!r.count && !alreadyApproved)
      throw new ConflictException(
        'Нужны одобренная сказка и пройденная проверка видео',
      );
    return this.own(userId, giftId, id);
  }
  /** Temporary provider-only bearer assets: expire and disappear immediately after completion/deletion. */
  async input(token: string, part: string) {
    if (
      !/^[A-Za-z0-9_-]{43}$/.test(token) ||
      ![
        'base',
        'cover',
        'main',
        'intro',
        'note',
        'outro',
        'photo',
        'narrator',
      ].includes(part)
    )
      throw new NotFoundException();
    const r = await this.prisma.storyVideoRender.findFirst({
      where: {
        assetTokenHash: digest(token),
        assetExpiresAt: { gt: new Date() },
        status: { in: ['PREPARING', 'PENDING'] },
        gift: { status: { in: ['READY', 'APPROVED'] } },
      },
      include: { gift: true },
    });
    if (!r) throw new NotFoundException();
    await this.assertParentActive(r.gift.userId, r.userVoiceId, r.voiceId);
    if (part === 'main') {
      const audio = r.userVoiceId ? r.mainAudio : r.gift.audio;
      if (!audio || digest(audio) !== r.mainAudioHash)
        throw new NotFoundException();
      return { bytes: Buffer.from(audio), mime: 'audio/mpeg' };
    }
    const manifest = storyManifest(r.segments);
    if (part === 'intro') {
      const intro = manifest?.segments[0];
      if (
        !r.preambleAudio ||
        (intro && digest(r.preambleAudio) !== intro.audioHash)
      )
        throw new NotFoundException();
      return {
        bytes: Buffer.from(r.preambleAudio),
        mime: intro?.mime ?? 'audio/mpeg',
      };
    }
    if (part === 'note' || part === 'outro') {
      // Only this gift's cached segment, pinned by the manifest hash.
      const seg = manifest?.segments.find(
        (s) => s.kind === (part === 'note' ? 'gift_note' : 'outro'),
      );
      const row = seg?.audioHash
        ? await this.prisma.storyVideoSegment.findFirst({
            where: {
              giftId: r.giftId,
              cacheKey: seg.cacheKey,
              status: 'READY',
              audioHash: seg.audioHash,
            },
            select: { audio: true, mime: true },
          })
        : null;
      if (!row?.audio || digest(row.audio) !== seg!.audioHash)
        throw new NotFoundException();
      return { bytes: Buffer.from(row.audio), mime: row.mime };
    }
    if (part === 'narrator') {
      // Owner-scoped re-resolve: exactly the pinned image, consent still active.
      const pinned = manifest?.narrator;
      if (
        !pinned ||
        manifest.segments[0]?.visual !== 'narrator' ||
        pinned.manifestId !== r.narratorManifestId
      )
        throw new NotFoundException();
      let image: NarratorImage;
      try {
        image = await this.narratorImage(pinned.manifestId, r.gift.userId);
      } catch {
        throw new NotFoundException();
      }
      if (!sameNarrator(narratorSnapshot(image), pinned))
        throw new NotFoundException();
      return { bytes: Buffer.from(image.bytes), mime: image.mimeType };
    }
    if (part === 'photo') {
      const photo = manifest?.segments.some((s) => s.visual === 'photo')
        ? r.gift.giftPhoto
        : null;
      if (!photo) throw new NotFoundException();
      return { bytes: Buffer.from(photo), mime: 'image/png' };
    }
    const base = storyVideoBaseRevision(r.baseRevision);
    if (!base) throw new NotFoundException();
    const response = await fetchPubliclyRoutable(
      storyAssetUrl(part as 'base' | 'cover', base.revision),
      { signal: AbortSignal.timeout(20000) },
    );
    if (!response.ok) throw new NotFoundException();
    const bytes = await readBodyWithLimit(
      response,
      part === 'base' ? MAX_VIDEO : 1048576,
    );
    if (
      (part === 'base' && digest(bytes) !== r.baseHash) ||
      (part === 'cover' && digest(bytes) !== base.coverSha256)
    )
      throw new NotFoundException();
    return { bytes, mime: part === 'base' ? 'video/mp4' : 'image/png' };
  }
  /**
   * ST3: what a public link serves as video. 404 — a narrator consent was
   * revoked (the voice clone deleted, the narrator image consent withdrawn):
   * the release is off the link entirely, never swapped for Nova or an
   * audio-only page (ST3-S-03/S-07). `awaitingConsent` — the latest approved
   * release needs the narrator's consent and it covers another render
   * (ST3-S-04): the page shows no video until it is confirmed again.
   */
  async publicRelease(token: string, bytes = false) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new NotFoundException();
    const row = await this.prisma.storyVideoRender.findFirst({
      where: {
        approvedAt: { not: null },
        status: 'READY',
        // ST3: a public link lives 90 days, then 404.
        gift: {
          shareHash: digest(token),
          status: 'APPROVED',
          shareExpiresAt: { gt: new Date() },
        },
      },
      orderBy: { approvedAt: 'desc' },
      select: {
        id: true,
        durationSeconds: true,
        videoHash: true,
        voiceLabel: true,
        voiceId: true,
        userVoiceId: true,
        segments: true,
        gift: {
          select: { userId: true, narratorPublicConsentRenderId: true },
        },
        ...(bytes ? { video: true } : {}),
      },
    });
    if (!row) return { video: null, awaitingConsent: false };
    try {
      await this.assertParentActive(
        row.gift.userId,
        row.userVoiceId,
        row.voiceId,
      );
    } catch {
      throw new NotFoundException('Ссылка недоступна');
    }
    const narrator = storyManifest(row.segments)?.narrator;
    if (narrator?.manifestId) {
      const consent = await this.prisma.brandManifest.findFirst({
        where: {
          id: narrator.manifestId,
          userId: row.gift.userId,
          narratorImageConsentAt: { not: null },
          narratorImageConsentRevokedAt: null,
        },
        select: { id: true },
      });
      if (!consent) throw new NotFoundException('Ссылка недоступна');
      // ST3-S-15: a deleted variant is a withdrawn consent too.
      if (narrator.lookId) {
        const look = await this.prisma.storyNarratorLook.findFirst({
          where: {
            id: narrator.lookId,
            manifestId: narrator.manifestId,
            userId: row.gift.userId,
            deletedAt: null,
            status: { not: 'DELETED' },
          },
          select: { id: true },
        });
        if (!look) throw new NotFoundException('Ссылка недоступна');
      }
    }
    if (
      storyRenderNeedsPublicConsent(row) &&
      row.gift.narratorPublicConsentRenderId !== row.id
    )
      return { video: null, awaitingConsent: true };
    return { video: row, awaitingConsent: false };
  }
  async published(token: string, bytes = false) {
    const release = await this.publicRelease(token, bytes);
    if (!release.video)
      throw new NotFoundException('Видео по ссылке недоступно');
    return release.video;
  }
}
