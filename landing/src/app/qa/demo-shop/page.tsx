import type { Metadata, Viewport } from "next";
import { DemoShopClient } from "./DemoShopClient";
import { DEMO_SHOP_COPY, resolveDemoShopLang } from "./demo-shop-copy";

/**
 * Демо-витрина «Лавка „Полігон“» — полигон для роликов обучающего
 * лендинга, 06.10.2026.
 *
 * Решение владельца: демо обучающего лендинга снимается сценарным путём
 * раннера на НАШЕЙ витрине (путь А), сценарии С3 «Условия доставки»,
 * С2 «Оформить заказ», С4 «Запись на консультацию», обе темы
 * (`doc/TUTORIAL-LANDING-DEMO-SCENARIO-DRAFT.md`, разделы 2.2 и 3).
 *
 * ## Почему отдельная страница, а не `site-sandbox`
 *
 * `site-sandbox` — стенд режимов отказа разведчика: куки-стена, спиннер,
 * проявление, «Удалить аккаунт». В ролике это выглядит как стенд, а
 * таймеры съедают бюджет раунда. Встроить туда магазин — значит
 * перестать проверять то, ради чего он заведён. Поэтому витрина рядом,
 * а не вместо, и устроена наоборот: ни сети, ни таймеров, ни спиннеров,
 * ни проявлений, ни ленивых блоков — каждое действие мгновенно меняет
 * состояние, кадр снимается сразу после пола оседания.
 *
 * ## Контракт
 *
 * Элементы, которые трогают сценарии, перечислены в каталоге
 * `backend/src/modules/tutorial-runner/polygon-catalog.ts`
 * (`DEMO_SHOP_HOOKS`); шов «каталог = страница» —
 * `landing/scripts/demo-shop.test.ts`. Язык — `?lang=uk|ru|en|de|es`
 * (по умолчанию `uk`), словарь — `demo-shop-copy.ts` рядом, не в общих
 * словарях лендинга. Тема — `prefers-color-scheme` (раннер ставит её
 * `emulateMedia`), переключателя нет.
 *
 * Всё вымышлено: бренд, товары, цены, сроки и адрес. Оплаты нет —
 * «заказ» и «запись» только меняют состояние страницы.
 */

type Props = { searchParams: Promise<{ lang?: string | string[] }> };

export async function generateMetadata({
  searchParams,
}: Props): Promise<Metadata> {
  const lang = resolveDemoShopLang((await searchParams).lang);
  return {
    title: DEMO_SHOP_COPY[lang].meta.title,
    // Служебная страница: три замка, как у `site-sandbox` — `noindex`
    // здесь, `Disallow: /qa/` в `robots.ts`, отсутствие в `sitemap.ts`.
    // Из навигации лендинга на неё не ссылаются.
    robots: { index: false, follow: false },
  };
}

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f6f4ef" },
    { media: "(prefers-color-scheme: dark)", color: "#141413" },
  ],
  colorScheme: "light dark",
};

export default async function QaDemoShopPage({ searchParams }: Props) {
  const lang = resolveDemoShopLang((await searchParams).lang);
  return <DemoShopClient lang={lang} />;
}
