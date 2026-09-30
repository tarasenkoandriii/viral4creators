/**
 * Группы поводов на странице поздравлений — «Праздники / Без праздника /
 * Деликатные» (этап H ТЗ `docs-tz/TZ-Greeting-2.0-Adaptive-Persona-Landing.md`
 * §5.2 п.4).
 *
 * ## Откуда группы
 *
 * Не из головы и не из порядка плиток: группа — это РЕГИСТР повода, тот
 * самый, по которому сервер решает, можно ли шутить, ставить наклейку и
 * праздничную музыку (`backend/src/common/greeting-occasions.ts`,
 * поле `register`; правила по регистру — `common/greeting-policy.ts`,
 * `REGISTER_POLICY`). Лендинг обещает в подписи группы ровно то, что
 * делает политика регистра, поэтому повод, стоящий не в той группе, —
 * это не косметика, а обещание, которое сервер не выполнит.
 *
 * ## Почему копия, а не импорт
 *
 * Лендинг — отдельный пакет, и бэкенд он импортировать не может (та же
 * причина, по которой подписи поводов живут в словарях лендинга, —
 * находка 1.5 аудита `AUDIT-Greeting-Landing-And-Upgrade-Plan.md`).
 * Копия закреплена дважды: `scripts/greeting-occasions.test.ts` читает
 * каталог бэкенда текстом и сверяет регистр каждого повода, и шов в
 * `scripts/check-docs.mjs` («группы поводов на лендинге») делает то же
 * из корня репозитория. Поменяли регистр в каталоге — копия покраснеет.
 *
 * ## «Особый повод» — отдельно
 *
 * У `OTHER` в каталоге стоит лишь БАЗОВЫЙ регистр: настоящий человек
 * выбирает на экране (вопрос «какое это событие по настроению»), и
 * описание со словами траура поднимает его строже (§3.4 ТЗ,
 * `resolveOtherRegister`). Положить его в «Без праздника» значило бы
 * соврать про праздничный «особый повод», в «Праздники» — про траурный.
 * Поэтому он ни в одной группе и показывается своей строкой после них.
 */

/** Регистр повода — тот же набор и тот же ПОРЯДОК строгости, что
 *  `GREETING_REGISTERS` в `backend/src/common/types/greeting.types.ts`. */
export type GreetingRegister =
  'CELEBRATORY' | 'WARM_NEUTRAL' | 'SOLEMN' | 'SENSITIVE' | 'MOURNING';

/** Группа на странице. Ключи совпадают с `greetingsLanding.occasions.groups`. */
export type GreetingOccasionGroupId = 'festive' | 'calm' | 'delicate';

/** Повод, который не входит ни в одну группу (см. шапку файла). */
export const OPEN_OCCASION = 'OTHER' as const;

/**
 * Регистр каждого повода — копия каталога бэкенда. Порядок ключей — порядок
 * плиток внутри группы (тот же, что у подписей в `sharedVideo.occasion`).
 */
export const GREETING_OCCASION_REGISTER = {
  BIRTHDAY: 'CELEBRATORY',
  WEDDING: 'CELEBRATORY',
  ANNIVERSARY: 'CELEBRATORY',
  NEW_YEAR: 'CELEBRATORY',
  CHRISTMAS: 'CELEBRATORY',
  GRADUATION: 'CELEBRATORY',
  VALENTINES_DAY: 'CELEBRATORY',
  WOMENS_DAY: 'CELEBRATORY',
  MOTHERS_DAY: 'CELEBRATORY',
  FATHERS_DAY: 'CELEBRATORY',
  DEFENDERS_DAY: 'SOLEMN',
  TEACHERS_DAY: 'CELEBRATORY',
  FIRST_SCHOOL_DAY: 'CELEBRATORY',
  NEW_BABY: 'CELEBRATORY',
  BAPTISM: 'SOLEMN',
  HOUSEWARMING: 'CELEBRATORY',
  PROMOTION: 'CELEBRATORY',
  RETIREMENT: 'CELEBRATORY',
  FAREWELL_COLLEAGUE: 'WARM_NEUTRAL',
  CORPORATE: 'CELEBRATORY',
  APOLOGY: 'SENSITIVE',
  GET_WELL: 'SENSITIVE',
  CONDOLENCE: 'MOURNING',
  OTHER: 'WARM_NEUTRAL',
} as const satisfies Record<string, GreetingRegister>;

export type GreetingOccasionCode = keyof typeof GREETING_OCCASION_REGISTER;

/**
 * Регистр → группа. Граница проведена по двум полям `REGISTER_POLICY`:
 *
 *  - «Праздники» — `festive: true` (только CELEBRATORY): праздничный кадр
 *    и шутливый тон;
 *  - «Без праздника» — `festive: false`, но `strictText: false`
 *    (WARM_NEUTRAL, SOLEMN): без праздничных декораций, текст не
 *    проверяется на праздничность;
 *  - «Деликатные» — `strictText: true` (SENSITIVE, MOURNING): не
 *    поздравляет, без шуток, наклеек и праздничной музыки каталога.
 *
 * Подпись группы в словаре обещает именно это — поэтому таблица полная
 * (`Record`), и новый регистр не соберётся, пока его не отнесут к группе.
 */
export const GROUP_OF_REGISTER: Readonly<
  Record<GreetingRegister, GreetingOccasionGroupId>
> = {
  CELEBRATORY: 'festive',
  WARM_NEUTRAL: 'calm',
  SOLEMN: 'calm',
  SENSITIVE: 'delicate',
  MOURNING: 'delicate',
};

/** Порядок групп на странице: от частого к редкому. */
export const GREETING_OCCASION_GROUP_ORDER: readonly GreetingOccasionGroupId[] =
  ['festive', 'calm', 'delicate'];

export interface GreetingOccasionGroup {
  id: GreetingOccasionGroupId;
  codes: GreetingOccasionCode[];
}

/** Группы с поводами в порядке каталога; «Особый повод» — не здесь. */
export function greetingOccasionGroups(): GreetingOccasionGroup[] {
  const codes = Object.keys(
    GREETING_OCCASION_REGISTER,
  ) as GreetingOccasionCode[];
  return GREETING_OCCASION_GROUP_ORDER.map((id) => ({
    id,
    codes: codes.filter(
      (code) =>
        code !== OPEN_OCCASION &&
        GROUP_OF_REGISTER[GREETING_OCCASION_REGISTER[code]] === id,
    ),
  }));
}
