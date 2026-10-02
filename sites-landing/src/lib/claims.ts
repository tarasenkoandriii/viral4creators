/**
 * Реестр утверждений (claims registry) — ТЗ лендинга §3.0, урок Б-4:
 * страница не обещает того, чего нет в проде.
 *
 * Каждый содержательный тезис о продукте в словарях несёт `claim` —
 * ключ этой таблицы, а страница рисует его через `<ClaimBlock>`:
 *  - `hidden` — не рендерится вовсе (и не попадает в HTML, FAQ, JSON-LD);
 *  - `soon`   — рендерится с меткой «скоро» и БЕЗ кнопки/ссылки на фичу;
 *  - `live`   — как обычно.
 * Статус меняется одной строкой при релизе этапа продукта (точки
 * синхронизации С0–С8, `docs-tz/AI-Pomoshchnik-Plan-Etapov.md` §5).
 *
 * Сейчас — точка **С2** (после TMA Э2, MVP; лендинг Л2–Л3): `live` —
 * ровно список С2 плана (§5): ответы по сайту со ссылкой-источником,
 * честное «не знаю», лиды, бренд, 4 угла, своя кнопка, inline, состояние
 * между страницами, живой виджет на лендинге, конфигуратор. Остальное про
 * продукт — `soon` (даже то, что сделано в Э2, но в С2 не названо:
 * установка, подтверждение владения, метка «ИИ», изоляция — решает
 * владелец одной строкой); чего нет в ближайших этапах — `hidden`.
 * С0 (Л1) — бренд, форма пилота, правда о самом лендинге — тоже `live`.
 *
 * Тесты: `scripts/claims.test.ts` (каждый `claim` в словарях — из этой
 * таблицы, hidden не рендерится, soon — с меткой и без ссылок, вариант
 * hero выводится из статусов) и `scripts/built/check-built.ts` (то же по
 * собранному HTML).
 */

export type ClaimStatus = 'live' | 'soon' | 'hidden';

export interface ClaimDef {
  /** Этап продукта/лендинга, с которым утверждение становится правдой. */
  stage: string;
  status: ClaimStatus;
}

