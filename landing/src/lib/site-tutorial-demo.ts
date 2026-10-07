/**
 * Флаг галереи демо на обучающем лендинге (`/site-tutorial`).
 *
 * Сценарии выбраны владельцем 07.10.2026 (С3 «Условия доставки», С2
 * «Оформить заказ», С4 «Запись на консультацию» —
 * `doc/TUTORIAL-LANDING-DEMO-SCENARIO-DRAFT.md`), но ролики появляются
 * только после ночных прогонов, вычитки и отметки оператора, поэтому
 * секция по умолчанию ВЫКЛЮЧЕНА: страница остаётся такой, как была, —
 * SVG-схемы и честные подписи, ни одного запроса в API. Включённый флаг
 * меняет и оговорку над схемами (`howLeadKey` ниже).
 *
 * Включается переменной окружения сервера `SITE_TUTORIAL_DEMO_GALLERY`
 * (`on` / `1` / `true`, без учёта регистра; всё прочее — выключено).
 * Без префикса `NEXT_PUBLIC_` сознательно: секцию рисует серверная
 * страница, браузеру флаг не нужен. Включённая без роликов секция
 * честно говорит «скоро» (`siteTutorialLanding.demo.unavailable`);
 * ролики появляются только из публичного семейства
 * `site-tutorial-demo-*` (барьер на бэкенде, `tutorial-demo-api.ts`).
 *
 * Включать ПОСЛЕ деплоя бэкенда с этим семейством: старый бэкенд ответит
 * на ключи слотов 404, и секция покажет «временно недоступно».
 */
const ON = new Set(['on', '1', 'true']);

export function siteTutorialDemoEnabled(raw: string | undefined | null): boolean {
  return typeof raw === 'string' && ON.has(raw.trim().toLowerCase());
}

/** Значение читается ЯВНО по имени — так его видит и сборка, и ISR. */
export function siteTutorialDemoFromEnv(): boolean {
  return siteTutorialDemoEnabled(process.env.SITE_TUTORIAL_DEMO_GALLERY);
}

/**
 * Какая оговорка стоит над схемами «Как это выглядит» (`how.*`).
 *
 * Приоритет — у настоящих кадров (`lib/tutorial-frames.ts`): они сами
 * и есть интерфейс, и `leadReal` говорит про них. Иначе картинки —
 * схемы, и оговорка зависит от того, есть ли на странице галерея
 * роликов: с ней настоящий интерфейс показан ниже, в роликах с нашего
 * полигона (`leadDemo`, решение владельца 07.10.2026 — §7.3 п. 7
 * `doc/TUTORIAL-LANDING-DEMO-SCENARIO-DRAFT.md`); без неё — прежняя
 * честная «схемы, а не интерфейс» (`lead`). Одна функция на выбор, чтобы
 * флаг и текст не разошлись правкой в одном месте.
 */
export type HowLeadKey = 'lead' | 'leadReal' | 'leadDemo';

export function howLeadKey(realFrames: boolean, demoGallery: boolean): HowLeadKey {
  if (realFrames) return 'leadReal';
  return demoGallery ? 'leadDemo' : 'lead';
}
