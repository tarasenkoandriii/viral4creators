import { BadRequestException, Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { SessionService, sessionData } from '../../common/session.service';
import { isOwnBlobUrl } from '../../common/blob-url';
import { readBodyWithLimit } from '../../common/external-url-guard';
import { HedraClientService } from '../actors/hedra-client.service';
import { BlobService } from '../storage/blob.service';
import { AiUsageService } from '../ai-usage/ai-usage.service';
import { FIXTURE_IDS } from '../tutorial-runner/fixture-seed';
import { greetingAvatarPerformancePrompt } from '../greeting-video/greeting-video.service';
import { mp3DurationSeconds } from '../../common/mp3-duration';
import { GreetingBriefSnapshot } from '../../common/types/greeting.types';
import { SceneAsset } from '../../common/types/reference.types';
import {
  GeneratedVideo,
  GenerationStatus,
} from '../../common/types/generation.types';

/** Operator-only, one paid comparison per immutable source video. Never calls TTS. */
@Injectable()
export class GreetingAvatarBenchmarkService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
    private readonly hedra: HedraClientService,
    private readonly blob: BlobService,
    private readonly usage: AiUsageService,
  ) {}

  async run(sourceId: unknown) {
    if (typeof sourceId !== 'string' || sourceId.startsWith('benchmark-kling-'))
      throw new BadRequestException('Выберите исходный готовый ролик фикстуры');
    const source = await this.prisma.session.findFirst({
      where: {
        id: sourceId,
        projectId: FIXTURE_IDS.greetingDoneProject,
        deletedAt: null,
      },
    });
    if (!source)
      throw new BadRequestException('Только тестовый проект поздравлений');
    const data = sessionData(source);
    const video = data.generatedVideo as GeneratedVideo | undefined;
    const brief = data.greetingBriefSnapshot as
      | GreetingBriefSnapshot
      | undefined;
    const portrait = (
      data.greetingReferenceImages as SceneAsset[] | undefined
    )?.[0]?.photoUrl;
    if (
      video?.status !== GenerationStatus.COMPLETE ||
      !video.speechBakedIn ||
      !brief ||
      !video.voiceoverUrl ||
      !isOwnBlobUrl(video.voiceoverUrl) ||
      !portrait ||
      !isOwnBlobUrl(portrait)
    )
      throw new BadRequestException(
        'Нужны готовый аватар, портрет и сохранённая озвучка',
      );
    const id =
      'benchmark-kling-' +
      createHash('sha256')
        .update(`${source.id}:${video.generatedVideoId}:pro`)
        .digest('hex')
        .slice(0, 32);
    const existing = await this.prisma.session.findUnique({ where: { id } });
    if (existing)
      return { sessionId: id, state: existing.status, reused: true };
    if ((await this.hedra.balanceUsd()) < 2)
      throw new BadRequestException(
        'Для сравнения нужен API-баланс не менее $2',
      );
    const copy = { ...data };
    delete copy.generatedVideo;
    delete copy.videoHistory;
    delete copy.workLocks;
    try {
      await this.prisma.session.create({
        data: {
          id,
          userId: source.userId,
          projectId: source.projectId,
          status: 'benchmark_submitting',
          data: JSON.parse(JSON.stringify(copy)),
          liveData: {},
        },
      });
    } catch (error) {
      if ((error as { code?: string }).code === 'P2002')
        return { sessionId: id, state: 'already_claimed', reused: true };
      throw error;
    }
    // Claim persists even if submit outcome is uncertain: never silently resubmit a paid job.
    try {
      const res = await fetch(video.voiceoverUrl, {
        redirect: 'error',
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) throw new Error('Audio download failed');
      const audio = await readBodyWithLimit(res, 5 * 1024 * 1024);
      const duration = mp3DurationSeconds(audio);
      if (!duration || duration > 12)
        throw new BadRequestException('Сравнение ограничено 12 секундами MP3');
      const voicePath = `sessions/${id}/benchmark-nova.mp3`;
      const { url } = await this.blob.uploadBuffer(
        voicePath,
        audio,
        'audio/mpeg',
      );
      const { jobId } = await this.hedra.submit({
        model: 'kling-ai-avatar-v2',
        quality: 'pro',
        prompt: greetingAvatarPerformancePrompt(brief),
        startImage: portrait,
        audioUrl: url,
        aspectRatio: '9:16',
        resolution: '720p',
      });
      const attempt = randomUUID();
      await this.sessions.updateSession(id, {
        generatedVideo: {
          generatedVideoId: attempt,
          pathname: `sessions/${id}/generated-${attempt}.mp4`,
          fileName: 'generated.mp4',
          mimeType: 'video/mp4',
          status: GenerationStatus.PROCESSING,
          provider: 'hedra',
          hedraModel: 'kling-ai-avatar-v2',
          hedraJobId: jobId,
          resolution: '720p',
          aspectRatio: '9:16',
          speechBakedIn: true,
          voiceStatus: 'synthesized',
          voiceoverUrl: url,
          voiceoverPathname: voicePath,
          voiceCharacters: video.voiceCharacters,
          initiatedAt: new Date(),
        },
      });
      await this.usage.record({
        operation: 'avatar-generation',
        model: 'kling-ai-avatar-v2',
        sessionId: id,
        calls: 1,
      });
      await this.prisma.session.update({
        where: { id },
        data: { status: 'generating' },
      });
      return {
        sessionId: id,
        state: 'processing',
        reused: false,
        audioSha256: createHash('sha256').update(audio).digest('hex'),
      };
    } catch (error) {
      await this.prisma.session.update({
        where: { id },
        data: { status: 'benchmark_failed' },
      });
      throw error;
    }
  }
}
