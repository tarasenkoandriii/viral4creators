import { useEffect } from 'react';
import {
  GUIDE_ASSIST_SCRIPT_ID,
  GUIDE_ENGINE_EVENT,
  GUIDE_IDENTITY_EVENT,
  callAssist,
  createGuideAssistController,
  loaderAttributes,
} from '../lib/guide-assist';
import {
  forgetGuideEngineHint,
  getGuideAssistConfig,
  getGuideAssistIdentity,
  guideEngineHint,
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
 * `GET /guide-assist/config` — не на каждом старте (аудит Ш6): если на
 * устройстве известно, что гид человека `legacy`, запроса нет. Гид
 * приходит и в ответе гида проекта (`engine`, событие
 * `GUIDE_ENGINE_EVENT`): `assist` — спросить `config` и запустить окно,
 * `legacy` при работающем окне — `logout`. Логика —
 * `createGuideAssistController` (lib/guide-assist.ts, под unit-скриптом).
 *
 * Монтируется один раз на приложение: TMA — SPA, загрузчик живёт всю
 * сессию, а исполнитель «Админки» сам переживает смену экрана.
 */
export function GuideAssistMount({ locale }: { locale: string }) {
  useEffect(() => {
    const w = window as unknown as Record<string, unknown>;
    const guide = createGuideAssistController({
      getConfig: getGuideAssistConfig,
      getIdentity: getGuideAssistIdentity,
      hint: guideEngineHint,
      forgetHint: forgetGuideEngineHint,
      hasLoader: () => !!document.getElementById(GUIDE_ASSIST_SCRIPT_ID),
      insertLoader: (cfg) => {
        const { src, attrs } = loaderAttributes(cfg, locale);
        const s = document.createElement('script');
        s.async = true;
        s.src = src;
        for (const [k, v] of Object.entries(attrs)) s.setAttribute(k, v);
        document.body.appendChild(s);
      },
      call: (...args) => callAssist(w, ...args),
      setTimer: (fn, ms) => window.setTimeout(fn, ms),
      clearTimer: (id) => window.clearTimeout(id),
      now: () => Date.now(),
    });

    const onIdentityChanged = () => void guide.identityChanged();
    const onEngine = (e: Event) =>
      void guide.engineNews((e as CustomEvent<unknown>).detail);

    window.addEventListener(GUIDE_IDENTITY_EVENT, onIdentityChanged);
    window.addEventListener(GUIDE_ENGINE_EVENT, onEngine);
    void guide.start();

    return () => {
      guide.dispose();
      window.removeEventListener(GUIDE_IDENTITY_EVENT, onIdentityChanged);
      window.removeEventListener(GUIDE_ENGINE_EVENT, onEngine);
    };
    // Язык окна выбирается при первой вставке загрузчика; переключение
    // языка мини-аппа не повод перезапускать помощника.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}
