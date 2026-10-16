import { StoryReferencesService } from './story-references.service';
import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Headers,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Response } from 'express';
import {
  IsIn,
  IsNumber,
  Min,
  Max,
  IsOptional,
  IsString,
  MaxLength,
  Matches,
  Equals,
} from 'class-validator';
import {
  IdentifiedRequest,
  TelegramIdentityGuard,
} from '../telegram-auth/telegram-identity.guard';
import { escapeStoryHtml as esc, storyIllustration } from './story-catalog';
import { StoryGiftsService } from './story-gifts.service';
class StoryReferenceDto {
  @IsString() @MaxLength(500) url!: string;
}
export class CreateStoryDto {
  @IsString() @MaxLength(80) catalogId!: string;
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(1)
  @Max(1000)
  budgetUsd?: number;
  @IsOptional()
  @IsIn(['UA', 'GB', 'US', 'DE', 'ES', 'OTHER'])
  countryCode?: string;
  @IsOptional() @IsString() @MaxLength(80) occasion?: string;
  @IsOptional() @IsString() @MaxLength(180) giftNote?: string;
  @IsOptional() @IsIn(['beginning', 'end']) giftNotePosition?:
    | 'beginning'
    | 'end';
}
class StoryPhotoDto {
  @IsString() @MaxLength(1398104) base64!: string;
}
class ApproveStoryDto {
  @Matches(/^[a-f0-9]{64}$/) audioHash!: string;
  @Equals(true) reviewed!: boolean;
}
class ShareStoryDto {
  @Equals(true) publicLinkAccepted!: boolean;
}
@Controller('story-gifts')
@UseGuards(TelegramIdentityGuard)
export class StoryGiftsController {
  constructor(
    private readonly service: StoryGiftsService,
    private readonly references: StoryReferencesService,
  ) {}
  @Get('references') referenceList(@Req() req: IdentifiedRequest) {
    return this.references.list(req.telegramUserId);
  }
  @Post('references/analyze') referenceAnalyze(
    @Req() req: IdentifiedRequest,
    @Body() dto: StoryReferenceDto,
  ) {
    return this.references.analyze(req.telegramUserId, dto.url);
  }
  @Get('catalog') catalog() {
    return this.service.catalog();
  }
  @Get() list(@Req() req: IdentifiedRequest) {
    return this.service.list(req.telegramUserId);
  }
  @Post() create(@Req() req: IdentifiedRequest, @Body() dto: CreateStoryDto) {
    return this.service.create(
      req.telegramUserId,
      dto.catalogId,
      dto.occasion,
      dto.giftNote,
      dto.giftNotePosition,
      dto.budgetUsd,
      dto.countryCode,
    );
  }
  @Get(':id') get(@Req() req: IdentifiedRequest, @Param('id') id: string) {
    return this.service.own(req.telegramUserId, id);
  }
  @Post(':id/photo') photo(
    @Req() req: IdentifiedRequest,
    @Param('id') id: string,
    @Body() dto: StoryPhotoDto,
  ) {
    return this.service.photo(req.telegramUserId, id, dto.base64);
  }
  @Get(':id/photo') @Header('Cache-Control', 'no-store') photoGet(
    @Req() req: IdentifiedRequest,
    @Param('id') id: string,
  ) {
    return this.service.ownerPhoto(req.telegramUserId, id);
  }
  @Post(':id/render') render(
    @Req() req: IdentifiedRequest,
    @Param('id') id: string,
  ) {
    return this.service.render(req.telegramUserId, id);
  }
  @Post(':id/quality') quality(
    @Req() req: IdentifiedRequest,
    @Param('id') id: string,
  ) {
    return this.service.quality(req.telegramUserId, id);
  }
  @Get(':id/audio')
  @Header('Cache-Control', 'no-store')
  @Header('X-Robots-Tag', 'noindex, nofollow, noarchive')
  audio(@Req() req: IdentifiedRequest, @Param('id') id: string) {
    return this.service.audio(req.telegramUserId, id);
  }
  @Post(':id/approve') approve(
    @Req() req: IdentifiedRequest,
    @Param('id') id: string,
    @Body() dto: ApproveStoryDto,
  ) {
    return this.service.approve(req.telegramUserId, id, dto.audioHash);
  }
  @Post(':id/share') share(
    @Req() req: IdentifiedRequest,
    @Param('id') id: string,
    @Body() _dto: ShareStoryDto,
  ) {
    return this.service.share(req.telegramUserId, id);
  }
  @Delete(':id/share') withdraw(
    @Req() req: IdentifiedRequest,
    @Param('id') id: string,
  ) {
    return this.service.withdraw(req.telegramUserId, id);
  }
  @Delete(':id') remove(
    @Req() req: IdentifiedRequest,
    @Param('id') id: string,
  ) {
    return this.service.remove(req.telegramUserId, id);
  }
}
export function audioRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | null | false {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!m || (!m[1] && !m[2])) return false;
  const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
  const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  return Number.isSafeInteger(start) &&
    Number.isSafeInteger(end) &&
    start >= 0 &&
    start <= end &&
    start < size
    ? { start, end }
    : false;
}
@Controller('story-gift')
export class PublicStoryGiftController {
  constructor(
    private readonly service: StoryGiftsService,
    private readonly references: StoryReferencesService,
  ) {}
  @Get('references') referenceList(@Req() req: IdentifiedRequest) {
    return this.references.list(req.telegramUserId);
  }
  @Post('references/analyze') referenceAnalyze(
    @Req() req: IdentifiedRequest,
    @Body() dto: StoryReferenceDto,
  ) {
    return this.references.analyze(req.telegramUserId, dto.url);
  }
  private headers(res: Response) {
    res.set({
      'X-Robots-Tag': 'noindex, nofollow, noarchive',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    });
  }
  @Get(':token') async page(
    @Param('token') token: string,
    @Res() res: Response,
  ) {
    this.headers(res);
    const gift = await this.service.publicGift(token);
    const chapters = gift.chapters as unknown as Array<{
      title: string;
      text: string;
      scene: string;
    }>;
    res.set(
      'Content-Security-Policy',
      "default-src 'none'; style-src 'unsafe-inline'; media-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
    res
      .type('html')
      .send(
        `<!doctype html><html lang="${esc(gift.locale)}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow,noarchive"><title>Story‑Tales — сказка</title><style>body{margin:auto;max-width:760px;padding:24px;background:#102b35;color:#f6ebd7;font:18px/1.7 system-ui}svg{width:100%;height:auto}audio{width:100%}section{margin:36px 0}h1,h2{line-height:1.2}small{opacity:.8}</style><main><small>Story‑Tales · Аудиоподарок</small><h1>${esc(gift.title)}</h1>${gift.occasion ? `<p>${esc(gift.occasion)}</p>` : ''}<p>Синтетическая озвучка Nova. Включает подготовленное взрослым обращение, если оно было добавлено.</p><audio controls preload="none" src="./${token}/audio"></audio>${gift.giftNote && gift.giftNotePosition === 'beginning' ? `<p>${esc(gift.giftNote)}</p>` : ''}${chapters.map((c) => `<section>${storyIllustration(c.scene)}<h2>${esc(c.title)}</h2><p>${esc(c.text)}</p></section>`).join('')}${gift.giftNote && gift.giftNotePosition === 'end' ? `<p>${esc(gift.giftNote)}</p>` : ''}${gift.hasGiftPhoto ? `<section><h2>Подарок к сказке</h2><img style="max-width:100%;border-radius:16px" src="./${token}/photo" alt="Физический подарок, добавленный создателем" loading="lazy"></section>` : ''}<p>Спокойной ночи.</p><small>Сказка одобрена создателем. Доступна любому, у кого есть ссылка; поисковая индексация запрещена. Создатель может отозвать ссылку.</small></main></html>`,
      );
  }
  @Get(':token/photo') async photo(
    @Param('token') token: string,
    @Res() res: Response,
  ) {
    this.headers(res);
    const gift = await this.service.publicGift(token, false, true);
    if (!gift.giftPhoto) {
      res.status(404).end();
      return;
    }
    res.type('png').send(Buffer.from(gift.giftPhoto));
  }
  @Get(':token/audio') async audio(
    @Param('token') token: string,
    @Headers('range') range: string | undefined,
    @Res() res: Response,
  ) {
    this.headers(res);
    const gift = await this.service.publicGift(token, true);
    const bytes = gift.audio ? Buffer.from(gift.audio) : Buffer.alloc(0);
    const part = audioRange(range, bytes.length);
    res.set({ 'Content-Type': 'audio/mpeg', 'Accept-Ranges': 'bytes' });
    if (part === false) {
      res.status(416).set('Content-Range', `bytes */${bytes.length}`).end();
      return;
    }
    if (part) {
      res
        .status(206)
        .set({
          'Content-Range': `bytes ${part.start}-${part.end}/${bytes.length}`,
          'Content-Length': String(part.end - part.start + 1),
        })
        .send(bytes.subarray(part.start, part.end + 1));
      return;
    }
    res.set('Content-Length', String(bytes.length)).send(bytes);
  }
}
