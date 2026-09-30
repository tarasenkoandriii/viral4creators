/**
 * Швы между модулем персоны (E) и соседями, которые пишутся параллельно:
 * генерация картинки образа и квота — у F (`persona-looks.service.ts`),
 * опубликованные страницы с персоной — у G (снимок сессии `usesPersona`).
 *
 * DI-токены вместо прямого импорта: сервис персоны не зависит от того,
 * написан ли уже сосед. Сервис персоны берёт их ЛЕНИВО (`ModuleRef.get`,
 * `strict: false`) — генератор F сам зависит от `PersonaService`, и
 * инъекция в конструктор замкнула бы цикл провайдеров. Регистрировать
 * можно в любом модуле приложения:
 * `{ provide: PERSONA_LOOK_GENERATOR, useExisting: PersonaLooksService }`. Пока провайдера нет, сервис персоны
 * ведёт себя честно: базовый образ — `failed` с понятной ошибкой,
 * квота — нули, список страниц — пустой.
 */

export const PERSONA_LOOK_GENERATOR = 'PERSONA_LOOK_GENERATOR';

export interface PersonaLookGenerator {
  /**
   * Сгенерировать картинку уже созданной строки `PersonaLook` (status
   * `pending`). Базовый образ (`base: true`) — нейтральный портрет по
   * селфи (ровный свет, чистый фон), квоту не списывает (часть проверки).
   * Ставит `ready` + photoUrl/photoPathname или `failed` + error. Может
   * бросить — сервис персоны поймает и пометит `failed`.
   */
  generateLookImage(lookId: string, opts: { base: boolean }): Promise<void>;
  /** Остаток квоты `persona-look` для `GET /personas/me`. */
  quotaLeft(userId: string): Promise<{ dayLeft: number; monthLeft: number }>;
}

export const PERSONA_SHARES_LOOKUP = 'PERSONA_SHARES_LOOKUP';

/** Страница с персоной: `sessionId` — для `DELETE /sessions/:sessionId/shared-video/:id`. */
export interface PersonaShare {
  id: string;
  url: string;
  sessionId: string;
}

export interface PersonaSharesLookup {
  /** Страницы автора (на модерации и опубликованные) с роликами `usesPersona` — для кнопки «снять». */
  publishedSharesWithPersona(userId: string): Promise<PersonaShare[]>;
}

/** Ошибка базового образа, пока генератор F не подключён. */
export const BASE_LOOK_GENERATOR_MISSING =
  'Генерация базового образа ещё не подключена';
