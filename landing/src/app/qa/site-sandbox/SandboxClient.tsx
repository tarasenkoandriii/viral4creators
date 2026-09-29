'use client';

import { useEffect, useState } from 'react';

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
export function SandboxClient() {
  const [cookiesAccepted, setCookiesAccepted] = useState(false);
  const [screen, setScreen] = useState<'start' | 'signed-in'>('start');
  const [lateVisible, setLateVisible] = useState(false);

  useEffect(() => {
    // Ленивый блок: кадр, снятый сразу после навигации, его не увидит.
    // Секунда — заметно больше `idleTime: 400` у `waitForNetworkIdle`
    // и заметно меньше любого таймаута раунда.
    const t = setTimeout(() => setLateVisible(true), 1000);
    return () => clearTimeout(t);
  }, []);

  return (
    <main
      data-qa="sandbox-root"
      style={{
        fontFamily: 'system-ui, sans-serif',
        maxWidth: 420,
        margin: '0 auto',
        padding: 16,
      }}
    >
      <h1 data-qa="sandbox-title">QA sandbox</h1>
      <p>
        Служебная страница для проверки обхода чужих сайтов. Не является
        частью продукта и не индексируется.
      </p>

      {!cookiesAccepted && (
        // Куки-стена: перекрывает содержимое, как на настоящем чужом
        // сайте. Пока её не закрыли, кадр показывает баннер, а не
        // страницу, — и именно это должен обнаружить оператор.
        <div
          data-qa="sandbox-cookie-banner"
          style={{
            position: 'fixed',
            inset: 'auto 0 0 0',
            background: '#111',
            color: '#fff',
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

      {screen === 'start' ? (
        <form
          data-qa="sandbox-login-form"
          onSubmit={(e) => {
            e.preventDefault();
            setScreen('signed-in');
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
    </main>
  );
}
