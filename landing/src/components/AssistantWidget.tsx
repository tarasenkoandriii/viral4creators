'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Dictionary } from '../lib/get-dictionary';
import type { Locale } from '../lib/i18n';
import { TMA_URL } from '../lib/content';

/**
 * Виджет ИИ-консультанта — этап «реализовать ТЗ ИИ советника за один
 * проход» (doc/LANDING-TUTORIAL-AI-CONSULTANT-SPEC.md).
 *
 * Один компонент для ДВУХ мест, тот же приём, что уже даёт HowItWorks
 * (variant): `variant="floating"` — плавающая кнопка + выезжающая панель
 * на главной, `variant="embedded"` — всегда открытая панель рядом с
 * блок-схемой на /[locale]/how-it-works. Обязательно `'use client'` —
 * вся логика чата, стрима и проактивных сигналов живёт в состоянии
 * браузера, backend ничего не рендерит здесь на сервере (§4, §6 ТЗ).
 *
 * Потоковый ответ читается через `fetch` + `ReadableStream`, не через
 * `EventSource` — маршрут `POST /assistant/chat` требует тело запроса
 * (сообщения, локаль, id шага), а `EventSource` умеет только GET (§4.3
 * ТЗ прямо оговаривает это ограничение).
 */

type AssistantDict = Dictionary['assistant'];

type AssistantActionKind = 'step' | 'open-app' | 'plan' | 'faq' | 'legal' | 'video';

interface AssistantAction {
  kind: AssistantActionKind;
  stepId?: number;
  planId?: string;
  faqIndex?: number;
  slug?: string;
  /** Только у kind:'video' (этап 99, §4.8) — подставлены сервером, см.
   * backend/src/modules/assistant/assistant.types.ts. */
  subjectKey?: string;
  url?: string;
  title?: string;
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  actions?: AssistantAction[];
}

interface ProactiveTips {
  step: Record<string, string>;
  plans: string;
  exitIntent: string;
}

interface AssistantConfig {
  enabled: boolean;
  maxMessageChars: number;
  suggestedQuestions: Record<string, string[]>;
  proactive: { enabled: boolean; tips: Record<string, ProactiveTips> };
}

type ErrorKind = 'network' | 'rate_limited' | 'budget' | 'upstream' | null;

interface ProactiveTip {
  trigger: 'step' | 'plans' | 'exitIntent' | 'idle';
  text: string;
  stepId?: number;
}

interface AssistantWidgetProps {
  locale: Locale;
  dict: AssistantDict;
  page: 'home' | 'how-it-works';
  variant: 'floating' | 'embedded';
}

// Лендинг впервые ходит с браузера напрямую в API (§4.2 ТЗ — анализ
// «почему не через Next.js route handler») — отдельная от серверной
// `API_BASE_URL` переменная, т.к. клиентский бандл может читать только
// `NEXT_PUBLIC_*` (см. .env.example).
const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? '';

const HISTORY_KEY = 'v4c-assistant';
const SEEN_KEY = 'v4c-assistant-proactive-seen';
const MAX_HISTORY = 10;
// Лендинг хранит id тарифов в нижнем регистре (dict.plans.items[].id),
// бэкенд — в верхнем (common/plans.ts PLAN_IDS); действие `plan` из
// ответа модели приходит в бэкендовом регистре — приводим здесь.
const PLAN_IDS = ['lite', 'standard', 'premium'];

const PAUSE_ON_STEP_MS = 12_000;
const PLANS_DWELL_MS = 8_000;
const EXIT_INTENT_MIN_PAGE_MS = 20_000;
const IDLE_OPEN_PANEL_MS = 15_000;

function safeSessionStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    // Приватный режим/заблокированные cookies — виджет остаётся рабочим,
    // просто без памяти между перезагрузками (§7 ТЗ упоминает это как
    // допустимую деградацию, не как повод не открывать чат).
    return null;
  }
}

function loadHistory(): ChatMessage[] {
  const storage = safeSessionStorage();
  if (!storage) return [];
  try {
    const raw = storage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (m): m is ChatMessage =>
          m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string',
      )
      .slice(-MAX_HISTORY);
  } catch {
    return [];
  }
}

