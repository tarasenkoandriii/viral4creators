import { useEffect } from 'react';
import {
  GUIDE_ASSIST_SCRIPT_ID,
  GUIDE_IDENTITY_EVENT,
  GUIDE_JWT_RETRY_MS,
  callAssist,
  loaderAttributes,
  refreshDelayMs,
} from '../lib/guide-assist';
import {
  getGuideAssistConfig,
  getGuideAssistIdentity,
} from '../services/guide-assist-api';

/**
 * Гид мастера в режиме «Админка» помощника платформы (Э-С Ш6).
 *
 * Ничего не рисует сам: при `engine: 'assist'` вставляет загрузчик
 * платформы (`data-mode="admin"` — кнопка и окно помощника в закрытом
 * Shadow DOM, чат — iframe `wa.`) и держит его личность свежей:
 * `V4CAssist('identify-admin', jwt)` сразу и за 90 с до истечения. Нет
 * JWT (флаг выключили, человек вышел) — `V4CAssist('logout')`: окно
 * прячется и чистит состояние; сбой сети — повтор через 30 с без
 * `logout`. Смена личности (`GUIDE_IDENTITY_EVENT`: вход/выход в обычном
 * браузере) — `logout` и всё заново, чтобы диалог прежнего человека не
 * остался на экране (аудит Ш6). При `legacy` не делает ничего — работает
 * старый гид.
 *
 * Монтируется один раз на приложение: TMA — SPA, загрузчик живёт всю
 * сессию, а исполнитель «Админки» сам переживает смену экрана.
 */
export function GuideAssistMount({ locale }: { locale: string }) {
  useEffect(() => {
    let alive = true;
    let run = 0;
    let timer: number | undefined;
    const w = window as unknown as Record<string, unknown>;

    const identify = async (my: number): Promise<void> => {
      const id = await getGuideAssistIdentity();
      if (!alive || my !== run) return;
      if ('failure' in id) {
        if (id.failure === 'off') {
          callAssist(w, 'logout');
          return;
        }
        timer = window.setTimeout(() => void identify(my), GUIDE_JWT_RETRY_MS);
        return;
      }
      callAssist(w, 'identify-admin', id.jwt);
      timer = window.setTimeout(
        () => void identify(my),
        refreshDelayMs(id.exp, Date.now())
      );
    };

    const start = async (my: number): Promise<void> => {
      const cfg = await getGuideAssistConfig();
      if (!alive || my !== run || cfg.engine !== 'assist') return;
      if (!document.getElementById(GUIDE_ASSIST_SCRIPT_ID)) {
        const { src, attrs } = loaderAttributes(cfg, locale);
        const s = document.createElement('script');
        s.async = true;
        s.src = src;
        for (const [k, v] of Object.entries(attrs)) s.setAttribute(k, v);
        document.body.appendChild(s);
      }
      await identify(my);
    };

    const onIdentityChanged = () => {
      run += 1;
      if (timer !== undefined) window.clearTimeout(timer);
      timer = undefined;
      // Загрузчика нет — гасить нечего (и заводить очередь `V4CAssist` зря).
      if (document.getElementById(GUIDE_ASSIST_SCRIPT_ID)) {
        callAssist(w, 'logout');
      }
      void start(run);
    };

    window.addEventListener(GUIDE_IDENTITY_EVENT, onIdentityChanged);
    void start(run);

    return () => {
      alive = false;
      window.removeEventListener(GUIDE_IDENTITY_EVENT, onIdentityChanged);
      if (timer !== undefined) window.clearTimeout(timer);
    };
    // Язык окна выбирается при первой вставке загрузчика; переключение
    // языка мини-аппа не повод перезапускать помощника.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}
