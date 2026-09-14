/**
 * «Транспорт Grok для одиночных роликов» — доп. запрос владельца
 * продукта (14.09.2026): как ходить в xAI за ОДИНОЧНЫМИ генерациями из
 * мастера (один сегмент или цепочка база + расширение) — синхронными
 * вызовами (`/v1/videos/generations` + опрос `/v1/videos/{id}`, как
 * было) или через Batch API (`/v1/batches`, тот же механизм, что у
 * каталог-партий и перевода блога, но пачка из одного запроса).
 *
 * Зачем два: синхронный путь отвечает за минуты, батч — «обычно до
 * 24 часов», зато дешевле по прайсу xAI и не упирается в лимиты
 * синхронного трафика. Выбор — операторский, на весь стенд, без
 * привязки к бренду или сессии; действует на следующий старт
 * генерации без передеплоя (`PlatformSetting`, тот же приём, что у
 * `default-video-provider.ts`).
 *
 * Уже запущенный ролик дорисовывается тем транспортом, которым был
 * начат: расширение в цепочке идёт тем же путём, что база (см.
 * `GenerationService.continueGrokChain`) — иначе смена настройки
 * посреди рендера дала бы «полбатча, полсинхрона» и два разных
 * дедлайна на одну запись.
 */

export const GROK_VIDEO_TRANSPORT_KEYS = ['sync', 'batch'] as const;

export type GrokVideoTransportKey = (typeof GROK_VIDEO_TRANSPORT_KEYS)[number];

export const GROK_VIDEO_TRANSPORT_SETTING_KEY = 'grok_video_transport';

/**
 * `sync` — поведение до этой настройки; батч включается осознанно, так
 * как форма видео-запроса в пачке подтверждена proto-схемой
 * (`xai-org/xai-proto`, batch.proto), но не живым вызовом — см.
 * доккомментарий `GrokVideoBatchService`.
 */
const FALLBACK_KEY: GrokVideoTransportKey = 'sync';

export function isGrokVideoTransportKey(
  value: string | null | undefined,
): value is GrokVideoTransportKey {
  return (GROK_VIDEO_TRANSPORT_KEYS as readonly string[]).includes(value ?? '');
}

/** Чистая функция, мягкий откат на невалидном значении — как у
 * `resolveDefaultVideoProvider`. */
export function resolveGrokVideoTransport(
  stored: string | null | undefined,
): GrokVideoTransportKey {
  if (isGrokVideoTransportKey(stored)) return stored;
  return FALLBACK_KEY;
}
