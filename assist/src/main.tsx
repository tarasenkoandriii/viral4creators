import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { initTelegram } from './kit';
import './index.css';

// До первого рендера: тема по Telegram и очистка служебного hash
// (#tgWebAppData=…), иначе hash-роутер примет его за путь. Параметр
// запуска (startapp=inv_…) читается ДО очистки и уходит в App.
const { startParam } = initTelegram();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App startParam={startParam} />
  </React.StrictMode>
);
