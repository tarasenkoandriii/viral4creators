import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
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
import { probeMp4 } from '../tutorial-runner/mp4-probe';
import { storySpeechScore } from './story-audio-qa';
import { STORY_VOICE } from './story-catalog';
import { STORY_VIDEO_BASE as BASE } from './story-video-base';
import {
  planStoryVideo,
  storyDigest as digest,
  storyVideoConfigHash,
  storyVideoReserve,
  StoryVoiceChoice,
  STORY_PARENT_CONSENT_VERSION,
  STORY_PARENT_CONSENT_TEXT,
} from './story-video-plan';
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
  createdAt: true,
  updatedAt: true,
} as const;
const MAX_VIDEO = 3 * 1024 * 1024;
function publicApi() {
  const u = new URL(
    process.env.API_PUBLIC_URL ||
      'https://backend-iota-ruddy-57.vercel.app/api',
  );
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash)
    throw new ServiceUnavailableException('Публичный адрес сборки не настроен');
  u.pathname =
    u.pathname === '/' ? '/api/' : `${u.pathname.replace(/\/$/, '')}/`;
  return u.toString();
}
export function storyAssetUrl(part: 'base' | 'cover') {
  const u = new URL(process.env.TMA_PUBLIC_URL || 'https://viral4creators.app');
  if (u.protocol !== 'https:' || u.username || u.password)
    throw new ServiceUnavailableException('Адрес базового видео не настроен');
  return new URL(
    `/story-assets/turnip-v1/${part === 'base' ? 'base.mp4' : 'cover.png'}`,
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
  ) {}
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
  async list(userId: string, giftId: string) {
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
    return {
      supported: g.catalogId === BASE.catalogId && g.voiceId === STORY_VOICE,
      base: BASE,
      baseUrl: storyAssetUrl('base'),
      coverUrl: storyAssetUrl('cover'),
      budgetUsd: g.budgetCents / 100,
      reservedUsd:
        (g.reservedMicroUsd + (sum._sum.reservedMicroUsd ?? 0)) / 1e6,
      renders,
      narratorProfiles: await this.profiles(userId),
      voiceConsentVersion: STORY_PARENT_CONSENT_VERSION,
      voiceConsentText: STORY_PARENT_CONSENT_TEXT,
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
  async create(
    userId: string,
    giftId: string,
    preambleText: string,
    choice: StoryVoiceChoice = {},
  ) {
    const g = await this.gift(userId, giftId);
    const preamble = preambleText.trim();
    if (!preamble || preamble.length > 180)
      throw new BadRequestException('Преамбула: от 1 до 180 символов');
    if (
      g.catalogId !== BASE.catalogId ||
      g.voiceId !== STORY_VOICE ||
      !g.audioHash ||
      !g.durationSeconds ||
      g.giftNote ||
      g.audioQaStatus !== 'PASS'
    )
      throw new ConflictException(
        'Нужна проверенная точная «Репка» Nova без дополнительных реплик внутри основной дорожки',
      );
    const parent = await this.parent(userId, choice);
    const voiceId = parent?.voiceId ?? STORY_VOICE;
    const narrationKey = parent
      ? digest(
          JSON.stringify({
            giftId,
            text: g.text,
            userVoiceId: parent.userVoiceId,
            voiceId,
            consentAt: parent.cloneConsentAt.toISOString(),
          }),
        )
      : null;
    const configHash = parent
      ? storyVideoConfigHash(
          digest(
            `${narrationKey}:${parent.manifestId}:${STORY_PARENT_CONSENT_VERSION}`,
          ),
          preamble,
        )
      : storyVideoConfigHash(g.audioHash, preamble);
    const existing = await this.prisma.storyVideoRender.findUnique({
      where: { giftId_configHash: { giftId, configHash } },
      select,
    });
    if (existing) return existing;
    if (!this.ffmpeg.configured() || !this.tts.configured())
      throw new ServiceUnavailableException(
        'Сборка или озвучка временно недоступны',
      );
    const api = publicApi(); // Validate before spending.
    await this.plan.assertCanSpendUser(userId);

    const claim = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`story-video:${giftId}`}))::text`;
      const cached = await tx.storyVideoRender.findUnique({
        where: { giftId_configHash: { giftId, configHash } },
        select,
      });
      if (cached) return { fresh: false, row: cached };
      const current = await tx.storyGift.findFirst({
        where: {
          id: giftId,
          userId,
          status: { in: ['READY', 'APPROVED'] },
          audioHash: g.audioHash,
        },
      });
      if (!current) throw new ConflictException('Выпуск изменился');
      const prior = narrationKey
        ? await tx.storyVideoRender.findFirst({
            where: {
              giftId,
              parentNarrationKey: narrationKey,
              status: { not: 'DELETED' },
            },
            select: {
              mainAudio: true,
              mainAudioHash: true,
              mainDuration: true,
            },
          })
        : null;
      if (prior && !prior.mainAudio)
        throw new ConflictException(
          'Основная речь этого голоса уже готовится либо требует проверки; повторная оплата отключена',
        );
      const reserve = storyVideoReserve(
        preamble,
        parent && !prior ? g.text : '',
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
      const row = await tx.storyVideoRender.create({
        data: {
          giftId,
          configHash,
          preambleText: preamble,
          baseRevision: BASE.revision,
          baseHash: BASE.baseSha256,
          mainAudioHash: g.audioHash!,
          voiceId,
          voiceLabel: parent?.label ?? 'Nova',
          ...(parent
            ? {
                narratorManifestId: parent.manifestId,
                userVoiceId: parent.userVoiceId,
                voiceConsentAt: new Date(),
                voiceConsentVersion: STORY_PARENT_CONSENT_VERSION,
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
      return { fresh: true, row };
    });
    const id = claim.row.id;
    if (!claim.fresh) return claim.row;
    let stage: 'base' | 'main' | 'voice' | 'submit' = 'base';
    try {
      // Fail before synthesis if the published master does not match the approved version.
      const source = await fetchPubliclyRoutable(storyAssetUrl('base'), {
        signal: AbortSignal.timeout(20000),
      });
      if (
        !source.ok ||
        digest(await readBodyWithLimit(source, MAX_VIDEO)) !== BASE.baseSha256
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
          const main = await this.tts.synthesize({
            text: g.text,
            voiceId,
            language: g.locale,
          });
          if (!main.ok) throw new Error('Main synthesis unconfirmed');
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
            },
          });
          if (!saved.count) throw new Error('Render cancelled');
        }
      }
      stage = 'voice';
      await this.assertParentActive(userId, parent?.userVoiceId, voiceId);
      const audio = await this.tts.synthesize({
        text: preamble,
        voiceId,
        language: g.locale,
      });
      if (!audio.ok) throw new Error('Intro synthesis unconfirmed');
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
        audio.durationSeconds < 1 ||
        audio.durationSeconds > 20 ||
        audio.audio.length > 1048576
      )
        throw new Error('Invalid intro media');
      const token = randomBytes(32).toString('base64url');
      const total = mainSeconds + audio.durationSeconds;
      const stored = await this.prisma.storyVideoRender.updateMany({
        where: {
          id,
          status: 'PREPARING',
          gift: { status: { in: ['READY', 'APPROVED'] } },
        },
        data: {
          preambleAudio: new Uint8Array(audio.audio),
          preambleDuration: audio.durationSeconds,
          durationSeconds: total,
          assetTokenHash: digest(token),
          assetExpiresAt: new Date(Date.now() + 30 * 60000),
        },
      });
      if (!stored.count) throw new Error('Render cancelled');
      await this.plan.assertCanSpendUser(userId);
      const planned = planStoryVideo(mainSeconds, audio.durationSeconds);
      const input = (kind: string) =>
        `${api}story-render-input/${token}/${kind}`;
      stage = 'submit';
      await this.assertParentActive(userId, parent?.userVoiceId, voiceId);
      const job = await this.ffmpeg.submit({
        inputs: {
          base: input('base'),
          main: input('main'),
          cover: input('cover'),
          intro: input('intro'),
        },
        outputs: planned.outputs,
        commands: planned.commands,
        retrySubmit: false,
      });
      await this.usage.record({
        operation: 'story-video-assembly',
        model: 'ffmpeg-api',
        userId,
      });
      await this.prisma.storyVideoRender.updateMany({
        where: {
          id,
          status: 'PREPARING',
          gift: { status: { in: ['READY', 'APPROVED'] } },
        },
        data: { status: 'PENDING', jobId: job.jobId },
      });
    } catch {
      await this.prisma.storyVideoRender.updateMany({
        where: { id, status: 'PREPARING' },
        data: {
          status: 'UNKNOWN',
          assetTokenHash: null,
          error: `Сборка не подтверждена на этапе «${stage === 'base' ? 'проверка базового видео' : stage === 'main' ? 'озвучка основной сказки' : stage === 'voice' ? 'озвучка преамбулы' : 'отправка сборщику'}». Платный повтор отключён; нужна проверка оператором.`,
        },
      });
    }
    return this.own(userId, giftId, id);
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
    if (
      ['PREPARING', 'PENDING'].includes(r.status) &&
      Date.now() - r.createdAt.getTime() > 30 * 60000
    ) {
      await this.prisma.storyVideoRender.updateMany({
        where: { id, status: { in: ['PREPARING', 'PENDING'] } },
        data: {
          status: 'UNKNOWN',
          assetTokenHash: null,
          error: 'Сборка не завершилась в срок; автоматического повтора нет.',
        },
      });
    } else if (r.status === 'PENDING') {
      const job = await this.prisma.storyVideoRender.findUniqueOrThrow({
        where: { id },
        select: { jobId: true },
      });
      if (job.jobId)
        try {
          const result = await this.ffmpeg.status(job.jobId, 20000);
          if (result.status === 'failed')
            await this.prisma.storyVideoRender.updateMany({
              where: { id, status: 'PENDING' },
              data: {
                status: 'FAILED',
                assetTokenHash: null,
                error: `Внешняя сборка завершилась ошибкой: ${(result.error || 'детали не получены').replace(/https?:\/\/[^\s"'<>]+/g, '[источник]').slice(0, 300)}`,
              },
            });
          else if (result.status === 'completed') {
            const url = result.outputs?.['story.mp4'];
            if (!url) throw new Error('Invalid container');
            const res = await fetchPubliclyRoutable(url, {
              signal: AbortSignal.timeout(20000),
            });
            if (!res.ok) throw new Error('Download failed');
            const bytes = await readBodyWithLimit(res, MAX_VIDEO);
            const probe = probeMp4(bytes),
              video = probe?.tracks.find((t) => t.kind === 'video'),
              audio = probe?.tracks.find((t) => t.kind === 'audio');
            if (
              !probe ||
              bytes.length < 1024 ||
              !video ||
              !audio ||
              video.width !== 1280 ||
              video.height !== 720 ||
              Math.abs(probe.durationSeconds - r.durationSeconds!) > 0.15 ||
              audio.durationSeconds + 0.15 < r.durationSeconds!
            )
              throw new Error('Invalid container');
            await this.prisma.storyVideoRender.updateMany({
              where: {
                id,
                status: 'PENDING',
                gift: { status: { in: ['READY', 'APPROVED'] } },
              },
              data: {
                status: 'READY',
                video: new Uint8Array(bytes),
                videoHash: digest(bytes),
                durationSeconds: probe.durationSeconds,
                assetTokenHash: null,
                error: null,
              },
            });
          }
        } catch (e) {
          if (e instanceof Error && e.message === 'Invalid container')
            await this.prisma.storyVideoRender.updateMany({
              where: { id, status: 'PENDING' },
              data: {
                status: 'FAILED',
                assetTokenHash: null,
                error:
                  'Готовое видео не прошло проверку формата, размера или длительности.',
              },
            });
          // Network polling can retry; paid submit never does.
        }
    }
    r = await this.own(userId, giftId, id);
    return r;
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
    return {
      base64: Buffer.from(bytes).toString('base64'),
      mime: kind === 'video' ? 'video/mp4' : 'audio/mpeg',
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
      const score = storySpeechScore(
        `${r.preambleText}\n\n${g.text}`,
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
    const r = await this.prisma.storyVideoRender.updateMany({
      where: {
        id,
        giftId,
        status: 'READY',
        qaStatus: 'PASS',
        videoHash,
        gift: { userId, status: 'APPROVED' },
      },
      data: { approvedAt: new Date() },
    });
    if (!r.count)
      throw new ConflictException(
        'Нужны одобренная сказка и пройденная проверка видео',
      );
    return this.own(userId, giftId, id);
  }
  /** Temporary provider-only bearer assets: expire and disappear immediately after completion/deletion. */
  async input(token: string, part: string) {
    if (
      !/^[A-Za-z0-9_-]{43}$/.test(token) ||
      !['base', 'cover', 'main', 'intro'].includes(part)
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
    if (part === 'intro') {
      if (!r.preambleAudio) throw new NotFoundException();
      return { bytes: Buffer.from(r.preambleAudio), mime: 'audio/mpeg' };
    }
    const response = await fetchPubliclyRoutable(
      storyAssetUrl(part as 'base' | 'cover'),
      { signal: AbortSignal.timeout(20000) },
    );
    if (!response.ok) throw new NotFoundException();
    const bytes = await readBodyWithLimit(
      response,
      part === 'base' ? MAX_VIDEO : 1048576,
    );
    if (
      (part === 'base' && digest(bytes) !== r.baseHash) ||
      (part === 'cover' && digest(bytes) !== BASE.coverSha256)
    )
      throw new NotFoundException();
    return { bytes, mime: part === 'base' ? 'video/mp4' : 'image/png' };
  }
  async published(token: string, bytes = false) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new NotFoundException();
    const row = await this.prisma.storyVideoRender.findFirst({
      where: {
        approvedAt: { not: null },
        status: 'READY',
        gift: { shareHash: digest(token), status: 'APPROVED' },
      },
      orderBy: { approvedAt: 'desc' },
      select: {
        id: true,
        durationSeconds: true,
        videoHash: true,
        voiceLabel: true,
        voiceId: true,
        userVoiceId: true,
        gift: { select: { userId: true } },
        ...(bytes ? { video: true } : {}),
      },
    });
    if (!row) throw new NotFoundException('Видео по ссылке недоступно');
    await this.assertParentActive(
      row.gift.userId,
      row.userVoiceId,
      row.voiceId,
    );
    return row;
  }
}
