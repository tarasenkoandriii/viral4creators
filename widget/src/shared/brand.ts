/**
 * Публичные имена виджета — зеркало блока «Э2» файла
 * `sites-backend/src/brand.ts` (сверяет scripts/brand.test.ts). Бренд не
 * решён (В-1): переименование = правка этих двух файлов. Ни один другой
 * файл виджета не пишет эти строки литералом (тот же тест).
 */
export const WIDGET_ORIGIN_DEFAULT = 'https://w.v4c.example.invalid';
export const WIDGET_LOADER_PATH = '/v1/loader.js';
export const WIDGET_FRAME_PATH = '/w/v1/frame';
export const WIDGET_GLOBAL = 'V4CAssist';
export const WIDGET_ANCHOR = '#v4c-assist';
export const WIDGET_PREVIEW_PARAM = 'v4c_preview';
export const WIDGET_PK_LIVE_PREFIX = 'pk_live_';
export const WIDGET_PK_TEST_PREFIX = 'pk_test_';
export const WIDGET_VISITOR_TOKEN_HEADER = 'X-Assist-Visitor';
export const WIDGET_PREVIEW_SESSION_HEADER = 'X-Assist-Preview';
export const WIDGET_MESSAGE_NS = 'v4c-widget';
export const WIDGET_PROTOCOL_VERSION = 1;
export const WIDGET_STORAGE_PREFIX = 'v4c_w';
export const WIDGET_CHANNEL_PREFIX = 'v4c-widget';
/** Префикс CHIPS-cookie указателя; имя для сайта — widgetResumeCookieName(pk). */
export const WIDGET_RESUME_COOKIE = '__Host-v4c_resume';

/**
 * Имя cookie указателя ДЛЯ КЛЮЧА САЙТА: `<WIDGET_RESUME_COOKIE>_<8 hex>`.
 * CHIPS партиционирует cookie по сайту ВЕРХНЕГО уровня (eTLD+1): два разных
 * сайта клиентов на одном eTLD+1 (`a.example.com` и `b.example.com`, разные
 * pk) делят одну секцию, и общее имя давало перезапись указателя друг друга
 * (интеграция Э2). Суффикс — FNV-1a 32 бита от pk: не секрет (pk публичен),
 * а короткое различимое имя; считается синхронно и в Node, и в браузере.
 * Зеркало `sites-backend/src/brand.ts` (сверяет scripts/brand.test.ts).
 */
export function widgetResumeCookieName(pk: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < pk.length; i++) {
    h ^= pk.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${WIDGET_RESUME_COOKIE}_${h.toString(16).padStart(8, '0')}`;
}

// Э3 (зеркало блока «Э3» sites-backend/src/brand.ts).
export const WIDGET_GOAL_PICKER_PARAM = 'v4c_goal';
export const WIDGET_PICKER_PATH = '/v1/picker.js';
export const WIDGET_ENGAGE_PATH = '/v1/engage.js';
export const WIDGET_GOAL_ATTR = 'data-assist-goal';
export const WIDGET_GOAL_SUBMIT_ATTR = 'data-assist-goal-submit';

// Э6: подсветка элемента страницы («показать на экране», ТЗ §4.12) — ленивый
// чанк загрузчика: грузится только по клику посетителя на «Показать на
// странице» (бюджет загрузчика 12 КБ не поднимается).
export const WIDGET_HIGHLIGHT_PATH = '/v1/highlight.js';

// Э6-бис: голосовое управление — снимок страницы и исполнитель шагов
// (ленивый чанк загрузчика: только по команде своего iframe).
export const WIDGET_ACT_PATH = '/v1/act.js';

// Э6-бис (г): мастер проверки голосового управления (зеркало блока «Э6-бис
// (г)» sites-backend/src/brand.ts) — параметр одноразовой ссылки, заголовок
// тестовой сессии, ленивый чанк проверки страницы.
export const WIDGET_VOICE_TEST_PARAM = 'v4c_voicetest';
export const WIDGET_VOICE_TEST_HEADER = 'X-Assist-Voice-Test';
export const WIDGET_CHECK_PATH = '/v1/check.js';

// Э7: «Админка» — помощник сотрудника (зеркало блока «Э7»
// sites-backend/src/brand.ts). Отдельный origin iframe (`wa.`, У-13): тег
// загрузчика в админке заказчика — с этого origin и `data-mode="admin"`;
// загрузчик только отдаёт управление ленивому чанку `admin.js`.
export const WIDGET_ADMIN_ORIGIN_DEFAULT = 'https://wa.v4c.example.invalid';
export const WIDGET_ADMIN_PATH = '/v1/admin.js';
export const WIDGET_ADMIN_FRAME_PATH = '/wa/v1/frame';
export const WIDGET_ADMIN_MODE = 'admin';
export const ADMIN_SESSION_HEADER = 'X-Assist-Admin-Session';
export const ADMIN_MESSAGE_NS = 'v4c-admin';
export const ADMIN_CHANNEL_PREFIX = 'v4c-admin';

// Э3-бис (зеркало блока «Э3-бис» sites-backend/src/brand.ts): связанный режим
// по согласию посетителя и поведение — ленивые чанки, загрузчик не растёт.
export const WIDGET_ANA_PATH = '/v1/ana.js';
export const WIDGET_BF_PATH = '/v1/bf.js';
