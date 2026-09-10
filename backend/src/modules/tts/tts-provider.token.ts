/**
 * DI-токен активного провайдера синтеза — вынесен в отдельный файл
 * НАРОЧНО (реальный краш на проде, 2026-09-10), а не объявлен прямо в
 * `tts.module.ts`, как было раньше.
 *
 * Раньше `TTS_PROVIDER` жил в `tts.module.ts`, и `tts.controller.ts`
 * импортировал его оттуда же (`import { TTS_PROVIDER } from
 * './tts.module'`) — а `tts.module.ts`, в свою очередь, импортирует сам
 * `TtsController` (для `controllers: [TtsController]`) РАНЬШЕ, чем в
 * файле объявляется `TTS_PROVIDER`. Это классический цикл импортов
 * между двумя файлами: при старте Node требует `tts.module.ts`, тот на
 * середине своего исполнения (до строки с `export const TTS_PROVIDER`)
 * требует `tts.controller.ts`, а тот немедленно импортирует обратно
 * `TTS_PROVIDER` из ещё не до конца выполненного `tts.module.ts` —
 * и получает `undefined` (CommonJS отдаёт частично заполненный
 * `exports`-объект). Декоратор `@Inject(TTS_PROVIDER)` в `TtsController`
 * в этот момент захватывает `undefined`, поэтому Nest на старте пишет
 * "Nest can't resolve dependencies of the TtsController (?, ...)" —
 * "?" на месте первого аргумента и есть тот самый неопределившийся
 * токен, а лог чуть выше ("Nest encountered an undefined dependency.
 * This may be due to a circular import") — прямое подтверждение
 * причины от самого Nest.
 *
 * В песочнице это не ловилось: спеки `TtsController`/сервисов создают
 * их вручную (`new TtsController(ttsMock, ...)`), минуя настоящую
 * загрузку модулей Node и настоящий DI-граф Nest — тот же класс
 * причины, что и у пропущенного импорта `StorageModule` в
 * `LibraryModule` чуть раньше в этой же сессии.
 *
 * Фикс — стандартный для NestJS: токен внедрения живёт в файле, который
 * НЕ импортирует ничего из `tts.module.ts` и не создаёт цикл. Все
 * потребители (`tts.controller.ts`, `project-session.service.ts`,
 * `brand-manifest.service.ts`, `postprod.service.ts`) и сам
 * `tts.module.ts` импортируют символ отсюда — ни один из них не создаёт
 * цикл с этим файлом, потому что этот файл ни от кого из них не зависит.
 */
export const TTS_PROVIDER = Symbol('TTS_PROVIDER');
