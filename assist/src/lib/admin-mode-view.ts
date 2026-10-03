/** Э7: права и тексты экранов «Админки» (общие для экранов и кнопки входа). */
import { useKit } from '../kit';
import { ADMIN_MODE_TEXTS, type AdminModeTexts } from '../i18n/admin-mode';
import {
  ADMIN_ACTIONS_TEXTS,
  type AdminActionsTexts,
} from '../i18n/admin-actions';

/** Владелец «Админки»: роль кабинета owner или `assistAdmin: owner` (§3.2). */
export function isAdminOwner(me: {
  role: string;
  productRoles: { assistAdmin: string };
}): boolean {
  return me.role === 'owner' || me.productRoles.assistAdmin === 'owner';
}

export function useAdminTexts(): AdminModeTexts {
  const { locale } = useKit();
  return ADMIN_MODE_TEXTS[locale];
}

/** Э8: тексты «Админки: действия». */
export function useActionsTexts(): AdminActionsTexts {
  const { locale } = useKit();
  return ADMIN_ACTIONS_TEXTS[locale];
}
