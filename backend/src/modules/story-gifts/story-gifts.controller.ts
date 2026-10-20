import {
  StoryAccessGuard,
  StoryOwnerOnlyGuard,
  StoryPublicAccessGuard,
  STORY_PUBLIC_HEADERS,
} from './story-access.guard';
import { storyTalesMode } from './story-access';
import { StoryVideoService } from './story-video.service';
import { StoryReferencesService } from './story-references.service';
import { StoryReferenceListQuery } from './story-reference.dto';
import { storyEditionsList } from './story-editions';
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
  Query,
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
import { storyPublicPageHtml } from './story-public-page';
import { storyTextLocaleOf } from './story-i18n';
import { StoryGiftsService } from './story-gifts.service';
import {
  STORY_OCCASION_KINDS,
  STORY_THEMES,
  type StoryOccasionKind,
  type StoryTheme,
} from './story-occasion'; // WP3
import {
  StoryRecordingDto,
  StoryRenderDto,
  StoryVideoDto,
} from './story-video.dto'; // WP4
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
  /** WP3: пресет повода; пропуск допустим. */
  @IsOptional()
  @IsIn([...STORY_OCCASION_KINDS])
  occasionKind?: StoryOccasionKind;
  /** Свободная подпись для `other` (у старых клиентов — единственное поле повода). */
  @IsOptional() @IsString() @MaxLength(80) occasion?: string;
  /** WP3: тема обложки; по умолчанию — по поводу. */
  @IsOptional() @IsIn([...STORY_THEMES]) theme?: StoryTheme;
  /** WP3: явное включение реплики — обязательно, если giftNote задан. */
  @IsOptional() @IsBoolean() giftNoteEnabled?: boolean;
  @IsOptional() @IsString() @MaxLength(180) giftNote?: string;
  @IsOptional() @IsIn(['beginning', 'end']) giftNotePosition?:
    | 'beginning'
    | 'end';
  /** WP3: описание фото физического подарка (как описание товара). */
  @IsOptional() @IsString() @MaxLength(200) giftPhotoDescription?: string;
}
/** WP3: тот же ввод + параметры сметы будущего видео; без побочных эффектов. */
export class PreviewStoryDto extends CreateStoryDto {
  @IsOptional() @IsBoolean() includeVideo?: boolean;
  @IsOptional() @IsString() @MaxLength(180) preambleText?: string;
  @IsOptional() @IsIn(['nova', 'parent']) videoVoice?: 'nova' | 'parent';
  /** B-S3-4: завершение видео — отдельный сегмент в смете. */
  @IsOptional() @IsString() @MaxLength(180) outroText?: string;
}
export class StoryPhotoDto {
  @IsOptional() @IsString() @MaxLength(1398104) base64?: string;
  /** WP3: '' очищает описание; отсутствие поля — не менять. */
  @IsOptional() @IsString() @MaxLength(200) description?: string;
}
class ApproveStoryDto {
  @Matches(/^[a-f0-9]{64}$/) audioHash!: string;
  @Equals(true) reviewed!: boolean;
}
/**
 * Р-ST3-3 (ТЗ §11.3): explicit acknowledgement of the shown text «Этот
 * подарок будет доступен любому, у кого есть ссылка. Поисковым системам
 * запрещается индексирование. Ссылку можно переслать». Without it — 400.
 */
