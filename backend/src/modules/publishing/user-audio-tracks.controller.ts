/**
 * Ролик на других языках — для владельца ролика (этап 148, TODO §III
 * п.12). Соседний `AdminAudioTracksController` делает то же для нашего
 * канала; здесь тот же механизм открыт пользователю, но с тремя
 * проверками, которых у оператора нет (владелец, тариф, потолок
 * расхода) — см. шапку сервиса.
 */

import { Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import {
  IdentifiedRequest,
  TelegramIdentityGuard,
} from '../telegram-auth/telegram-identity.guard';
import { RateLimit, RateLimitGuard } from '../../common/rate-limit';
import { UserAudioTracksService } from './user-audio-tracks.service';
import { AudioTrackView } from './admin-audio-tracks.service';

@Controller('sessions/:sessionId/audio-tracks')
@UseGuards(TelegramIdentityGuard)
export class UserAudioTracksController {
  constructor(private readonly service: UserAudioTracksService) {}

  @Get()
  list(
    @Req() req: IdentifiedRequest,
    @Param('sessionId') sessionId: string,
  ): Promise<{
    sourceLocale: string;
    toBuild: string[];
    tracks: AudioTrackView[];
  }> {
    return this.service.list(req.telegramUserId, sessionId);
  }

  /**
   * Собрать дорожку одного языка. Под ограничителем частоты: каждый
   * вызов — это перевод, синтез и задача ffmpeg, то есть деньги, и
   * защищаться одним суточным потолком значит позволить выбрать его за
   * минуту.
   *
   * Считается ПО ЧЕЛОВЕКУ, а не по адресу (аудит этапа 148). В
   * мини-аппе за одним адресом сидит сотовый оператор: экран собирает
   * до четырёх локалей подряд, и двое соседей по NAT выбрали бы чужое
   * окно, не сделав ничего дурного. А тому, от кого лимит защищает,
   * адрес сменить нечего стоит — деньги-то считаются по человеку.
   */
  @Post(':locale')
  @UseGuards(RateLimitGuard)
  @RateLimit({
    name: 'audio-track-build',
    limit: 10,
    windowSec: 600,
    by: 'user',
  })
  build(
    @Req() req: IdentifiedRequest,
    @Param('sessionId') sessionId: string,
    @Param('locale') locale: string,
  ): Promise<AudioTrackView> {
    return this.service.build(req.telegramUserId, sessionId, locale);
  }
}
