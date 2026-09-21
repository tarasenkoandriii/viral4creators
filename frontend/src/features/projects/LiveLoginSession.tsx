/**
 * Окно живой сессии входа — §7.4.3 ТЗ
 * (doc/CLIENT-SITE-TUTORIAL-SPEC.md) и §8 протокола
 * (doc/LIVE-LOGIN-RELAY-SPEC.md), этап 116.
 *
 * ## Зачем этот компонент вообще существует
 *
 * Аудит нашёл, что этап 115 открывал WS-адрес реле как обычную
 * веб-страницу (`window.open`). Так работать не может: у реле четыре
 * HTTP-маршрута и ни одной HTML-страницы, а `wss://…/stream` — это
 * точка апгрейда протокола. Кнопка «живой вход» существовала, списывала
 * суточный лимит и открывала вкладку с ошибкой. Пультом обязан быть
 * НАШ фронтенд — §7.4.3 так и написан: кадры рисуются на `<canvas>`, а
 * ввод уходит обратно по тому же WS.
 *
 * ## Почему канвас, а не iframe
 *
 * Чужую страницу в iframe не показать (§7.1: `X-Frame-Options` и CSP
 * почти любого сайта с формой входа это запрещают, и обойти нельзя).
 * Здесь показывается не сайт, а ВИДЕОПОТОК нашего собственного
 * браузера, живущего на реле: Chromium присылает JPEG-кадр при каждой
 * перерисовке, мы его рисуем; клики и клавиши едут обратно и
 * ретранслируются в ту же страницу.
 *
 * ## Перевод координат — главный источник ошибок этого класса
 *
 * §7.4.3 прямо называет это известным риском. Кадр приходит в
 * пикселях страницы, канвас на телефоне почти всегда другого размера,
 * и между ними стоит масштаб. Считаем его из РЕАЛЬНОГО размера кадра и
 * реального размера канваса на экране (`getBoundingClientRect`), а не
 * из предполагаемого вьюпорта — тогда поворот экрана и любой CSS
 * ничего не ломают. `metadata.pageScaleFactor`/`offsetTop` учитываются
 * так же, как это делает сам DevTools-просмотрщик.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, Spinner } from '../../components/ui';
import { useI18n } from '../../lib/i18n-context';
import { keyMessages, shouldCaptureKey, wheelToPixels } from './live-input';

interface FrameMetadata {
  offsetTop: number;
  pageScaleFactor: number;
  deviceWidth: number;
  deviceHeight: number;
  scrollOffsetX: number;
  scrollOffsetY: number;
}

type ServerMessage =
  | { type: 'frame'; data: string; metadata: FrameMetadata }
  | { type: 'navigated'; url: string }
  | { type: 'error'; message: string }
  | { type: 'expiring'; reason: string; msRemaining: number }
  | { type: 'closed'; reason: string };

/** Некоторые мобильные сети рвут «тихие» WS — реле специально НЕ
 * считает пинг активностью человека, так что идл-таймаут он не
 * продлевает (§8.3). */
const PING_EVERY_MS = 20_000;

