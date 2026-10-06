/**
 * Флаг галереи демо на обучающем лендинге (`/site-tutorial`).
 *
 * Сценарий демонстрации ещё не согласован владельцем
 * (`doc/TUTORIAL-LANDING-DEMO-SCENARIO-DRAFT.md`), поэтому секция по
 * умолчанию ВЫКЛЮЧЕНА: страница остаётся такой, как была, — SVG-схемы и
 * честные подписи, ни одного запроса в API.
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
