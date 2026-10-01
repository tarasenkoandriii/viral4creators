/**
 * Имя и @username из Telegram — что записать в `User`, если они
 * поменялись.
 *
 * Зачем: админка показывает пользователя по @username, а не по cuid.
 * Раньше TMA-вход делал `upsert(update: {})`, и у тех, кто пришёл через
 * Mini App, username не появлялся никогда. Писать же его на КАЖДЫЙ
 * запрос нельзя — middleware стоит на всех маршрутах, это лишняя запись
 * в базу на каждое нажатие. Поэтому сравниваем с тем, что уже лежит, и
 * пишем только разницу.
 */

export interface TelegramProfile {
  firstName: string | null;
  username: string | null;
}

/**
 * null — менять нечего. Отсутствующее в Telegram поле — это `null`, а не
 * «не знаю»: человек, убравший @username, должен перестать показываться
 * под старым (его уже может носить другой).
 */
export function profileChanges(
  stored: TelegramProfile,
  incoming: TelegramProfile,
): Partial<TelegramProfile> | null {
  const changes: Partial<TelegramProfile> = {};
  if (stored.firstName !== incoming.firstName) {
    changes.firstName = incoming.firstName;
  }
  if (stored.username !== incoming.username) {
    changes.username = incoming.username;
  }
  return Object.keys(changes).length ? changes : null;
}
