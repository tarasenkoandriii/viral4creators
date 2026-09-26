/**
 *   POST /api/me/test-tickets/upload-url   куда класть вложение
 *   POST /api/me/test-tickets              сама находка
 *
 * Своим файлом, а не рядом с окружением (аудит этапа 160): имя
 * `environment.controller.ts` перестало описывать содержимое в тот
 * момент, когда в него лёг контроллер находок, — а имя файла читают
 * чаще, чем его шапку.
 *
 * Ограничитель частоты здесь свой, отдельный от входа из бота
 * (`tester-ticket`): это два разных пути с разной ценой
 * злоупотребления — здесь выдаётся ещё и ссылка на запись в хранилище.
 */

import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { IsInt, IsOptional, IsString, MaxLength } from 'class-validator';
import {
  IdentifiedRequest,
  TelegramIdentityGuard,
} from '../telegram-auth/telegram-identity.guard';
import { RateLimit, RateLimitGuard } from '../../common/rate-limit';
import { TestTicketIntakeService } from './test-ticket-intake.service';

/** Ссылка на загрузку вложения (этап 160). */
export class TicketUploadUrlDto {
  @IsString()
  @MaxLength(120)
  mimeType!: string;

  @IsInt()
  sizeBytes!: number;
}

/**
 * Находка из мини-аппа.
 *
 * Тело без DTO у вложений и окружения — по той же причине, что у
 * `POST /me/environment`: их форма живёт в чистых функциях под тестом,
 * и второй её экземпляр в декораторах разошёлся бы с первым молча.
 * Здесь, в отличие от окружения, лишнее поле ОТВЕРГАЕТСЯ: форму шлёт
 * наш же экран, и незнакомое поле в ней — это рассогласование сборок,
 * о котором лучше узнать сразу.
 */
export class CreateTestTicketDto {
  @IsString()
  @MaxLength(4000)
  text!: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  sessionId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  stepId?: string;

  @IsOptional()
  environment?: unknown;

  @IsOptional()
  attachments?: Array<{
    pathname: string;
    mimeType?: string;
    fileName?: string;
  }>;
}

@Controller('me/test-tickets')
@UseGuards(TelegramIdentityGuard, RateLimitGuard)
export class TestTicketIntakeController {
  constructor(private readonly intake: TestTicketIntakeService) {}

  @Post('upload-url')
  @RateLimit({
    name: 'ticket-upload-url',
    limit: 30,
    windowSec: 3600,
    by: 'user',
  })
  async uploadUrl(
    @Req() req: IdentifiedRequest,
    @Body() dto: TicketUploadUrlDto,
  ): Promise<{ pathname: string; uploadUrl: string }> {
    return this.intake.uploadUrl(req.telegramUserId, dto);
  }

  @Post()
  @RateLimit({ name: 'ticket-create', limit: 30, windowSec: 3600, by: 'user' })
  async create(
    @Req() req: IdentifiedRequest,
    @Body() dto: CreateTestTicketDto,
  ): Promise<{ id: string; number: number }> {
    return this.intake.create(req.telegramUserId, dto);
  }
}