function saveHistory(messages: ChatMessage[]): void {
  const storage = safeSessionStorage();
  if (!storage) return;
  try {
    storage.setItem(
      HISTORY_KEY,
      JSON.stringify(
        messages.slice(-MAX_HISTORY).map(({ role, content }) => ({ role, content })),
      ),
    );
  } catch {
    // Квота переполнена и т.п. — история просто не переживёт перезагрузку.
  }
}

function loadSeen(): Set<string> {
  const storage = safeSessionStorage();
  if (!storage) return new Set();
  try {
    const raw = storage.getItem(SEEN_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed) : new Set();
  } catch {
    return new Set();
  }
}

function saveSeen(seen: Set<string>): void {
  const storage = safeSessionStorage();
  if (!storage) return;
  try {
    storage.setItem(SEEN_KEY, JSON.stringify([...seen]));
  } catch {
    // см. saveHistory — деградация без ошибки.
  }
}

/** Разбирает один SSE-блок (текст между `\n\n`) на имя события и данные. */
function parseSseBlock(raw: string): { event: string | null; data: string | null } {
  let event: string | null = null;
  const dataLines: string[] = [];
  for (const line of raw.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
  }
  return { event, data: dataLines.length > 0 ? dataLines.join('\n') : null };
}

function mapErrorCode(code: string): ErrorKind {
  switch (code) {
    case 'rate_limited':
      return 'rate_limited';
    case 'budget_exhausted':
      return 'budget';
    case 'disabled':
      // Нет отдельного текста под «временно отключён» в словаре — тот же
      // случай, что и апстрим-сбой с точки зрения посетителя: ответа
      // сейчас не будет, попробуйте позже.
      return 'upstream';
    default:
      return 'upstream';
  }
}

