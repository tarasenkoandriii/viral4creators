"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Клиентская часть полигона — см. доккомментарий `page.tsx`.
 *
 * Состояния переключаются локально, без сети: разведчик ходит по
 * странице кликами, и каждый его раунд обязан видеть НОВОЕ состояние.
 * Сервер для этого не нужен, а его отсутствие делает полигон
 * неспособным сломаться по чужой причине.
 *
 * Селекторы стабильны и перечислены в каталоге
 * (`backend/src/modules/client-site-tutorial/sandbox-catalog.ts`), с
 * которым их сверяет шов `check-docs`. Это тот же приём, что у
 * `qa-hooks.ts` для мастера, и здесь он законен ровно потому, что этот
 * «чужой» DOM на самом деле наш.
 */
/**
 * Через сколько появляется «ленивый» блок. Названо числом с именем, а не
 * литералом: шов держит `SETTLE_FLOOR_MS` разведчика ВЫШЕ этого числа —
 * полигон для того и заведён, чтобы правило оседания на нём
 * проверялось, а не обходилось. Поднимете задержку выше пола — шов
 * скажет, что полигон перестал проверять то, ради чего он есть.
 */
export const SANDBOX_LATE_BLOCK_MS = 1000;

/**
 * Сколько висит спиннер первого экрана (01.10.2026, перенос правок QA
 * TMA). Число выбрано ВЫШЕ пола оседания разведчика (`SETTLE_FLOOR_MS`,
 * 1,5 с) и НИЖЕ потолка мягкого ожидания (`FOREIGN_SETTLE_CEILING_MS`,
 * 3 с): ниже пола спиннер «пережидался» бы полом и опрос общих
 * признаков загрузки не проверялся бы вовсе; выше потолка кадр со
 * спиннером стал бы нормой. Держит это `foreign-frame-settle.spec.ts`.
 */
export const SANDBOX_SPINNER_MS = 2000;

/**
 * Длительность проявления (fade-in) блока — дольше пола и потолка
 * вместе: кадр раунда всегда ловит блок на полпути, и только `finish()`
 * конечных анимаций перед снимком показывает его целиком. Именно
 * `finish`, а не `animation:none`: при `none` блок с `opacity:0` в
 * первом ключевом кадре остался бы невидимым навсегда.
 */
export const SANDBOX_FADE_MS = 5000;

/** Ключевые кадры полигона — строкой в `<style>`: у страницы нет своего
 * CSS-модуля, и заводить его ради двух анимаций незачем. */
const SANDBOX_KEYFRAMES = `
@keyframes sandbox-spin { to { transform: rotate(360deg); } }
@keyframes sandbox-fade { from { opacity: 0; } to { opacity: 1; } }
`;

