/**
 * Опубликованные страницы автора с роликами «Я в кадре» — для кнопки
 * «снять» после `DELETE /personas/me` (ТЗ Greeting 2.0 §4.9: готовые
 * ролики остаются у автора, страницы экран предлагает снять одним
 * нажатием).
 *
 * Признак ролика с персоной — `usesPersona` в снимке брифа сессии
 * (`sessionDataUsesPersona`, общий помощник G): тот же, по которому
 * аукцион и витрина отказывают. Страница без живой строки сессии
 * (уборка по сроку) проверке не поддаётся и в список не попадает —
 * сама страница при этом остаётся в разделе публикаций автора.
 *
 * В список идут и `PENDING`, не только `PUBLISHED`: страница на
 * модерации станет публичной, как только оператор её одобрит, а
 * отозвать её можно в любом статусе (`DELETE
 * /sessions/:sessionId/shared-video/:pageId`). `REJECTED` не видна никому.
 */

import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { loadConfiguration } from '../../config/configuration';
import { sessionDataUsesPersona } from '../../common/greeting-persona';
import type {
  PersonaShare,
  PersonaSharesLookup,
} from './persona-look-generator';

/** Страниц одного автора за вызов — потолок от необычно большого аккаунта. */
export const PERSONA_SHARES_SCAN_LIMIT = 500;

/** Публичный адрес страницы — как у клиента и рассылки: `<лендинг>/video/<id>`. */
export function sharePageUrl(landingUrl: string, id: string): string {
  return `${landingUrl.replace(/\/+$/, '')}/video/${id}`;
}

@Injectable()
export class PersonaSharesService implements PersonaSharesLookup {
  constructor(private readonly prisma: PrismaService) {}

  async publishedSharesWithPersona(userId: string): Promise<PersonaShare[]> {
    const pages = await this.prisma.sharedVideoPage.findMany({
      where: { userId, status: { in: ['PENDING', 'PUBLISHED'] } },
      select: { id: true, sessionId: true },
      orderBy: { createdAt: 'desc' },
      take: PERSONA_SHARES_SCAN_LIMIT,
    });
    if (pages.length === 0) return [];
    const sessionIds = [...new Set(pages.map((p) => p.sessionId))];
    const sessions = await this.prisma.session.findMany({
      where: { id: { in: sessionIds } },
      select: { id: true, data: true },
    });
    const withPersona = new Set(
      sessions.filter((s) => sessionDataUsesPersona(s.data)).map((s) => s.id),
    );
    // `LANDING_PUBLIC_URL` — тот же источник, что у рассылки подборки;
    // не задан — адрес относительный, клиент дополнит своим лендингом.
    const landing = loadConfiguration().marketing.landingUrl;
    return pages
      .filter((p) => withPersona.has(p.sessionId))
      .map((p) => ({
        id: p.id,
        sessionId: p.sessionId,
        url: sharePageUrl(landing, p.id),
      }));
  }
}