export const CLAIMS = {
  // ── С0: то, что правда уже сейчас ──
  brand: { stage: 'С0', status: 'live' },
  'pilot-form': { stage: 'С0 (Л1)', status: 'live' },
  /** Про сам лендинг: без трекеров, Vercel Web Analytics без cookie (§10.1). */
  'landing-no-trackers': { stage: 'Л0', status: 'live' },

  // ── С2 (TMA Э2, MVP; лендинг Л2–Л3) — live ровно по списку С2 плана §5 ──
  'site-answers': { stage: 'TMA-Э2', status: 'live' },
  'source-links': { stage: 'TMA-Э2', status: 'live' },
  'honest-unknown': { stage: 'TMA-Э2', status: 'live' },
  leads: { stage: 'TMA-Э2', status: 'live' },
  branding: { stage: 'TMA-Э2', status: 'live' },
  corners: { stage: 'TMA-Э2', status: 'live' },
  /** «Своя кнопка» заказчика (`V4CAssist('open')`, якорь) — С2. */
  'custom-button': { stage: 'TMA-Э2', status: 'live' },
  /** Встраивание чата в блок страницы (inline) — С2. */
  'inline-embed': { stage: 'TMA-Э2', status: 'live' },
  /** Диалог продолжается при переходе между страницами (§4-бис) — С2. */
  'cross-page-state': { stage: 'TMA-Э2', status: 'live' },
  /** Живой виджет нашего помощника на лендинге — Л2 (С2). */
  'live-widget': { stage: 'Л2 (С2)', status: 'live' },
  /** Конфигуратор без регистрации `/assistant/widget` — Л3 (С2). */
  configurator: { stage: 'Л3 (С2)', status: 'live' },

  // ── Сделано в Э2, но в списке С2 не названо — остаётся soon до решения владельца ──
  'install-snippet': { stage: 'TMA-Э2', status: 'soon' },
  'install-guides': { stage: 'TMA-Э2', status: 'soon' },
  'ownership-verification': { stage: 'TMA-Э2', status: 'soon' },
  'ai-label': { stage: 'TMA-Э2', status: 'soon' },
  'knowledge-isolation': { stage: 'TMA-Э2', status: 'soon' },
  'tenant-isolation': { stage: 'TMA-Э2', status: 'soon' },
  'injection-defense': { stage: 'TMA-Э2', status: 'soon' },
  'visitor-forget': { stage: 'TMA-Э2', status: 'soon' },
  languages: { stage: 'TMA-Э2', status: 'soon' },
  /** 6 шрифтов с нашего хостинга (О-6 контракта Э2): в виджете их ещё нет — системный. */
  'widget-fonts': { stage: 'TMA-Э2 (О-6)', status: 'soon' },
  /** Запись работы — место блока 2, пока живой виджет не подключён (нет ASSIST_WIDGET_PK). */
  'demo-recording': { stage: 'Л2 (после TMA-Э2)', status: 'soon' },

  // ── С3 (TMA Э3) ──
  'telegram-handoff': { stage: 'TMA-Э3', status: 'soon' },
  'wp-plugin': { stage: 'TMA-Э3', status: 'soon' },
  'npm-package': { stage: 'TMA-Э3', status: 'soon' },

  // ── С4 (TMA Э4) ──
  payment: { stage: 'TMA-Э4', status: 'soon' },
  dpa: { stage: 'TMA-Э4', status: 'soon' },

  // ── С5 (TMA Э5–Э6) ──
  voice: { stage: 'TMA-Э5', status: 'soon' },
  video: { stage: 'TMA-Э6', status: 'soon' },
  highlight: { stage: 'TMA-Э6', status: 'soon' },

  // ── С6 (TMA Э7–Э8) ──
  'admin-read': { stage: 'TMA-Э7', status: 'soon' },
  'admin-actions': { stage: 'TMA-Э8', status: 'soon' },
  'api-secrets': { stage: 'TMA-Э7', status: 'soon' },

  // ── Тарифные опции (ТЗ TMA §7.1, §3-бис.1) ──
  'remove-powered-by': { stage: 'TMA-Э4', status: 'soon' },
  'own-loader-domain': { stage: 'TMA-Э2+ (Pro)', status: 'soon' },
  agency: { stage: 'TMA-Э9+ / не решено', status: 'soon' },

  // ── Другой продукт семейства ──
  'qa-product': { stage: 'QA-ТЗ', status: 'soon' },

  // ── hidden: нет в ближайших этапах или лендинг ещё не умеет показать ──
  /** «Попробовать на своём сайте» — Л4 (публичная песочница). */
  sandbox: { stage: 'Л4', status: 'hidden' },
  /** «Подключить в Telegram»: читатели payload в TMA и открытый продукт (§7.2, урок Б-1). */
  'tma-connect': { stage: 'TMA-Э2 + читатель lp_', status: 'hidden' },
  /** Веб-вход в кабинет — нет в этапах продукта (В-13). */
  'web-login': { stage: 'В-13', status: 'hidden' },
  /** Приложение Shopify — Э9+. */
  'shopify-app': { stage: 'TMA-Э9+', status: 'hidden' },
  /** Самообслуживание «статус заказа» — Э9+. */
  'order-status': { stage: 'TMA-Э9+', status: 'hidden' },
  /** Кейсы — только при ≥ 2 реальных пилотах с разрешением (урок Б-3). */
  cases: { stage: 'Л6', status: 'hidden' },
  /** Документация установки — Л5. */
  docs: { stage: 'Л5', status: 'hidden' },
  /** Блог — Л7. */
  blog: { stage: 'Л7', status: 'hidden' },
} as const satisfies Record<string, ClaimDef>;

export type ClaimId = keyof typeof CLAIMS;

export function isClaimId(value: unknown): value is ClaimId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(CLAIMS, value);
}

export type ClaimRegistry = Record<ClaimId, ClaimDef>;

export function claimStatus(id: ClaimId, registry: ClaimRegistry = CLAIMS): ClaimStatus {
  return registry[id].status;
}

export function isVisible(id: ClaimId, registry: ClaimRegistry = CLAIMS): boolean {
  return claimStatus(id, registry) !== 'hidden';
}

/**
 * Вариант hero (§3.0 + аудит 1.4 плана, §5): текст hero сам опирается на
 * этапы продукта, поэтому выводится из статусов, а не пишется руками.
 *  - `pilot` (С0) — всё «скоро», CTA — заявка в пилот;
 *  - `answers` (С2) — «отвечает по знаниям сайта со ссылкой, заявки — в Telegram»;
 *  - `preE6` (С3) — + живой диалог в Telegram;
 *  - `full` (С5) — «не только отвечает, но и показывает — голосом, видео и подсветкой».
 */
export type HeroVariant = 'pilot' | 'answers' | 'preE6' | 'full';

export function heroVariant(registry: ClaimRegistry = CLAIMS): HeroVariant {
  const live = (id: ClaimId) => registry[id].status === 'live';
  if (live('site-answers') && live('leads') && live('telegram-handoff') && live('voice') && live('video') && live('highlight')) {
    return 'full';
  }
  if (live('site-answers') && live('leads') && live('telegram-handoff')) return 'preE6';
  if (live('site-answers') && live('leads')) return 'answers';
  return 'pilot';
}
