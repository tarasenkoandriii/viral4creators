import { Prisma } from '@prisma/client';
import { storyAudioReservation } from './story-budget';
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

const digest = (v: string | Uint8Array) =>
  createHash('sha256').update(v).digest('hex');
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
  async create(
    userId: string,
    catalogId: string,
    occasion?: string,
    giftNote?: string,
    giftNotePosition: 'beginning' | 'end' = 'end',
    budgetUsd = 1,
    countryCode = 'UA',
  ) {
    const story = STORY_CATALOG.find((s) => s.id === catalogId);
    if (!story) throw new BadRequestException('Редакция сказки недоступна');
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
      const note = giftNote?.trim() || null;
      const text = [
        giftNotePosition === 'beginning' ? note : null,
        storyText(story.id),
        giftNotePosition === 'end' ? note : null,
      ]
        .filter(Boolean)
        .join('\n\n');
      const reserve = storyAudioReservation(text);
      if (reserve > budgetUsd * 1e6)
        throw new BadRequestException(
          'Сократите текст: расчётный резерв превышает выбранный бюджет',
        );
      return tx.storyGift.create({
        data: {
          userId,
          catalogId,
          chapters: story.chapters.map((c) => ({ ...c })),
          locale: story.locale,
          countryCode,
          budgetCents: Math.round(budgetUsd * 100),
          reservedMicroUsd: reserve,
          occasion: occasion?.trim() || null,
          giftNote: note,
          giftNotePosition: note ? giftNotePosition : null,
          title: story.title,
          text,
          textHash: digest(text),
          voiceId: STORY_VOICE,
        },
        select: summary,
      });
    });
  }
  async photo(userId: string, id: string, base64: string) {
    await this.own(userId, id);
    const bytes = normalizeStoryPhoto(base64);
    const saved = await this.prisma.storyGift.updateMany({
      where: { id, userId, status: 'DRAFT' },
      data: { giftPhoto: new Uint8Array(bytes), hasGiftPhoto: true },
    });
    if (!saved.count)
      throw new ConflictException('Фото изменяется только до озвучки');
    return this.own(userId, id);
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
  async share(userId: string, id: string) {
    await this.own(userId, id);
    const token = randomBytes(32).toString('base64url');
    const done = await this.prisma.storyGift.updateMany({
      where: { id, userId, status: 'APPROVED', shareHash: null },
      data: { shareHash: digest(token) },
    });
    if (!done.count)
      throw new ConflictException(
        'Одобрите сказку; для новой ссылки сначала отзовите прежнюю',
      );
    return { token };
  }
  async withdraw(userId: string, id: string) {
    await this.own(userId, id);
    await this.prisma.storyGift.updateMany({
      where: { id, userId },
      data: { shareHash: null },
    });
    return { withdrawn: true };
  }
  async remove(userId: string, id: string) {
    await this.own(userId, id);
    await this.prisma.storyGift.updateMany({
      where: { id, userId },
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
        text: '',
        chapters: [],
      },
    });
    return { deleted: true };
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