export function LiveLoginSession(props: {
  wsUrl: string;
  streamToken: string;
  onDone: () => void;
  onCancel: () => void;
  busy: boolean;
}) {
  const { dict } = useI18n();
  const t = dict.clientSiteWizard;

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const metaRef = useRef<FrameMetadata | null>(null);
  const [status, setStatus] = useState<'connecting' | 'live' | 'closed'>(
    'connecting'
  );
  const [currentUrl, setCurrentUrl] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** Точка канваса → точка страницы. Всё остальное в этом файле
   * второстепенно: ошибка здесь означает, что человек жмёт мимо. */
  const toPagePoint = useCallback((clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    const meta = metaRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const zoom =
      meta?.pageScaleFactor && meta.pageScaleFactor > 0
        ? meta.pageScaleFactor
        : 1;
    return {
      x: ((clientX - rect.left) * scaleX) / zoom,
      y: ((clientY - rect.top) * scaleY) / zoom + (meta?.offsetTop ?? 0),
    };
  }, []);

  const send = useCallback((message: unknown) => {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  }, []);

  useEffect(() => {
    const socket = new WebSocket(props.wsUrl);
    socketRef.current = socket;

    socket.onopen = () => {
      // §8.1: ПЕРВЫМ сообщением и только им. В query-строке токен
      // оседал бы в логах прокси, поэтому реле его там и не принимает.
      socket.send(JSON.stringify({ type: 'auth', token: props.streamToken }));
      setStatus('live');
    };

    socket.onmessage = (event: MessageEvent<string>) => {
      let message: ServerMessage;
      try {
        message = JSON.parse(event.data) as ServerMessage;
      } catch {
        return;
      }
      if (message.type === 'frame') {
        metaRef.current = message.metadata;
        const canvas = canvasRef.current;
        if (!canvas) return;
        const image = new Image();
        image.onload = () => {
          canvas.width = image.width;
          canvas.height = image.height;
          canvas.getContext('2d')?.drawImage(image, 0, 0);
        };
        image.src = `data:image/jpeg;base64,${message.data}`;
        return;
      }
      if (message.type === 'navigated') {
        // §9 протокола: прозрачность, а не запрет — человек сам видит,
        // на каком он домене. Вход через чужой SSO законен, и реле его
        // не блокирует; проверка «вернулся ли на сайт заказчика» стоит
        // на сервере при завершении.
        setCurrentUrl(message.url);
        return;
      }
      if (message.type === 'expiring') {
        setWarning(
          t.liveExpiring.replace(
            '{seconds}',
            String(Math.max(1, Math.round(message.msRemaining / 1000)))
          )
        );
        return;
      }
      if (message.type === 'error') {
        setError(message.message);
        return;
      }
      if (message.type === 'closed') {
        setStatus('closed');
      }
    };

    socket.onclose = () => setStatus('closed');
    socket.onerror = () => setError(t.liveConnectionError);

    const ping = window.setInterval(
      () => send({ type: 'ping' }),
      PING_EVERY_MS
    );
    return () => {
      window.clearInterval(ping);
      socket.close();
      socketRef.current = null;
    };
  }, [props.wsUrl, props.streamToken, send, t]);

  const live = status === 'live';

  /*
    Колесо вешается нативно, а не через `onWheel`: React ставит
    wheel-слушатели на корень документа ПАССИВНЫМИ, и
    `event.preventDefault()` в них не работает — страница визарда
    уезжала бы вниз вместе с прокруткой чужого сайта.
  */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      if (status !== 'live') return;
      const point = toPagePoint(event.clientX, event.clientY);
      if (!point) return;
      const { deltaX, deltaY } = wheelToPixels(
        event,
        canvas.getBoundingClientRect().height
      );
      send({
        type: 'mouse',
        event: 'mouseWheel',
        x: point.x,
        y: point.y,
        button: 'none',
        deltaX,
        deltaY,
      });
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, [send, status, toPagePoint]);

  const onPointer = (
    event: React.PointerEvent<HTMLCanvasElement>,
    kind: 'mousePressed' | 'mouseReleased' | 'mouseMoved'
  ) => {
    if (!live) return;
    const point = toPagePoint(event.clientX, event.clientY);
    if (!point) return;
    send({
      type: 'mouse',
      event: kind,
      x: point.x,
      y: point.y,
      button: 'left',
    });
  };

  return (
    <Card className="p-3 space-y-3">
      <div className="flex items-center gap-2 text-xs text-[var(--muted)]">
        {status === 'connecting' && <Spinner size={14} />}
        <span className="break-all">{currentUrl ?? t.liveConnecting}</span>
      </div>

      {warning && <Alert tone="warning">{warning}</Alert>}
      {error && <Alert tone="error">{error}</Alert>}
      {status === 'closed' && <Alert tone="warning">{t.liveClosed}</Alert>}

      {/*
        `tabIndex` — не мелочь доступности, а починка. Ретрансляция
        клавиатуры жила ТОЛЬКО в поле под кадром, а человек делает
        естественное: щёлкает по странице в кадре и печатает. Фокус при
        этом оставался где угодно, только не в том поле, и до реле не
        уходило ни одного события — в счётчиках сессии стояло `key=0`
        при живой мыши. Теперь канвас сам принимает фокус по щелчку и
        сам ретранслирует нажатия; поле ниже остаётся ради телефона,
        где экранную клавиатуру поднимает только сфокусированный
        `<input>`.
      */}
      <canvas
        ref={canvasRef}
        tabIndex={0}
        className="w-full touch-none rounded border border-[var(--border)] bg-black outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
        onPointerDown={(e) => {
          // Фокус — раньше захвата указателя: `setPointerCapture`
          // перенаправляет последующие события, но фокус сам по себе
          // не ставит.
          e.currentTarget.focus();
          e.currentTarget.setPointerCapture(e.pointerId);
          onPointer(e, 'mousePressed');
        }}
        onKeyDown={(e) => {
          if (!live) return;
          if (!shouldCaptureKey(e.key)) {
            // `Escape` — выход из кадра, а не сообщение странице.
            if (e.key === 'Escape') e.currentTarget.blur();
            return;
          }
          keyMessages(e).forEach(send);
          // Иначе пробел прокрутит экран визарда, а стрелки уведут
          // фокус — всё это вместо ввода в чужую форму.
          e.preventDefault();
        }}
        onPointerUp={(e) => onPointer(e, 'mouseReleased')}
        onPointerMove={(e) => {
          // Двигаем только при зажатой кнопке: поток событий движения с
          // тачскрина иначе забил бы канал, а ползунковой капче нужно
          // именно перетаскивание.
          if (e.buttons !== 0) onPointer(e, 'mouseMoved');
        }}
      />

      {/*
        Ввод с клавиатуры: на телефоне клавиатуру поднимает только
        сфокусированное поле ввода, поэтому под кадром стоит настоящий
        `<input>`, а его нажатия ретранслируются. Значение в нём не
        копится и никуда не отправляется — только события.
      */}
      <input
        className="input w-full"
        placeholder={t.liveKeyboardHint}
        disabled={!live}
        onKeyDown={(e) => {
          if (!live) return;
          keyMessages(e).forEach(send);
          e.preventDefault();
        }}
        onChange={() => undefined}
        value=""
      />

      <div className="flex gap-2">
        <Button
          block
          disabled={props.busy || status === 'connecting'}
          loading={props.busy}
          onClick={props.onDone}
        >
          {t.liveDoneButton}
        </Button>
        <Button variant="ghost" disabled={props.busy} onClick={props.onCancel}>
          {t.dangerCancel}
        </Button>
      </div>
    </Card>
  );
}
