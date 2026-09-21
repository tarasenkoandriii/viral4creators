import type { MetadataRoute } from 'next';
import { locales } from '../lib/i18n';
import { getAuctionListings, PROFILE_REVALIDATE_SECONDS } from '../lib/api';

/**
 * `sitemap.xml` (ТЗ на маркетплейс §22, «Публичные страницы и sitemap»)
 * — конвенция Next App Router: файл `sitemap.ts` в `app/` автоматически
 * отдаётся на `/sitemap.xml`, тот же приём, что уже есть в `landing/`.
 *
 * Честная оговорка по объёму: сюда попадают только лоты аукциона — это
 * ПЕРВЫЙ sitemap у маркетплейса вообще, каталог исполнителей, профили,
 * карточки работ и подборки в него пока не включены (отдельная, более
 * широкая задача, не часть этого прохода).
 *
 * Короткое окно ревалидации (как договаривались для этого раздела) —
 * PROFILE_REVALIDATE_SECONDS, не более долгий CATALOG_REVALIDATE_SECONDS:
 * список действующих лотов должен обновляться в sitemap в течение
 * примерно минуты, а не пяти.
 */
export const revalidate = PROFILE_REVALIDATE_SECONDS;

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3004';

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const listings = await getAuctionListings();
  const entries: MetadataRoute.Sitemap = [];

  for (const locale of locales) {
    for (const listing of listings) {
      // Аудит-фикс: изначально здесь стоял expiresAt как lastModified —
      // смысловая ошибка, expiresAt смотрит в будущее, а lastModified
      // обязан быть моментом ПОСЛЕДНЕГО изменения. Честного времени
      // последнего изменения в публичном PublicAuctionListingView нет
      // (createdAt/updatedAt туда не отдаются) — лучше не указывать
      // поле вовсе, чем указывать заведомо неверное.
      entries.push({ url: `${SITE_URL}/${locale}/auctions/${listing.id}` });
    }
  }

  return entries;
}
