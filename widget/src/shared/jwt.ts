/**
 * Форма employee-JWT «Админки» (три части base64url, без проверки подписи —
 * её делает сервер). Общая для протокола чанк `admin.js` ↔ чат `wa.`
 * (`admin-protocol.ts`) и протокола пикер ↔ панель редактора
 * (`editor-protocol.ts`, заход 11: панель карты «Админки» на `wa.`
 * обменивает JWT на сессию сотрудника сама). Отдельный модуль — чтобы код
 * редактора не импортировал протокол «Админки» (граница — scripts/admin.test.ts).
 */
const JWT =
  /^[A-Za-z0-9_-]{2,1000}\.[A-Za-z0-9_-]{2,3000}\.[A-Za-z0-9_-]{2,200}$/;

export function isJwt(v: unknown): v is string {
  return typeof v === 'string' && v.length <= 4096 && JWT.test(v);
}
