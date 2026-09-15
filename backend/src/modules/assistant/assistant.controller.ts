/**
 * AssistantController — публичные маршруты ИИ-консультанта на лендинге
 * (ТЗ §4.3). Без cookie, без `SessionOwnerGuard` (параметр `sessionId` в
 * маршруте отсутствует — глобальный гвард молча пропускает, см. его
 * доккомментарий), без авторизации: консультант не знает, кто перед ним
 * (§8).
 *
 * `POST /assistant/chat` — единственный маршрут во всём бэкенде, который
 * пишет ответ САМ через `@Res()` без `passthrough`, а не возвращает
 * значение обработчика: и SSE (`text/event-stream`), и JSON-запасной
 * вариант (§4.3) оба обходят `ResponseInterceptor` — тот оборачивает
 * успешные ответы в `{success,data,meta}`, что для потока токенов
 * бессмысленно, а для JSON-запасного варианта сломало бы контракт
 * `{text,actions,usage}` из ТЗ.
 */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { RateLimit, RateLimitGuard, clientIp } from '../../common/rate-limit';
import { PublicOriginGuard } from '../../common/public-origin.guard';
import { SUPPORTED_LOCALES } from '../../common/locale';
import { AssistantSettingsService } from './assistant-settings.service';
import {
  AssistantService,
  AssistantStreamEvent,
  assistantErrorMessage,
} from './assistant.service';
import { AssistantChatRequestDto } from './dto/assistant-chat-request.dto';
import { AssistantEventBatchDto } from './dto/assistant-event.dto';
import { PrismaService } from '../../prisma/prisma.service';
import {
  ASSISTANT_KNOWLEDGE_BUILT_AT,
  ASSISTANT_KNOWLEDGE_COMMIT,
  ASSISTANT_PROACTIVE_TIPS,
  ASSISTANT_SUGGESTED_QUESTIONS,
} from './knowledge/generated';
import { AssistantAction, AssistantChatRequest } from './assistant.types';

/** ТЗ §4.3 — лимит символов у поля ввода посетителя (проверяется и DTO). */
export const ASSISTANT_MAX_MESSAGE_CHARS = 600;

@Controller('assistant')
export class AssistantController {
  constructor(
    private readonly assistant: AssistantService,
    private readonly settings: AssistantSettingsService,
    private readonly prisma: PrismaService,
  ) {}

  /** GET /assistant/config — публичный, кешируемый (§4.3). */
  @Get('config')
  async config(@Res({ passthrough: true }) res: Response) {
    res.setHeader('Cache-Control', 'public, max-age=300');
    const s = await this.settings.get();
    return {
      enabled: s.enabled,
      locales: SUPPORTED_LOCALES,
      maxMessageChars: ASSISTANT_MAX_MESSAGE_CHARS,
      suggestedQuestions: ASSISTANT_SUGGESTED_QUESTIONS,
      proactive: {
        enabled: s.enabled && s.proactiveEnabled,
        tips: ASSISTANT_PROACTIVE_TIPS,
      },
      knowledgeBuiltAt: ASSISTANT_KNOWLEDGE_BUILT_AT,
      knowledgeCommit: ASSISTANT_KNOWLEDGE_COMMIT,
    };
  }

  /** POST /assistant/chat — §4.3/§4.4/§7.1. */
  @Post('chat')
  @HttpCode(200)
  @UseGuards(PublicOriginGuard, RateLimitGuard)
  @RateLimit([
    { name: 'assistant-chat', limit: 10, windowSec: 60 },
    { name: 'assistant-chat-hour', limit: 60, windowSec: 3600 },
  ])
  async chat(
    @Body() dto: AssistantChatRequestDto,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const ip = clientIp(req);
    const accept = String(req.headers['accept'] ?? '');
    const wantsSse = accept.includes('text/event-stream');
    const request = dto as unknown as AssistantChatRequest;

    if (!wantsSse) {
      await this.chatJson(request, ip, res);
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    try {
      for await (const event of this.assistant.streamChat(request, ip)) {
        if (res.writableEnded) break; // посетитель уже закрыл вкладку
        writeSseEvent(res, event);
      }
    } catch (error) {
      // Сюда попадают только сбои самой записи в ответ (например,
      // разорванное соединение) — AssistantService.streamChat уже не
      // бросает исключений наружу (см. его доккомментарий).
      if (!res.writableEnded) {
        writeSseEvent(res, {
          type: 'error',
          code: 'upstream',
          message: assistantErrorMessage('upstream', request.locale),
        });
      }
    } finally {
      if (!res.writableEnded) res.end();
    }
  }

  /** Запасной вариант без SSE (§4.3) — собирает тот же поток в один JSON. */
  private async chatJson(
    request: AssistantChatRequest,
    ip: string,
    res: Response,
  ): Promise<void> {
    let text = '';
    let actions: AssistantAction[] = [];
    let usage = { in: 0, out: 0, cached: 0 };
    let error: { code: string; message: string } | null = null;

    for await (const event of this.assistant.streamChat(request, ip)) {
      switch (event.type) {
        case 'token':
          text += event.t;
          break;
        case 'actions':
          actions = event.items;
          break;
        case 'done':
          usage = event.usage;
          break;
        case 'error':
          error = { code: event.code, message: event.message };
          break;
      }
    }

    if (error) {
      const status =
        error.code === 'rate_limited'
          ? 429
          : error.code === 'disabled' || error.code === 'budget_exhausted'
            ? 503
            : 502;
      res.status(status).json({ error });
      return;
    }
    res.status(200).json({ text, actions, usage });
  }

  /** POST /assistant/event — §10, батч, без внешней аналитики. */
  @Post('event')
  @UseGuards(PublicOriginGuard, RateLimitGuard)
  @RateLimit({ name: 'assistant-event', limit: 30, windowSec: 60 })
  async event(
    @Body() dto: AssistantEventBatchDto,
  ): Promise<{ recorded: number }> {
    try {
      await this.prisma.assistantEvent.createMany({
        data: dto.events.map((e) => ({
          kind: e.kind,
          detail: e.detail ?? null,
        })),
      });
    } catch {
      // Событийная телеметрия — не повод отвечать ошибкой виджету.
      return { recorded: 0 };
    }
    return { recorded: dto.events.length };
  }
}

function writeSseEvent(res: Response, event: AssistantStreamEvent): void {
  switch (event.type) {
    case 'token':
      res.write(`event: token\ndata: ${JSON.stringify({ t: event.t })}\n\n`);
      break;
    case 'actions':
      res.write(
        `event: actions\ndata: ${JSON.stringify({ items: event.items })}\n\n`,
      );
      break;
    case 'done':
      res.write(
        `event: done\ndata: ${JSON.stringify({ usage: event.usage })}\n\n`,
      );
      break;
    case 'error':
      res.write(
        `event: error\ndata: ${JSON.stringify({ code: event.code, message: event.message })}\n\n`,
      );
      break;
  }
}