export function AssistantWidget({ locale, dict, page, variant }: AssistantWidgetProps) {
  const [config, setConfig] = useState<AssistantConfig | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [open, setOpen] = useState(variant === 'embedded');
  const [floatingVisible, setFloatingVisible] = useState(variant !== 'floating');
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<ErrorKind>(null);
  const [activeStepId, setActiveStepId] = useState<number | undefined>(undefined);
  const [proactiveTip, setProactiveTip] = useState<ProactiveTip | null>(null);

  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const openButtonRef = useRef<HTMLButtonElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const eventQueueRef = useRef<{ kind: string; detail?: string }[]>([]);
  const seenRef = useRef<Set<string>>(new Set());
  const typedRef = useRef(false);
  const pageLoadedAtRef = useRef(0);
  const messagesRef = useRef<ChatMessage[]>([]);

  messagesRef.current = messages;

  // --- Загрузка истории/анкеты сигналов + конфига (§4.3, §7 ТЗ) -------
  useEffect(() => {
    setMessages(loadHistory());
    seenRef.current = loadSeen();
    pageLoadedAtRef.current = Date.now();

    let cancelled = false;
    fetch(`${API_BASE}/assistant/config`)
      .then((res) => (res.ok ? res.json() : null))
      // GET /assistant/config идёт через общий ResponseInterceptor —
      // тело `{success,data,meta}`, полезная часть в `.data`.
      .then((json) => {
        if (!cancelled && json?.data) setConfig(json.data as AssistantConfig);
      })
      .catch(() => {
        // Конфиг не загрузился — виджет остаётся смонтированным, но
        // тихо не показывает кнопку/панель (enabled неизвестен → false).
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (messages.length > 0) saveHistory(messages);
  }, [messages]);

  const flushEvents = useCallback(() => {
    if (eventQueueRef.current.length === 0) return;
    const events = eventQueueRef.current.splice(0, eventQueueRef.current.length);
    const body = JSON.stringify({ events });
    // sendBeacon переживает уход со страницы (pagehide/visibilitychange),
    // обычный fetch там может быть прерван браузером до отправки.
    if (typeof navigator !== 'undefined' && navigator.sendBeacon) {
      try {
        const blob = new Blob([body], { type: 'application/json' });
        if (navigator.sendBeacon(`${API_BASE}/assistant/event`, blob)) return;
      } catch {
        // падаем на fetch ниже
      }
    }
    fetch(`${API_BASE}/assistant/event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
    }).catch(() => {
      // Телеметрия best-effort — молча теряем батч.
    });
  }, []);

  const queueEvent = useCallback(
    (kind: string, detail?: string) => {
      eventQueueRef.current.push({ kind, detail });
      if (eventQueueRef.current.length >= 5) flushEvents();
    },
    [flushEvents],
  );

  // Периодический слив очереди + слив при уходе со страницы.
  useEffect(() => {
    const interval = setInterval(flushEvents, 4000);
    const onHide = () => flushEvents();
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', onHide);
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', onHide);
      flushEvents();
    };
  }, [flushEvents]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ block: 'nearest' });
  }, [messages]);

  // --- Плавающая кнопка появляется после того, как #how попал в вид --
  useEffect(() => {
    if (variant !== 'floating') return;
    const target = document.getElementById('how');
    if (!target || typeof IntersectionObserver === 'undefined') {
      setFloatingVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setFloatingVisible(true);
          observer.disconnect();
        }
      },
      { threshold: 0.1 },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [variant]);

  const showTip = useCallback(
    (tip: ProactiveTip, key: string) => {
      if (seenRef.current.has(key)) return;
      seenRef.current.add(key);
      saveSeen(seenRef.current);
      setProactiveTip(tip);
      queueEvent('proactive_shown', key);
    },
    [queueEvent],
  );

  // --- Проактивные сигналы (§6.6 ТЗ, пять триггеров) ------------------
  // Упрощение по сравнению с ТЗ, зафиксированное явно: «возврат к шагу»
  // не измеряет повторное суммарное время на шаге, а считает возвратом
  // сам факт повторного появления карточки в зоне видимости после того,
  // как посетитель её уже покидал — этого достаточно, чтобы отличить
  // «пролистал мимо» от «вернулся, значит застрял», не усложняя счётчик
  // временными окнами на каждый шаг.
  useEffect(() => {
    if (!config?.proactive.enabled || typeof IntersectionObserver === 'undefined') return;
    const tips = config.proactive.tips[locale];
    if (!tips) return;

    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const visitedSteps = new Set<number>();
    const stepEls = Array.from(document.querySelectorAll<HTMLElement>('.step-card[id^="step-"]'));
    const plansEl = document.getElementById('plans');

    const stepObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const idMatch = entry.target.id.match(/^step-(\d+)$/);
          if (!idMatch) continue;
          const stepId = Number(idMatch[1]);
          const timerKey = `step-${stepId}`;
          if (entry.isIntersecting) {
            if (visitedSteps.has(stepId)) {
              // Возврат — сигнал сразу, без ожидания 12с повторно.
              const text = tips.step[String(stepId)];
              if (text) showTip({ trigger: 'step', text, stepId }, `step:${stepId}`);
              continue;
            }
            const timer = setTimeout(() => {
              visitedSteps.add(stepId);
              const text = tips.step[String(stepId)];
              if (text) showTip({ trigger: 'step', text, stepId }, `step:${stepId}`);
            }, PAUSE_ON_STEP_MS);
            timers.set(timerKey, timer);
          } else {
            const timer = timers.get(timerKey);
            if (timer) {
              clearTimeout(timer);
              timers.delete(timerKey);
            }
          }
        }
      },
      { threshold: 0.5 },
    );
    stepEls.forEach((el) => stepObserver.observe(el));

    let plansObserver: IntersectionObserver | null = null;
    if (plansEl) {
      plansObserver = new IntersectionObserver(
        ([entry]) => {
          if (entry.isIntersecting) {
            const timer = setTimeout(() => {
              showTip({ trigger: 'plans', text: tips.plans }, 'plans');
            }, PLANS_DWELL_MS);
            timers.set('plans', timer);
          } else {
            const timer = timers.get('plans');
            if (timer) {
              clearTimeout(timer);
              timers.delete('plans');
            }
          }
        },
        { threshold: 0.5 },
      );
      plansObserver.observe(plansEl);
    }

    // Exit-intent — только для устройств с точным указателем (мышь), на
    // тачскрине у mouseleave нет того же смысла «уводит курсор к вкладкам».
    const pointerIsMouse =
      typeof window.matchMedia === 'function' && window.matchMedia('(pointer: fine)').matches;
    function onMouseLeave(e: MouseEvent) {
      if (e.clientY > 0) return;
      if (Date.now() - pageLoadedAtRef.current < EXIT_INTENT_MIN_PAGE_MS) return;
      showTip({ trigger: 'exitIntent', text: tips.exitIntent }, 'exitIntent');
    }
    if (pointerIsMouse) document.addEventListener('mouseleave', onMouseLeave);

    return () => {
      stepObserver.disconnect();
      plansObserver?.disconnect();
      if (pointerIsMouse) document.removeEventListener('mouseleave', onMouseLeave);
      timers.forEach((t) => clearTimeout(t));
    };
  }, [config, locale, showTip]);

  // Idle-open-panel — панель открыта ≥15с, ноль сообщений, посетитель не
  // печатал. Готового текста под этот сигнал в ТЗ (§6.6) нет отдельной
  // строки (ProactiveTips знает только step/plans/exitIntent) —
  // сознательное упрощение: переиспользуем тариф-подсказку как самый
  // нейтральный призыв «опишите вашу задачу», раз отдельного текста под
  // этот пятый триггер бэкенд не поставляет.
  useEffect(() => {
    if (!open || !config?.proactive.enabled) return;
    if (messagesRef.current.length > 0) return;
    const tips = config.proactive.tips[locale];
    if (!tips) return;
    const timer = setTimeout(() => {
      if (typedRef.current || messagesRef.current.length > 0) return;
      showTip({ trigger: 'idle', text: tips.plans }, 'idle');
    }, IDLE_OPEN_PANEL_MS);
    return () => clearTimeout(timer);
  }, [open, config, locale, showTip]);

  // --- Открытие/закрытие панели, Escape, фокус-ловушка (как в Header) -
  const closePanel = useCallback(
    (reason: 'user' | 'action' = 'user') => {
      if (variant === 'embedded') return; // встроенная панель не закрывается
      setOpen(false);
      queueEvent('close', reason);
      openButtonRef.current?.focus();
    },
    [variant, queueEvent],
  );

  const openPanel = useCallback(
    (triggeredBy: 'user' | 'proactive' = 'user') => {
      setOpen(true);
      setError(null);
      queueEvent('open', triggeredBy);
    },
    [queueEvent],
  );

  useEffect(() => {
    if (variant !== 'floating' || !open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        closePanel('user');
        return;
      }
      if (e.key !== 'Tab' || !panelRef.current) return;
      const focusable = panelRef.current.querySelectorAll<HTMLElement>(
        'button, [href], input, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    function onClickOutside(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        closePanel('user');
      }
    }
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('mousedown', onClickOutside);
    inputRef.current?.focus();
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('mousedown', onClickOutside);
    };
  }, [variant, open, closePanel]);

  // --- «Спросить об этом шаге» + клики по проактивным подсказкам ------
  // Ссылки живут в HowItWorks.tsx — серверном компоненте без своего
  // состояния (§3.2 ТЗ на исходный HowItWorks) — слушаем клики через
  // делегирование на document, а не пробрасываем колбэк пропом.
  const openWithPrefill = useCallback(
    (stepId: number | undefined, prefillText: string) => {
      setActiveStepId(stepId);
      setInput(prefillText);
      typedRef.current = true;
      openPanel('user');
      requestAnimationFrame(() => inputRef.current?.focus());
    },
    [openPanel],
  );

  useEffect(() => {
    function onClick(e: MouseEvent) {
      const askEl = (e.target as HTMLElement).closest<HTMLElement>('[data-assistant-ask-step]');
      if (askEl) {
        e.preventDefault();
        const stepId = Number(askEl.getAttribute('data-assistant-ask-step'));
        const title = askEl.getAttribute('data-assistant-step-title') ?? '';
        openWithPrefill(Number.isFinite(stepId) ? stepId : undefined, prefillFor(title));
      }
    }
    function prefillFor(title: string): string {
      return dict.askAboutPrefill.replace('{{title}}', title);
    }
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, [dict, openWithPrefill]);

  const handleTipClick = useCallback(() => {
    if (!proactiveTip) return;
    queueEvent('proactive_engaged', proactiveTip.trigger);
    if (proactiveTip.stepId) setActiveStepId(proactiveTip.stepId);
    openPanel('proactive');
    setProactiveTip(null);
  }, [proactiveTip, queueEvent, openPanel]);

  const dismissTip = useCallback(() => {
    if (!proactiveTip) return;
    queueEvent('proactive_dismissed', proactiveTip.trigger);
    setProactiveTip(null);
  }, [proactiveTip, queueEvent]);

  // --- Действия из ответа модели (§5.4 ТЗ) -----------------------------
  const runAction = useCallback(
    (action: AssistantAction) => {
      queueEvent('action_click', action.kind);
      switch (action.kind) {
        case 'open-app':
          window.open(TMA_URL, '_blank', 'noopener,noreferrer');
          return;
        case 'step': {
          const href =
            page === 'how-it-works' ? `#step-${action.stepId}` : `/${locale}/how-it-works#step-${action.stepId}`;
          window.location.href = href;
          return;
        }
        case 'plan': {
          const planId = (action.planId ?? '').toLowerCase();
          if (!PLAN_IDS.includes(planId)) return;
          if (page === 'home') {
            const el = document.querySelector<HTMLElement>(`[data-plan-id="${planId}"]`);
            if (el) {
              el.scrollIntoView({ behavior: 'smooth', block: 'center' });
              el.classList.add('plan-flash');
              setTimeout(() => el.classList.remove('plan-flash'), 1500);
              return;
            }
          }
          window.location.href = `/${locale}#plans`;
          return;
        }
        case 'faq': {
          // Найдено доп. аудитом: `faqIndex` раньше нигде не читался —
          // тот же приём, что уже есть у 'plan' выше (querySelector по
          // data-атрибуту + scrollIntoView + вспышка), теперь открывает
          // ИМЕННО тот вопрос, который назвал ассистент, а не просто
          // прокручивает к началу списка.
          const faqIndex = action.faqIndex;
          if (page === 'home' && typeof faqIndex === 'number') {
            const item = document.querySelector<HTMLElement>(
              `[data-faq-index="${faqIndex}"]`
            );
            if (item) {
              const question = item.querySelector<HTMLButtonElement>('.faq-question');
              if (question && question.getAttribute('aria-expanded') !== 'true') {
                question.click();
              }
              item.scrollIntoView({ behavior: 'smooth', block: 'center' });
              item.classList.add('plan-flash');
              setTimeout(() => item.classList.remove('plan-flash'), 1500);
              return;
            }
          }
          window.location.href = page === 'home' ? '#faq' : `/${locale}#faq`;
          return;
        }
        case 'legal':
          if (action.slug === 'offer' || action.slug === 'terms-of-use') {
            window.location.href = `/legal/${action.slug}`;
          }
          return;
        case 'video':
          // Этап 99 (§4.8) — url подставлен СЕРВЕРОМ (не моделью, см.
          // assistant.types.ts), поэтому просто открываем — та же логика,
          // что у 'open-app'. Пустой url значит, что резолв на бэкенде не
          // нашёл одобренного видео (гонка/устаревший промпт) — тогда
          // кнопка не должна была прийти вовсе, но на всякий случай не
          // открываем пустую вкладку.
          if (action.url) {
            window.open(action.url, '_blank', 'noopener,noreferrer');
          }
          return;
      }
    },
    [locale, page, queueEvent],
  );

  // --- Отправка сообщения + чтение SSE-стрима --------------------------
  const sendMessage = useCallback(
    async (
      rawText: string,
      triggeredBy: 'user' | 'proactive' = 'user',
      opts?: { retry?: boolean },
    ) => {
      const maxChars = config?.maxMessageChars ?? 600;
      const isRetry = opts?.retry === true;
      const text = isRetry ? rawText : rawText.trim().slice(0, maxChars);
      if (!text || streaming) return;

      // Аудит (этап 83): «Повторить» раньше всегда дописывал вопрос ещё
      // раз новым сообщением пользователя — он задваивался и в
      // транскрипте, и в том, что уходит на бэкенд. Любая ошибка ниже
      // теперь безусловно убирает временный пустой ответ ассистента
      // (см. `.slice(0, -1)` во всех трёх ветках), так что после ошибки
      // история уже заканчивается тем самым вопросом — retry просто
      // переотправляет её как есть, не добавляя вопрос повторно.
      const historyForRequest = (
        isRetry
          ? messagesRef.current
          : [...messagesRef.current, { role: 'user' as const, content: text }]
      ).slice(-MAX_HISTORY);
      setMessages([...historyForRequest, { role: 'assistant', content: '' }]);
      // DTO валидирует сообщения строгим whitelist (role+content) —
      // историю UI (которая несёт ещё и `actions` у ответов ассистента)
      // нельзя отправлять как есть, иначе `forbidNonWhitelisted` бэкенда
      // отклонит запрос целиком.
      const wireMessages = historyForRequest.map(({ role, content }) => ({ role, content }));
      if (!isRetry) setInput('');
      typedRef.current = false;
      setStreaming(true);
      setError(null);
      queueEvent('ask', triggeredBy);

      const controller = new AbortController();
      abortRef.current = controller;
      let assistantText = '';

      try {
        const res = await fetch(`${API_BASE}/assistant/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
          body: JSON.stringify({
            locale,
            page,
            stepId: activeStepId,
            messages: wireMessages,
            triggeredBy,
          }),
          signal: controller.signal,
        });

        if (!res.ok || !res.body) {
          setError(res.status === 429 ? 'rate_limited' : res.status === 503 ? 'budget' : 'upstream');
          setMessages((prev) => prev.slice(0, -1));
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let sepIdx = buffer.indexOf('\n\n');
          while (sepIdx !== -1) {
            const raw = buffer.slice(0, sepIdx);
            buffer = buffer.slice(sepIdx + 2);
            const { event: evtName, data } = parseSseBlock(raw);
            if (evtName && data) {
              let payload: Record<string, unknown>;
              try {
                payload = JSON.parse(data);
              } catch {
                sepIdx = buffer.indexOf('\n\n');
                continue;
              }
              if (evtName === 'token' && typeof payload.t === 'string') {
                assistantText += payload.t;
                const text2 = assistantText;
                setMessages((prev) => {
                  const next = [...prev];
                  next[next.length - 1] = { role: 'assistant', content: text2 };
                  return next;
                });
              } else if (evtName === 'actions' && Array.isArray(payload.items)) {
                const items = payload.items as AssistantAction[];
                setMessages((prev) => {
                  const next = [...prev];
                  next[next.length - 1] = { ...next[next.length - 1], actions: items };
                  return next;
                });
              } else if (evtName === 'error' && typeof payload.code === 'string') {
                setError(mapErrorCode(payload.code));
                // Аудит (этап 83): без этого пустой пузырь ответа
                // ассистента оставался в транскрипте (и в sessionStorage)
                // навсегда — SSE-событие `error` может прийти уже после
                // того, как стрим начался, но раньше первого `token`.
                setMessages((prev) => prev.slice(0, -1));
              }
            }
            sepIdx = buffer.indexOf('\n\n');
          }
        }
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          setError('network');
          // Аудит (этап 83): то же самое для сетевой ошибки (обрыв
          // соединения, DNS и т.п.) — до этой правки пустой пузырь
          // оставался в транскрипте навсегда.
          setMessages((prev) => prev.slice(0, -1));
        }
      } finally {
        setStreaming(false);
        abortRef.current = null;
      }
    },
    [config, streaming, locale, page, activeStepId, queueEvent],
  );

  useEffect(() => () => abortRef.current?.abort(), []);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    void sendMessage(input);
  }

  const suggested = useMemo(
    () => config?.suggestedQuestions[locale] ?? [],
    [config, locale],
  );
  const maxChars = config?.maxMessageChars ?? 600;
  const charsLeft = maxChars - input.length;

  // Аудит (этап 83): раньше виджет прятался только когда `config` уже
  // загружен и явно `enabled === false` — пока `config === null` (ещё
  // грузится, ИЛИ запрос `/assistant/config` не удался вовсе, например
  // из-за не заданного в проде `NEXT_PUBLIC_API_BASE_URL`), кнопка и
  // панель всё равно рендерились нерабочими. Остальной проект уже
  // закрывает по умолчанию при неизвестном состоянии (CORS_ORIGIN/CSRF —
  // см. их комментарии) — здесь та же логика: виджет показывается только
  // после явного подтверждения `enabled === true`.
  if (!config?.enabled) return null;

  const panel = (
    <div
      className={`assistant-panel${variant === 'embedded' ? ' assistant-panel-embedded' : ''}`}
      ref={panelRef}
      role={variant === 'floating' ? 'dialog' : undefined}
      aria-modal={variant === 'floating' ? true : undefined}
      aria-label={dict.widgetTitle}
    >
      <div className="assistant-panel-header">
        <strong>{dict.widgetTitle}</strong>
        {variant === 'floating' && (
          <button type="button" className="assistant-close-btn" onClick={() => closePanel('user')} aria-label={dict.closeAria}>
            ×
          </button>
        )}
      </div>

      <div className="assistant-messages">
        {messages.length === 0 && (
          <div className="assistant-empty">
            <p>{dict.emptyHint}</p>
            <div className="assistant-suggested">
              {suggested.map((q) => (
                <button
                  key={q}
                  type="button"
                  className="assistant-suggested-btn"
                  onClick={() => void sendMessage(q)}
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m, i) => (
          <div
            key={i}
            className={`assistant-message assistant-message-${m.role}`}
          >
            <p>{m.content || (streaming && i === messages.length - 1 ? dict.typing : '')}</p>
            {m.actions && m.actions.length > 0 && (
              <div className="assistant-actions">
                {m.actions.map((a, j) => (
                  <button key={j} type="button" className="assistant-action-btn" onClick={() => runAction(a)}>
                    {actionLabel(a, dict)}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
        {error && (
          <div className="assistant-error" role="alert">
            <p>{errorText(error, dict)}</p>
            {error !== 'rate_limited' && error !== 'budget' && (
              <button
                type="button"
                className="assistant-retry-btn"
                onClick={() => {
                  const last = [...messagesRef.current].reverse().find((m) => m.role === 'user');
                  if (last) void sendMessage(last.content, 'user', { retry: true });
                }}
              >
                {dict.retry}
              </button>
            )}
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      <form className="assistant-input-row" onSubmit={handleSubmit}>
        <textarea
          ref={inputRef}
          className="assistant-textarea"
          placeholder={dict.inputPlaceholder}
          aria-label={dict.inputAria}
          value={input}
          maxLength={maxChars}
          rows={1}
          onChange={(e) => {
            typedRef.current = true;
            setInput(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void sendMessage(input);
            }
          }}
        />
        <button type="submit" className="assistant-send-btn" disabled={streaming || !input.trim()}>
          {dict.send}
        </button>
      </form>
      <div className="assistant-panel-footer">
        {input.length > 0 && (
          <span className="assistant-chars-left">{dict.charsLeft.replace('{{n}}', String(Math.max(0, charsLeft)))}</span>
        )}
        <p className="assistant-disclaimer">{dict.disclaimer}</p>
      </div>
    </div>
  );

  if (variant === 'embedded') {
    return (
      <div className="assistant-widget assistant-widget-embedded">
        {proactiveTip && (
          <div className="assistant-tip assistant-tip-embedded">
            <button type="button" className="assistant-tip-text" onClick={handleTipClick}>
              {proactiveTip.text}
            </button>
            <button type="button" className="assistant-tip-close" onClick={dismissTip} aria-label={dict.closeAria}>
              ×
            </button>
          </div>
        )}
        {panel}
      </div>
    );
  }

  return (
    <div className="assistant-widget assistant-widget-floating">
      {proactiveTip && !open && (
        <div className="assistant-tip assistant-tip-floating">
          <button type="button" className="assistant-tip-text" onClick={handleTipClick}>
            {proactiveTip.text}
          </button>
          <button type="button" className="assistant-tip-close" onClick={dismissTip} aria-label={dict.closeAria}>
            ×
          </button>
        </div>
      )}
      {floatingVisible && !open && (
        <button
          type="button"
          ref={openButtonRef}
          className="assistant-floating-btn"
          onClick={() => openPanel('user')}
          aria-label={dict.openAria}
        >
          <span className="assistant-floating-dot" aria-hidden="true" />
          {dict.floatingLabel}
        </button>
      )}
      {open && panel}
    </div>
  );
}

function actionLabel(action: AssistantAction, dict: AssistantDict): string {
  switch (action.kind) {
    case 'open-app':
      return dict.actionOpenApp;
    case 'step':
      return dict.actionStep;
    case 'plan':
      return dict.actionPlan;
    case 'faq':
      return dict.actionFaq;
    case 'legal':
      return dict.actionLegal;
    case 'video':
      // Этап 99 (§4.8) — title приходит от сервера (заголовок конкретного
      // одобренного видео), это точнее общей подписи из словаря; если
      // сервер его почему-то не подставил (см. `resolveVideoActions` в
      // assistant.service.ts — не найдено/не одобрено), используем
      // обычную переводную подпись как запасной вариант.
      return action.title || dict.actionVideo;
    default:
      return dict.actionOpenApp;
  }
}

function errorText(kind: ErrorKind, dict: AssistantDict): string {
  switch (kind) {
    case 'network':
      return dict.errorNetwork;
    case 'rate_limited':
      return dict.errorRateLimited;
    case 'budget':
      return dict.errorBudget;
    default:
      return dict.errorUpstream;
  }
}
