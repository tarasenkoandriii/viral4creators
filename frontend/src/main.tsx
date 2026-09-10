import React from 'react';
import ReactDOM from 'react-dom/client';
import { AppRoot } from './AppRoot';
import { ErrorBoundary } from './components/ErrorBoundary';
import './index.css';
import { initTelegramWebApp } from './lib/telegram';

// No-op outside Telegram — see lib/telegram.ts. Only meaningful when this
// app is opened as the Telegram Mini App (see doc/TELEGRAM-ADMIN.md).
initTelegramWebApp();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {/* Этап 48 (В-5.3): без границы одно исключение в рендере — белый
        экран и мёртвый роутер; выход только закрытием Mini App.
        ErrorBoundary снаружи AppRoot намеренно (этап 55) — граница
        безопасности не должна зависеть от того же дерева провайдеров,
        которое, в теории, могло и упасть; свой словарь для экрана
        аварии ErrorBoundary читает напрямую из localStorage. */}
    <ErrorBoundary>
      <AppRoot />
    </ErrorBoundary>
  </React.StrictMode>
);