export function SandboxClient() {
  const [cookiesAccepted, setCookiesAccepted] = useState(false);
  const [screen, setScreen] = useState<"start" | "signed-in">("start");
  const [lateVisible, setLateVisible] = useState(false);
  const [spinnerVisible, setSpinnerVisible] = useState(true);
  const [belowClicked, setBelowClicked] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    // Спиннер без сети: исчезает по таймеру, как клиентская отрисовка
    // чужого сайта. Затишье сети его не увидит — только общие признаки
    // загрузки (role=progressbar без aria-valuenow, класс «spinner»).
    const t = setTimeout(() => setSpinnerVisible(false), SANDBOX_SPINNER_MS);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    // Видео — живой поток с холста, а не файл: в `public/` лендинга
    // медиа нет, а поток изображает худший случай — видео, которое не
    // «догружается» никогда. Решение координатора 01.10.2026: медиа на
    // чужом сайте в обучалке НЕ обрываются, и раунд не должен ждать их
    // окончания. Сети поток не тратит — полигон по-прежнему не может
    // сломаться по чужой причине.
    const video = videoRef.current;
    if (!video) return;
    const canvas = document.createElement("canvas");
    canvas.width = 160;
    canvas.height = 90;
    const ctx = canvas.getContext("2d");
    if (!ctx || typeof canvas.captureStream !== "function") return;
    let frame = 0;
    let raf = 0;
    const draw = () => {
      frame += 1;
      ctx.fillStyle = `hsl(${frame % 360} 70% 45%)`;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#fff";
      ctx.fillText(`кадр ${frame}`, 8, 20);
      raf = requestAnimationFrame(draw);
    };
    draw();
    const stream = canvas.captureStream(30);
    video.srcObject = stream;
    void video.play().catch(() => undefined);
    return () => {
      cancelAnimationFrame(raf);
      stream.getTracks().forEach((track) => track.stop());
      video.srcObject = null;
    };
  }, []);

  useEffect(() => {
    // Ленивый блок: кадр, снятый сразу после навигации, его не увидит.
    // Секунда — заметно больше `idleTime: 400` у `waitForNetworkIdle`
    // и заметно меньше любого таймаута раунда.
    const t = setTimeout(() => setLateVisible(true), SANDBOX_LATE_BLOCK_MS);
    return () => clearTimeout(t);
  }, []);

  return (
    <main
      data-qa="sandbox-root"
      style={{
        fontFamily: "system-ui, sans-serif",
        maxWidth: 420,
        margin: "0 auto",
        padding: 16,
      }}
    >
      <style>{SANDBOX_KEYFRAMES}</style>
      <h1 data-qa="sandbox-title">QA sandbox</h1>
      {spinnerVisible && (
        // Общие признаки, а не хук: разведчик не знает каталога и
        // обязан узнать спиннер так же, как на любом чужом сайте.
        <div
          data-qa="sandbox-spinner"
          className="sandbox-spinner"
          role="progressbar"
          aria-label="Загрузка"
          style={{
            width: 32,
            height: 32,
            border: "4px solid #ccc",
            borderTopColor: "#333",
            borderRadius: "50%",
            animation: "sandbox-spin 0.8s linear infinite",
          }}
        />
      )}
      <p>
        Служебная страница для проверки обхода чужих сайтов. Не является частью
        продукта и не индексируется.
      </p>

      {!cookiesAccepted && (
        // Куки-стена: перекрывает содержимое, как на настоящем чужом
        // сайте. Пока её не закрыли, кадр показывает баннер, а не
        // страницу, — и именно это должен обнаружить оператор.
        <div
          data-qa="sandbox-cookie-banner"
          style={{
            position: "fixed",
            inset: "auto 0 0 0",
            background: "#111",
            color: "#fff",
            padding: 16,
          }}
        >
          <p>Мы используем файлы cookie.</p>
          <button
            type="button"
            data-qa="sandbox-cookie-accept"
            onClick={() => setCookiesAccepted(true)}
          >
            Принять
          </button>
        </div>
      )}

      {screen === "start" ? (
        <form
          data-qa="sandbox-login-form"
          onSubmit={(e) => {
            e.preventDefault();
            setScreen("signed-in");
          }}
        >
          <label htmlFor="sandbox-email">Почта</label>
          <input
            id="sandbox-email"
            data-qa="sandbox-email"
            type="email"
            name="email"
            autoComplete="off"
          />
          <label htmlFor="sandbox-password">Пароль</label>
          {/* Именно `type=password`: на него смотрит эвристика
              `looksLikeLogin` (§5.4), по которой фронтенд зовёт
              `/login`, а не `/step`. */}
          <input
            id="sandbox-password"
            data-qa="sandbox-password"
            type="password"
            name="password"
            autoComplete="off"
          />
          <button type="submit" data-qa="sandbox-submit">
            Войти
          </button>
        </form>
      ) : (
        <section data-qa="sandbox-account">
          <h2>Личный кабинет</h2>
          <p data-qa="sandbox-greeting">Здравствуйте, тестовый пользователь.</p>
          {/* Опасное слово: стоп-лист §8.3 обязан ПРЕДУПРЕДИТЬ о нём,
              не блокируя раунд. Кнопка ничего не делает — полигон не
              должен уметь навредить даже себе. */}
          <button type="button" data-qa="sandbox-delete">
            Удалить аккаунт
          </button>
        </section>
      )}

      {lateVisible && (
        <p data-qa="sandbox-late-block">
          Этот блок появляется через секунду после загрузки.
        </p>
      )}

      <p
        data-qa="sandbox-fade-in"
        style={{ animation: `sandbox-fade ${SANDBOX_FADE_MS}ms ease-out both` }}
      >
        Этот блок медленно проявляется.
      </p>

      <video
        ref={videoRef}
        data-qa="sandbox-video"
        muted
        autoPlay
        playsInline
        width={160}
        height={90}
      />

      {/* Цель ниже первого экрана: кадр после клика без перехода обязан
          показать её в центре окна, а не верх страницы. */}
      <section style={{ marginTop: "150vh" }}>
        <button
          type="button"
          data-qa="sandbox-below-fold"
          onClick={() => setBelowClicked(true)}
        >
          Показать результат
        </button>
        {belowClicked && (
          <p data-qa="sandbox-below-fold-result">Результат рядом с кнопкой.</p>
        )}
      </section>
    </main>
  );
}