export class ShareStoryDto {
  @Equals(true) acknowledgePublic!: boolean;
  /** ТЗ §11.1: required when the release has a non-Nova narrator. */
  @IsOptional() @IsBoolean() narratorPublicConsent?: boolean;
}
@Controller('story-gifts')
@UseGuards(TelegramIdentityGuard, StoryAccessGuard)
export class StoryGiftsController {
  constructor(
    private readonly service: StoryGiftsService,
    private readonly references: StoryReferencesService,
    private readonly videos: StoryVideoService,
  ) {}
  @Header('Cache-Control', 'private, no-store')
  @Header('X-Robots-Tag', 'noindex, nofollow, noarchive')
  @Get('references')
  @UseGuards(StoryOwnerOnlyGuard) // Р-ST3-BE-18: Gemini, not priced yet
  referenceList(
    @Req() req: IdentifiedRequest,
    @Query() q: StoryReferenceListQuery,
  ) {
    return this.references.list(req.telegramUserId, q);
  }
  @Post('references/analyze')
  @UseGuards(StoryOwnerOnlyGuard)
  referenceAnalyze(
    @Req() req: IdentifiedRequest,
    @Body() dto: StoryReferenceDto,
  ) {
    return this.references.analyze(req.telegramUserId, dto.url, dto.retry);
  }
  @Header('Cache-Control', 'private, no-store')
  @Header('X-Robots-Tag', 'noindex, nofollow, noarchive')
  @Get(':id/video')
  videoList(@Req() req: IdentifiedRequest, @Param('id') id: string) {
    return this.videos.list(req.telegramUserId, id, storyTextLocaleOf(req));
  }
  @Post(':id/video') videoCreate(
    @Req() req: IdentifiedRequest,
    @Param('id') id: string,
    @Body() dto: StoryVideoDto,
  ) {
    return this.videos.create(
      req.telegramUserId,
      id,
      dto.preambleText,
      dto,
      storyTextLocaleOf(req),
    );
  }
  // WP4: repeat-order estimate and segment preview, no side effects.
  @Header('Cache-Control', 'private, no-store')
  @Post(':id/video/quote')
  videoQuote(
    @Req() req: IdentifiedRequest,
    @Param('id') id: string,
    @Body() dto: StoryVideoDto,
  ) {
    return this.videos.quote(req.telegramUserId, id, dto.preambleText, dto);
  }
  // WP4 ST-P1: the adult's own recorded preamble (private, per gift).
  @Header('Cache-Control', 'private, no-store')
  @Post(':id/video/recording')
  videoRecording(
    @Req() req: IdentifiedRequest,
    @Param('id') id: string,
    @Body() dto: StoryRecordingDto,
  ) {
    return this.videos.uploadRecording(
      req.telegramUserId,
      id,
      dto,
      storyTextLocaleOf(req),
    );
  }
  @Delete(':id/video/recording/:recordingId') videoRecordingDelete(
    @Req() req: IdentifiedRequest,
    @Param('id') id: string,
    @Param('recordingId') recordingId: string,
  ) {
    return this.videos.deleteRecording(req.telegramUserId, id, recordingId);
  }
  @Header('Cache-Control', 'private, no-store')
  @Header('X-Robots-Tag', 'noindex, nofollow, noarchive')
  @Get(':id/video/:renderId')
  videoStatus(
    @Req() req: IdentifiedRequest,
    @Param('id') id: string,
    @Param('renderId') renderId: string,
  ) {
    return this.videos.status(req.telegramUserId, id, renderId);
  }
  @Header('Cache-Control', 'private, no-store')
  @Header('X-Robots-Tag', 'noindex, nofollow, noarchive')
  @Get(':id/video/:renderId/file')
  videoFile(
    @Req() req: IdentifiedRequest,
    @Param('id') id: string,
    @Param('renderId') renderId: string,
  ) {
    return this.videos.file(req.telegramUserId, id, renderId, 'video');
  }
  @Header('Cache-Control', 'private, no-store')
  @Header('X-Robots-Tag', 'noindex, nofollow, noarchive')
  @Get(':id/video/:renderId/intro')
  videoIntro(
    @Req() req: IdentifiedRequest,
    @Param('id') id: string,
    @Param('renderId') renderId: string,
  ) {
    return this.videos.file(req.telegramUserId, id, renderId, 'intro');
  }
  @Header('Cache-Control', 'private, no-store')
  @Header('X-Robots-Tag', 'noindex, nofollow, noarchive')
  @Get(':id/video/:renderId/main')
  videoMain(
    @Req() req: IdentifiedRequest,
    @Param('id') id: string,
    @Param('renderId') renderId: string,
  ) {
    return this.videos.file(req.telegramUserId, id, renderId, 'main');
  }
  // WP4: raw WebVTT (no JSON envelope) built from segment texts and layout.
  @Get(':id/video/:renderId/subtitles.vtt')
  async videoSubtitles(
    @Req() req: IdentifiedRequest,
    @Param('id') id: string,
    @Param('renderId') renderId: string,
    @Res() res: Response,
  ) {
    const vtt = await this.videos.subtitles(req.telegramUserId, id, renderId);
    res
      .set({
        'Cache-Control': 'private, no-store',
        'X-Robots-Tag': 'noindex, nofollow, noarchive',
        'X-Content-Type-Options': 'nosniff',
        'Content-Type': 'text/vtt; charset=utf-8',
      })
      .send(vtt);
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
  @Header('Cache-Control', 'private, no-store')
  @Header('X-Robots-Tag', 'noindex, nofollow, noarchive')
  @Get('catalog')
  catalog(@Req() req: IdentifiedRequest) {
    return this.service.catalog(storyTextLocaleOf(req));
  }
  /** Editorial registry (WP2): rights, sources, adaptation differences. Before `:id`. */
  @Header('Cache-Control', 'private, no-store')
  @Header('X-Robots-Tag', 'noindex, nofollow, noarchive')
  @Get('editions')
  editions() {
    return storyEditionsList();
  }
  @Header('Cache-Control', 'private, no-store')
  @Header('X-Robots-Tag', 'noindex, nofollow, noarchive')
  @Get()
  list(@Req() req: IdentifiedRequest) {
    return this.service.list(req.telegramUserId);
  }
  @Post() create(@Req() req: IdentifiedRequest, @Body() dto: CreateStoryDto) {
    return this.service.create(req.telegramUserId, dto);
  }
  /** WP3: точная реплика, длительность и смета до создания; без записей и платных вызовов. */
  @Header('Cache-Control', 'private, no-store')
  @Header('X-Robots-Tag', 'noindex, nofollow, noarchive')
  @Post('preview')
  preview(@Req() req: IdentifiedRequest, @Body() dto: PreviewStoryDto) {
    const { includeVideo, preambleText, videoVoice, outroText, ...input } = dto;
    return this.service.previewFor(req.telegramUserId, input, {
      includeVideo,
      preambleText,
      videoVoice,
      outroText,
    });
  }
  @Header('Cache-Control', 'private, no-store')
  @Header('X-Robots-Tag', 'noindex, nofollow, noarchive')
  @Get(':id')
  get(@Req() req: IdentifiedRequest, @Param('id') id: string) {
    return this.service.view(req.telegramUserId, id);
  }
  @Post(':id/photo') photo(
    @Req() req: IdentifiedRequest,
    @Param('id') id: string,
    @Body() dto: StoryPhotoDto,
  ) {
    return this.service.photo(
      req.telegramUserId,
      id,
      dto.base64,
      dto.description,
    );
  }
  @Delete(':id/photo') photoRemove(
    @Req() req: IdentifiedRequest,
    @Param('id') id: string,
  ) {
    return this.service.removePhoto(req.telegramUserId, id);
  }
  @Header('Cache-Control', 'private, no-store')
  @Header('X-Robots-Tag', 'noindex, nofollow, noarchive')
  @Get(':id/photo')
  photoGet(@Req() req: IdentifiedRequest, @Param('id') id: string) {
    return this.service.ownerPhoto(req.telegramUserId, id);
  }
  @Post(':id/render') render(
    @Req() req: IdentifiedRequest,
    @Param('id') id: string,
    @Body() dto: StoryRenderDto,
  ) {
    return this.service.render(req.telegramUserId, id, {
      expectedCredits: dto?.expectedCredits,
    });
  }
  @Post(':id/quality') quality(
    @Req() req: IdentifiedRequest,
    @Param('id') id: string,
  ) {
    return this.service.quality(req.telegramUserId, id);
  }
  @Header('Cache-Control', 'private, no-store')
  @Header('X-Robots-Tag', 'noindex, nofollow, noarchive')
  @Get(':id/audio')
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
  /** Р-ST3-3: only in `pilot`/`public`; `owner` mode keeps the 404. */
  @Header('Cache-Control', 'private, no-store')
  @Post(':id/share')
  async share(
    @Req() req: IdentifiedRequest,
    @Param('id') id: string,
    @Body() dto: ShareStoryDto,
    @Res({ passthrough: true }) res?: Response,
  ) {
    if (storyTalesMode() === 'owner') throw new NotFoundException();
    const out = await this.service.share(req.telegramUserId, id, {
      narratorPublicConsent: dto.narratorPublicConsent,
    });
    // A consent moved to a new release of a live link: 200, not 201.
    if (out.narratorConsentUpdated) res?.status(200);
    return out;
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
/**
 * Р-ST3-3: «Публично по ссылке, без индексации» (ТЗ §11) — in `pilot` and
 * `public` only (`StoryPublicAccessGuard`, 404 in `owner`). Every answer,
 * including 404, carries noindex + Referrer-Policy no-referrer; media honour
 * Range. A link lives 90 days, then 404; withdrawal — 404 at once.
 */
@Controller('story-gift')
@UseGuards(StoryPublicAccessGuard)
export class PublicStoryGiftController {
  constructor(
    private readonly service: StoryGiftsService,
    private readonly videos: StoryVideoService,
  ) {}
  private headers(res: Response) {
    res.set(STORY_PUBLIC_HEADERS);
  }
  @Get(':token') async page(
    @Param('token') token: string,
    @Res() res: Response,
  ) {
    this.headers(res);
    const gift = await this.service.publicGift(token);
    // ST3-S-03/S-07: a revoked voice/image takes the whole page off (404);
    // a release waiting for the narrator's consent — page without video.
    const release = await this.videos.publicRelease(token);
    res.set(
      'Content-Security-Policy',
      "default-src 'none'; style-src 'unsafe-inline'; media-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
    res.type('html').send(
      storyPublicPageHtml({
        token,
        gift,
        video: release.video,
        awaitingConsent: release.awaitingConsent,
      }),
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
    await this.videos.publicRelease(token); // revoked narrator → 404
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
    await this.videos.publicRelease(token); // revoked narrator → 404
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
