/**
 * Р-ST3-1/6/7: Story-Tales access for the TMA, pilot administration and the
 * public, cacheable capabilities summary for the landing.
 *
 *   GET    /story-gifts/access                         TelegramIdentityGuard only (no StoryAccessGuard)
 *   POST   /story-gifts/pilot/apply        {scenario?}  only in `pilot`, idempotent; 409 STORY_PILOT_FULL
 *   POST   /story-gifts/terms/accept       {termsVersion, adult: true}
 *   GET    /admin/story-tales/pilot                     AdminSessionGuard + operator
 *   POST   /admin/story-tales/pilot/applications/:id/approve|reject
 *   DELETE /admin/story-tales/pilot/members/:userId
 *   GET    /public/story-capabilities                   no auth; 404 in `owner`
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  Equals,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import {
  IdentifiedRequest,
  TelegramIdentityGuard,
} from '../telegram-auth/telegram-identity.guard';
import {
  AdminAuthenticatedRequest,
  AdminSessionGuard,
} from '../admin-auth/admin-session.guard';
import { AdminPanelService } from '../admin-panel/admin-panel.service';
import { StoryPilotService } from './story-pilot.service';
import { storyTalesMode } from './story-access';
import { STORY_CATALOG } from './story-catalog';
import { storyVideoBaseFor } from './story-video-base';
import { storyPriceFromUsd } from './story-pricing';

export class StoryPilotApplyDto {
  @IsOptional() @IsString() @MaxLength(500) scenario?: string;
}
export class StoryTermsAcceptDto {
  @IsString() @MaxLength(64) termsVersion!: string;
  @Equals(true) adult!: boolean;
}
export class StoryPilotActionDto {
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
  @IsOptional() @IsUUID() requestId?: string;
}

/** Registered BEFORE StoryGiftsController: `access` must not hit `GET :id`. */
@Controller('story-gifts')
@UseGuards(TelegramIdentityGuard)
export class StoryAccessController {
  constructor(private readonly pilot: StoryPilotService) {}
  @Header('Cache-Control', 'private, no-store')
  @Header('X-Robots-Tag', 'noindex, nofollow, noarchive')
  @Get('access')
  access(@Req() req: IdentifiedRequest) {
    return this.pilot.access(req.telegramUserId);
  }
  @Header('Cache-Control', 'private, no-store')
  @Post('pilot/apply')
  @HttpCode(200)
  apply(@Req() req: IdentifiedRequest, @Body() dto: StoryPilotApplyDto) {
    return this.pilot.apply(req.telegramUserId, dto.scenario);
  }
  @Header('Cache-Control', 'private, no-store')
  @Post('terms/accept')
  @HttpCode(200)
  acceptTerms(@Req() req: IdentifiedRequest, @Body() dto: StoryTermsAcceptDto) {
    return this.pilot.acceptTerms(
      req.telegramUserId,
      dto.termsVersion,
      dto.adult,
    );
  }
}

@Controller('admin/story-tales/pilot')
@UseGuards(AdminSessionGuard)
export class AdminStoryPilotController {
  constructor(
    private readonly pilot: StoryPilotService,
    private readonly admin: AdminPanelService,
  ) {}
  @Header('Cache-Control', 'no-store')
  @Get()
  async overview(@Req() req: AdminAuthenticatedRequest) {
    await this.admin.assertOperator(req.userId);
    return this.pilot.overview();
  }
  @Post('applications/:id/approve') @HttpCode(200) async approve(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: StoryPilotActionDto,
  ) {
    await this.admin.assertOperator(req.userId);
    return this.pilot.approve(req.userId, id, dto);
  }
  @Post('applications/:id/reject') @HttpCode(200) async reject(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: StoryPilotActionDto,
  ) {
    await this.admin.assertOperator(req.userId);
    return this.pilot.reject(req.userId, id, dto);
  }
  @Delete('members/:userId') async revoke(
    @Req() req: AdminAuthenticatedRequest,
    @Param('userId') userId: string,
    @Body() dto: StoryPilotActionDto,
  ) {
    await this.admin.assertOperator(req.userId);
    return this.pilot.revoke(req.userId, userId, dto ?? {});
  }
}

const CAPABILITY_LANGUAGES = ['ru', 'uk'] as const;
/** Tale slug of an edition id: `mitten-uk-short-v1` → `mitten`. */
export function storyTaleSlug(id: string, locale: string) {
  const at = id.indexOf(`-${locale}-`);
  return at > 0 ? id.slice(0, at) : id;
}

/** Public capabilities: no PII, no per-user data; the same for everyone. */
export function storyCapabilities() {
  const tales = new Map<
    string,
    {
      slug: string;
      title: string;
      titles: Record<string, string>;
      languages: string[];
      formats: string[];
    }
  >();
  for (const entry of STORY_CATALOG) {
    if (!(CAPABILITY_LANGUAGES as readonly string[]).includes(entry.locale))
      continue;
    const slug = storyTaleSlug(entry.id, entry.locale);
    const tale = tales.get(slug) ?? {
      slug,
      title: entry.title,
      titles: {},
      languages: [],
      formats: ['audio'],
    };
    if (!tale.languages.includes(entry.locale))
      tale.languages.push(entry.locale);
    tale.titles[entry.locale] ??= entry.title;
    if (storyVideoBaseFor(entry.id) && !tale.formats.includes('video'))
      tale.formats.push('video');
    tales.set(slug, tale);
  }
  const list = [...tales.values()];
  return {
    mode: storyTalesMode(),
    languages: [...CAPABILITY_LANGUAGES],
    tales: list,
    formats: [...new Set(list.flatMap((t) => t.formats))],
    priceFromUsd: storyPriceFromUsd(),
  };
}

@Controller('public/story-capabilities')
export class PublicStoryCapabilitiesController {
  @Header('Cache-Control', 'public, max-age=300')
  @Get()
  capabilities() {
    if (storyTalesMode() === 'owner') throw new NotFoundException();
    return storyCapabilities();
  }
}
