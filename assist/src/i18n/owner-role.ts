/**
 * Заход 13 (Р-З13-Б1): «Роли» «Админки» — кнопка «моя роль у заказчика →
 * owner» и переход к ней из раздела голосовой карты (подсказка 409
 * `ADMIN_VOICE_MAP_OWNER_ROLE_REQUIRED`). uk/ru/en; сверка ключей —
 * scripts/owner-role.test.ts.
 */
import type { Locale } from '../kit/i18n';

export interface OwnerRoleTexts {
  title: string;
  intro: string;
  mapped: string;
  none: string;
  role: string;
  placeholder: string;
  map: string;
  replaceHint: string;
  done: string;
  already: string;
  bad: string;
  toVoice: string;
  /** Раздел голосовой карты «Админки»: переход к «Ролям». */
  goRoles: string;
  needOwner: string;
  /** Аудит P3-6: пару изменили в другом окне. */
  changed: string;
  /** Аудит P3-7: пара дописана в несохранённый текст карты ролей. */
  kept: string;
}

const uk: OwnerRoleTexts = {
  title: 'Роль власника для редактора карти',
  intro:
    'Редактор голосової карти адмінки відкривається лише співробітнику, чия роль у вашій системі (поле role у JWT) зіставлена з роллю помічника owner. Ця ж роль отримує інструменти owner і в чаті помічника.',
  mapped: 'Зіставлено з owner: {r}',
  none: 'Жодна ваша роль ще не зіставлена з owner — посилання на редактор карти не видається.',
  role: 'Ваша роль у системі (role у JWT)',
  placeholder: 'напр. director',
  map: 'Зіставити з owner',
  replaceHint: 'Зараз «{r}» → «{v}». Замінити на owner?',
  done: '«{r}» → owner. Тепер можна відкрити редактор карти.',
  already: '«{r}» уже зіставлено з owner.',
  bad: 'Роль: 1–64 символи — літери, цифри, _ . : -',
  toVoice: 'До голосової карти адмінки',
  goRoles: 'Зіставити свою роль з owner',
  needOwner:
    'Редактор відкриється, коли вашу роль у системі зіставлено з роллю помічника owner.',
  changed:
    'Карту ролей щойно змінили в іншому вікні — екран оновлено, перевірте й повторіть.',
  kept: 'Пару дописано й у ваш незбережений текст карти ролей — збережіть його.',
};

const ru: OwnerRoleTexts = {
  title: 'Роль владельца для редактора карты',
  intro:
    'Редактор голосовой карты админки открывается только сотруднику, чья роль в вашей системе (поле role в JWT) сопоставлена с ролью помощника owner. Эта же роль получает инструменты owner и в чате помощника.',
  mapped: 'Сопоставлено с owner: {r}',
  none: 'Ни одна ваша роль ещё не сопоставлена с owner — ссылка на редактор карты не выдаётся.',
  role: 'Ваша роль в системе (role в JWT)',
  placeholder: 'напр. director',
  map: 'Сопоставить с owner',
  replaceHint: 'Сейчас «{r}» → «{v}». Заменить на owner?',
  done: '«{r}» → owner. Теперь можно открыть редактор карты.',
  already: '«{r}» уже сопоставлена с owner.',
  bad: 'Роль: 1–64 символа — буквы, цифры, _ . : -',
  toVoice: 'К голосовой карте админки',
  goRoles: 'Сопоставить свою роль с owner',
  needOwner:
    'Редактор откроется, когда ваша роль в системе сопоставлена с ролью помощника owner.',
  changed:
    'Карту ролей только что изменили в другом окне — экран обновлён, проверьте и повторите.',
  kept: 'Пара дописана и в ваш несохранённый текст карты ролей — сохраните его.',
};

const en: OwnerRoleTexts = {
  title: 'Owner role for the map editor',
  intro:
    'The admin voice map editor opens only for a staff member whose role in your system (the role claim of the JWT) is mapped to the assistant role owner. The same role also gets the owner tools in the assistant chat.',
  mapped: 'Mapped to owner: {r}',
  none: 'None of your roles is mapped to owner yet — the map editor link is not issued.',
  role: 'Your role in the system (JWT role)',
  placeholder: 'e.g. director',
  map: 'Map to owner',
  replaceHint: 'Now “{r}” → “{v}”. Replace with owner?',
  done: '“{r}” → owner. You can open the map editor now.',
  already: '“{r}” is already mapped to owner.',
  bad: 'Role: 1–64 characters — letters, digits, _ . : -',
  toVoice: 'To the admin voice map',
  goRoles: 'Map your role to owner',
  needOwner:
    'The editor opens once your role in the system is mapped to the assistant role owner.',
  changed:
    'The role map was just changed in another window — the screen is refreshed, check and try again.',
  kept: 'The pair was also added to your unsaved role map text — save it.',
};

export const OWNER_ROLE_TEXTS: Record<Locale, OwnerRoleTexts> = { uk, ru, en };
