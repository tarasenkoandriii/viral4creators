import Link from 'next/link';
import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import type { Metadata } from 'next';
import { getAuctionListing, getAuctionLiveState } from '../../../../lib/api';
import { getDictionary } from '../../../../lib/get-dictionary';
import type { Locale } from '../../../../lib/i18n';
import { AuctionBidForm } from '../../../../components/AuctionBidForm';
import { LiveAuctionStream } from '../../../../components/LiveAuctionStream';
import { COUNTRY_CURRENCY } from '../../../../lib/fx-rates';

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3004';

export async function generateMetadata({
  params,
}: {
  params: { locale: Locale; id: string };
}): Promise<Metadata> {
  const listing = await getAuctionListing(params.id);
  if (!listing) return {};
  return {
    title: listing.title,
    alternates: { canonical: `${SITE_URL}/${params.locale}/auctions/${listing.id}` },
    openGraph: { title: listing.title, type: 'video.other', videos: [{ url: listing.videoUrl }] },
  };
}

export default async function AuctionListingPage({
  params,
}: {
  params: { locale: Locale; id: string };
}) {
  const { locale, id } = params;
  const dict = getDictionary(locale);
  // §22 «не должна оставлять мёртвые публичные ссылки» — не-ACTIVE лот
  // отдаёт 404 уже на бэкенде. На фронте вместо голого 404 — редирект на
  // витрину аукционов с плашкой «аукцион больше не активен» на 30 секунд
  // (см. components/EndedAuctionBanner.tsx) — мягче для человека,
  // который открыл ссылку на уже закрывшийся лот.
  //
  // getAuctionLiveState запрашивается ПАРАЛЛЕЛЬНО с getAuctionListing
  // (Promise.all), не последовательно после неё — это лишний быстрый
  // запрос впустую в редком случае «лот не найден», но экономит целый
  // круг сетевого ожидания в обычном случае «лот есть».
  const [listing, liveState] = await Promise.all([getAuctionListing(id), getAuctionLiveState(id)]);
  if (!listing) redirect(`/${locale}/auctions?ended=1`);

  // Живой аукцион (Этап 6, ТЗ §7.8) — JSON-LD VideoObject+BroadcastEvent
  // только когда реально есть, что размечать: студия назначена лоту, у
  // неё есть готовый видео-фрагмент, эфир СЕЙЧАС активен, и есть
  // обложка (thumbnailUrl — обязательное поле VideoObject у Google,
  // без него лучше не публиковать разметку вовсе, чем неполную). Раз в
  // ACTIVE-статусе лота (см. redirect выше) — не нужно отдельно
  // проверять WON/EXPIRED: getAuctionListing уже вернул бы null.
  const broadcastJsonLd =
    liveState?.liveStreamActive && liveState.videoUrl && liveState.liveStreamStartedAt && listing.thumbnailUrl
      ? {
          '@context': 'https://schema.org',
          '@type': 'VideoObject',
          name: `${listing.title} — прямая трансляция`,
          description: listing.creatorDisplayName
            ? `Прямая трансляция аукциона за видео «${listing.title}» от ${listing.creatorDisplayName}.`
            : `Прямая трансляция аукциона за видео «${listing.title}».`,
          thumbnailUrl: [listing.thumbnailUrl],
          uploadDate: liveState.liveStreamStartedAt,
          contentUrl: liveState.videoUrl,
          publication: {
            '@type': 'BroadcastEvent',
            isLiveBroadcast: true,
            startDate: liveState.liveStreamStartedAt,
            // Плановый конец — двигается антиснайпером (§7.3), это
            // ожидаемо не финальная метка, а лучшая известная на момент
            // рендера страницы (см. AUDIT-Live-Auction-Google-Indexing-
            // API.md §1 про то, зачем вообще нужен Indexing API рядом с
            // этой разметкой — чтобы Google перечитывал её вовремя).
            endDate: liveState.expiresAt,
          },
        }
      : null;

  // Оценка для зрителя из другой страны (по предложению — «валюта той
  // страны, которая в заголовке vercel») — только информационная, не
  // авторитетная сумма: сами ставки и сравнение остаются в валюте,
  // которую выбрал продавец (listing.payoutCurrency), иначе сравнение
  // «кто больше поставил» плавало бы вместе с курсом между заявками.
  // Саму конвертацию считает клиентский компонент — сюда, серверу,
  // достаточно определить страну и передать код валюты как данные, не
  // функцию: функции не пересекают границу сервер/клиент в Next.js.
  const viewerCountry = headers().get('x-vercel-ip-country');
  const viewerCurrency = viewerCountry ? COUNTRY_CURRENCY[viewerCountry] : undefined;
  const estimateCurrency = viewerCurrency && viewerCurrency !== listing.payoutCurrency ? viewerCurrency : null;

  return (
    <>
      {broadcastJsonLd && (
        // eslint-disable-next-line react/no-danger -- JSON-LD, не пользовательский HTML; сериализуем сами объекты выше, XSS не аргумент.
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(broadcastJsonLd) }}
        />
      )}

      <p className="mp-hint">
        <Link href={`/${locale}/auctions`}>← {dict.auctions.heading}</Link>
      </p>

      {/* Живой аукцион (Этап 7, §7.1) — только для BLITZ, тот же гейт, что
          AuctionService.assignVirtualStudio() применяет на бэкенде (§7.3,
          ПРАВКА 1.4): STANDARD-лот никогда не получит студию, поэтому для
          него LiveAuctionStream — просто лишний клиентский поллинг без
          единого шанса на результат. Компонент сам решает live/статика по
          своему опросу /state — начальный liveState (может быть null при
          сетевом сбое серверного рендера) только для первой отрисовки. */}
      {listing.auctionType === 'BLITZ' ? (
        <LiveAuctionStream
          listingId={listing.id}
          initialState={liveState}
          fallbackVideoUrl={listing.videoUrl}
          poster={listing.thumbnailUrl}
          payoutCurrency={listing.payoutCurrency}
          labels={{
            live: dict.auctions.liveBadge,
            newBid: dict.auctions.newBidOverlay,
            unmute: dict.auctions.liveUnmute,
          }}
        />
      ) : (
        // eslint-disable-next-line jsx-a11y/media-has-caption -- пользовательский UGC-ролик, как остальные плееры проекта
        <video
          src={listing.videoUrl}
          controls
          playsInline
          poster={listing.thumbnailUrl ?? undefined}
          style={{ maxHeight: '70vh', margin: '0 auto', display: 'block' }}
        />
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '16px 0' }}>
        <h1 style={{ fontSize: 22, margin: 0 }}>{listing.title}</h1>
        <span style={{ display: 'flex', gap: 6 }}>
          {listing.auctionType === 'BLITZ' && <span className="mp-pill">{dict.auctions.blitzBadge}</span>}
          {listing.isExclusiveBundle && <span className="mp-pill">{dict.auctions.exclusiveBadge}</span>}
        </span>
      </div>

      {listing.creatorDisplayName && (
        <p className="mp-hint">
          <Link href={`/${locale}/creator/${listing.creatorProfileId}`}>{listing.creatorDisplayName}</Link>
        </p>
      )}

      <p className="mp-hint">
        {listing.bidCount > 0
          ? `${listing.bidCount} ${dict.auctions.bidCountSuffix}`
          : dict.auctions.noBidsYet}
        {' · '}
        {dict.auctions.timeLeftLabel}: {new Date(listing.expiresAt).toLocaleString(locale)}
      </p>

      <AuctionBidForm
        listingId={listing.id}
        initialHighestBid={listing.highestBidAmount}
        startingPrice={listing.startingPrice}
        buyNowPrice={listing.buyNowPrice}
        payoutCurrency={listing.payoutCurrency}
        estimateCurrency={estimateCurrency}
      />
    </>
  );
}
