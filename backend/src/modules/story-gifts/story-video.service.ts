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
    };
  }
  private async own(userId: string, giftId: string, id: string) {
    await this.gift(userId, giftId);
    const r = await this.prisma.storyVideoRender.findFirst({
      where: { id, giftId, status: { not: 'DELETED' } },
      select,
    });
    if (!r) throw new NotFoundException('Сборка сказки не найдена');
    return r;
  }
  async create(userId: string, giftId: string, preambleText: string) {
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
    const configHash = storyVideoConfigHash(g.audioHash, preamble);
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
    const reserve = storyVideoReserve(preamble);
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
          voiceId: STORY_VOICE,
          reservedMicroUsd: reserve,
        },
        select,
      });
      return { fresh: true, row };
    });
    const id = claim.row.id;
    if (!claim.fresh) return claim.row;
    let stage: 'base' | 'voice' | 'submit' = 'base';
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
      stage = 'voice';
      const audio = await this.tts.synthesize({
        text: preamble,
        voiceId: STORY_VOICE,
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
        audio.voiceId !== STORY_VOICE ||
        audio.mimeType !== 'audio/mpeg' ||
        !audio.durationSeconds ||
        audio.durationSeconds < 1 ||
        audio.durationSeconds > 20 ||
        audio.audio.length > 1048576
      )
        throw new Error('Invalid intro media');
      const token = randomBytes(32).toString('base64url');
      const total = g.durationSeconds! + audio.durationSeconds;
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
      const planned = planStoryVideo(g.durationSeconds!, audio.durationSeconds);
      const input = (kind: string) =>
        `${api}story-render-input/${token}/${kind}`;
      stage = 'submit';
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
          error: `Сборка не подтверждена на этапе «${stage === 'base' ? 'проверка базового видео' : stage === 'voice' ? 'озвучка преамбулы' : 'отправка сборщику'}». Платный повтор отключён; нужна проверка оператором.`,
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
    kind: 'video' | 'intro',
  ) {
    const r = await this.own(userId, giftId, id);
    const data = await this.prisma.storyVideoRender.findUniqueOrThrow({
      where: { id },
      select: { video: true, preambleAudio: true },
    });
    const bytes = kind === 'video' ? data.video : data.preambleAudio;
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
    if (part === 'main') {
      if (!r.gift.audio || r.gift.audioHash !== r.mainAudioHash)
        throw new NotFoundException();
      return { bytes: Buffer.from(r.gift.audio), mime: 'audio/mpeg' };
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
        ...(bytes ? { video: true } : {}),
      },
    });
    if (!row) throw new NotFoundException('Видео по ссылке недоступно');
    return row;
  }
}
