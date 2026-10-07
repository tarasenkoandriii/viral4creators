/**
 * Вход учёткой из реестра сайта на шаге входа мастера (Э-С Ш2-хвост (3)).
 *
 * Правила экрана без React и без сети (как `client-site-elements.ts`):
 * какие коды отказа сервера во что переводятся, чего не хватило серверу при
 * поиске полей и из каких полей страницы человек выбирает вручную. Логин и
 * пароль учётки на клиент не приходят никогда — здесь их нет и быть не
 * может: только id учётки, её метка и роль, и селекторы полей.
 */
import type {
  LoginFieldPick,
  PageElement,
  PageExploration,
  RegistryLoginAccount,
  RegistryLoginOptions,
} from '../../types/client-site-tutorial';

export const LOGIN_FIELDS_NOT_FOUND = 'LOGIN_FIELDS_NOT_FOUND';

export type LoginFieldKind = 'username' | 'password' | 'submit';

/** Ключ словаря `clientSiteWizard` по коду отказа входа учёткой реестра. */
export function registryLoginErrorKey(
  code: string | null
):
  | 'registryErrUnavailable'
  | 'registryErrAccount'
  | 'registryErrNoPassword'
  | 'registryErrFieldsNotFound'
  | null {
  switch (code) {
    case 'REGISTRY_LOGIN_UNAVAILABLE':
      return 'registryErrUnavailable';
    case 'REGISTRY_ACCOUNT_UNAVAILABLE':
      return 'registryErrAccount';
    case 'REGISTRY_ACCOUNT_NO_PASSWORD':
      return 'registryErrNoPassword';
    case LOGIN_FIELDS_NOT_FOUND:
      return 'registryErrFieldsNotFound';
    default:
      return null;
  }
}

/** Чего не хватило серверу (`reason` отказа: `username,submit`). */
export function missingFields(reason: string | null): LoginFieldKind[] {
  const known: LoginFieldKind[] = ['username', 'password', 'submit'];
  const got = (reason ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is LoginFieldKind => (known as string[]).includes(s));
  // Причина не пришла (старый сервер) — человек указывает всё.
  return got.length ? got : known;
}

/** Показывать ли блок входа учёткой реестра. */
export function registryLoginVisible(
  options: RegistryLoginOptions | null,
  exploration: PageExploration
): boolean {
  return (
    Boolean(options?.available) &&
    (options?.accounts.length ?? 0) > 0 &&
    exploration.looksLikeLogin
  );
}

/** Подпись учётки в списке: метка и роль, больше ничего. */
export function registryAccountLabel(a: RegistryLoginAccount): string {
  return a.role ? `${a.label} · ${a.role}` : a.label;
}

/** Поля пароля — только они годятся для пароля учётки (иначе он в кадре). */
export function passwordFields(exploration: PageExploration): PageElement[] {
  return exploration.elements.filter(
    (e) => e.tag === 'input' && e.type === 'password'
  );
}

const TEXT_TYPES = ['', 'text', 'email', 'tel'];

/** Поля, куда можно ввести логин: текстовые `input`, не пароль. */
export function usernameFields(exploration: PageExploration): PageElement[] {
  return exploration.elements.filter(
    (e) => e.tag === 'input' && TEXT_TYPES.includes(e.type ?? '')
  );
}

/**
 * Тело `pick` из выбора человека. Пароль обязателен (иначе входить
 * нечем), выбранное «поле пароля» должно быть полем пароля, логин — не
 * паролем; кнопка — та, что человек выбрал среди кнопок формы входа.
 */
export function buildPick(
  exploration: PageExploration,
  choice: { username: string; password: string; submit: string | null }
): LoginFieldPick | null {
  const pw = passwordFields(exploration).find(
    (e) => e.selector === choice.password
  );
  if (!pw) return null;
  const pick: LoginFieldPick = { passwordSelector: pw.selector };
  if (choice.username) {
    const user = usernameFields(exploration).find(
      (e) => e.selector === choice.username
    );
    if (!user) return null;
    pick.usernameSelector = user.selector;
  }
  if (choice.submit) pick.submitSelector = choice.submit;
  return pick;
}
