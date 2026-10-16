import { StoryVideoService } from './story-video.service';
import { StoryReferencesService } from './story-references.service';
import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  NotFoundException,
  Headers,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Response } from 'express';
import {
  IsBoolean,
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
class StoryVideoDto {
  @IsOptional() @IsString() @MaxLength(100) narratorManifestId?: string;
  @IsOptional() @IsString() @MaxLength(80) voiceConsentVersion?: string;
  @IsOptional() @IsBoolean() voiceConsentAccepted?: boolean;
  @IsString() @MaxLength(180) preambleText!: string;
}
class StoryVideoApproveDto {
  @Matches(/^[a-f0-9]{64}$/) videoHash!: string;
  @Equals(true) reviewed!: boolean;
}
class StoryReferenceDto {
  @IsOptional() @IsBoolean() retry?: boolean;
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
    private readonly videos: StoryVideoService,
  ) {}
  @Get('references') referenceList(@Req() req: IdentifiedRequest) {
    return this.references.list(req.telegramUserId);
  }
  @Post('references/analyze') referenceAnalyze(
    @Req() req: IdentifiedRequest,
    @Body() dto: StoryReferenceDto,
  ) {
    return this.references.analyze(req.telegramUserId, dto.url, dto.retry);
  }
  @Get(':id/video') videoList(
    @Req() req: IdentifiedRequest,
    @Param('id') id: string,
  ) {
    return this.videos.list(req.telegramUserId, id);
  }
  @Post(':id/video') videoCreate(
    @Req() req: IdentifiedRequest,
    @Param('id') id: string,
    @Body() dto: StoryVideoDto,
  ) {
    return this.videos.create(req.telegramUserId, id, dto.preambleText, dto);
  }
  @Get(':id/video/:renderId') videoStatus(
    @Req() req: IdentifiedRequest,
    @Param('id') id: string,
    @Param('renderId') renderId: string,
  ) {
    return this.videos.status(req.telegramUserId, id, renderId);
  }
  @Get(':id/video/:renderId/file')
  @Header('Cache-Control', 'no-store')
  videoFile(
    @Req() req: IdentifiedRequest,
    @Param('id') id: string,
    @Param('renderId') renderId: string,
  ) {
    return this.videos.file(req.telegramUserId, id, renderId, 'video');
  }
  @Get(':id/video/:renderId/intro')
  @Header('Cache-Control', 'no-store')
  videoIntro(
    @Req() req: IdentifiedRequest,
    @Param('id') id: string,
    @Param('renderId') renderId: string,
  ) {
    return this.videos.file(req.telegramUserId, id, renderId, 'intro');
  }
  @Get(':id/video/:renderId/main')
  @Header('Cache-Control', 'no-store')
  videoMain(
    @Req() req: IdentifiedRequest,
    @Param('id') id: string,
    @Param('renderId') renderId: string,
  ) {
    return this.videos.file(req.telegramUserId, id, renderId, 'main');
  }
  @Post(':id/video/:renderId/quality') videoQuality(
    @Req() req: IdentifiedRequest,
    @Param('id') id: string,
    @Param('renderId') renderId: string,
  ) {
    return this.videos.quality(req.telegramUserId, id, renderId);
  }
  @Post(':id/video/:renderId/approve') videoApprove(
    @Req() req: IdentifiedRequest,
    @Param('id') id: string,
    @Param('renderId') renderId: string,
    @Body() dto: StoryVideoApproveDto,
  ) {
    return this.videos.approve(req.telegramUserId, id, renderId, dto.videoHash);
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
    private readonly videos: StoryVideoService,
  ) {}
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
    const publishedVideo = await this.videos.published(token).catch((e) => {
      if (e instanceof NotFoundException) return null;
      throw e;
    });
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
        `<!doctype html><html lang="${esc(gift.locale)}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow,noarchive"><title>Story‑Tales — сказка</title><style>body{margin:auto;max-width:760px;padding:24px;background:#102b35;color:#f6ebd7;font:18px/1.7 system-ui}svg{width:100%;height:auto}audio{width:100%}section{margin:36px 0}h1,h2{line-height:1.2}small{opacity:.8}</style><main><small>Story‑Tales · ${publishedVideo ? 'Видеоподарок' : 'Аудиоподарок'}</small><h1>${esc(gift.title)}</h1>${gift.occasion ? `<p>${esc(gift.occasion)}</p>` : ''}<p>${publishedVideo?.userVoiceId ? 'Синтетическая озвучка выбранным голосом рассказчика.' : 'Синтетическая озвучка Nova.'} Включает подготовленное взрослым обращение, если оно было добавлено.</p>${publishedVideo ? `<video controls playsinline preload="metadata" style="width:100%;border-radius:18px" src="./${token}/video"></video>${publishedVideo.userVoiceId ? '' : `<p><a style="color:inherit" href="./${token}/audio">Основная озвучка отдельно (MP3)</a></p>`}` : `<audio controls preload="none" src="./${token}/audio"></audio>`}${gift.giftNote && gift.giftNotePosition === 'beginning' ? `<p>${esc(gift.giftNote)}</p>` : ''}${chapters.map((c) => `<section>${storyIllustration(c.scene)}<h2>${esc(c.title)}</h2><p>${esc(c.text)}</p></section>`).join('')}${gift.giftNote && gift.giftNotePosition === 'end' ? `<p>${esc(gift.giftNote)}</p>` : ''}${gift.hasGiftPhoto ? `<section><h2>Подарок к сказке</h2><img style="max-width:100%;border-radius:16px" src="./${token}/photo" alt="Физический подарок, добавленный создателем" loading="lazy"></section>` : ''}<p>Спокойной ночи.</p><small>Сказка одобрена создателем. Доступна любому, у кого есть ссылка; поисковая индексация запрещена. Создатель может отозвать ссылку.</small></main></html>`,
      );
  }
  @Get(':token/video') async video(
    @Param('token') token: string,
    @Headers('range') range: string | undefined,
    @Res() res: Response,
  ) {
    this.headers(res);
    const row = await this.videos.published(token, true);
    const bytes = Buffer.from(row.video!);
    const part = audioRange(range, bytes.length);
    res.set({ 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes' });
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

@Controller('story-render-input')
export class StoryRenderInputController {
  constructor(private readonly videos: StoryVideoService) {}
  @Get(':token/:part') async input(
    @Param('token') token: string,
    @Param('part') part: string,
    @Res() res: Response,
  ) {
    res.set({
      'Cache-Control': 'private, no-store',
      'X-Robots-Tag': 'noindex, nofollow, noarchive',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    });
    const file = await this.videos.input(token, part);
    res.type(file.mime).send(file.bytes);
  }
}
