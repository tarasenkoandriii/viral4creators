/**
 * Корневая граница ошибок (этап 48, В-5.3).
 *
 * ## Зачем
 *
 * Без неё одно исключение в рендере размонтировало всё дерево React:
 * белый экран, ноль символов, хеш-роутер мёртв, выход — только закрыть
 * Mini App. Проверено на пробе с сервером, вернувшим `analysisSelection`
 * без массива `scenes`: одно `undefined.length` — и приложения нет. В
 * админке и лендинге спасает встроенная граница Next.js; у Vite-сборки
 * своей нет.
 *
 * ## Что показывает
 *
 * Не стек — ему здесь не место, — а честное «что-то сломалось» с двумя
 * выходами: перезагрузить и начать заново (сброс сохранённой сессии —
 * если сломался именно её разбор, перезагрузка без сброса приведёт в то
 * же место). Причина уходит в консоль для разбора.
 *
 * Классовый компонент — единственный способ поймать ошибку рендера в
 * React; хука для этого нет.
 *
 * Этап 55: текст экрана — на языке пользователя, но БЕЗ `useI18n()` —
 * граница ошибок рендерится снаружи `<I18nProvider>` (см. main.tsx)
 * нарочно: если сломался сам провайдер или что-то под ним, у экрана
 * аварии не должно быть той же точки отказа. Язык читается напрямую из
 * того же localStorage, что использует провайдер (readStoredLocale) —
 * тот же результат, без зависимости от дерева React.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { getDictionary } from '../lib/get-dictionary';
import { defaultLocale, readStoredLocale } from '../lib/i18n';

interface Props {
  children: ReactNode;
}

interface State {
  failed: boolean;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('Ошибка рендера, приложение остановлено:', error, info);
  }

  private reload = () => {
    window.location.reload();
  };

  private restart = () => {
    try {
      localStorage.removeItem('sessionId');
    } catch {
      // Хранилище недоступно — перезагрузка всё равно поможет.
    }
    window.location.hash = '#/';
    window.location.reload();
  };

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    const dict = getDictionary(
      readStoredLocale() ?? defaultLocale
    ).errorBoundary;
    return (
      <div className="min-h-screen flex items-center justify-center p-6 bg-silver-50 dark:bg-silver-950 text-silver-900 dark:text-silver-100">
        <div className="w-full max-w-sm rounded-2xl border border-silver-200/60 dark:border-silver-800 bg-white dark:bg-silver-900 p-6 space-y-4 text-center">
          <h1 className="text-lg font-semibold">{dict.title}</h1>
          <p className="text-sm text-silver-600 dark:text-silver-300">
            {dict.text}
          </p>
          <div className="flex flex-col gap-2">
            <button
              type="button"
              onClick={this.reload}
              className="min-h-[44px] rounded-xl bg-accent px-4 text-sm font-medium text-accent-on"
            >
              {dict.reload}
            </button>
            <button
              type="button"
              onClick={this.restart}
              className="min-h-[44px] rounded-xl px-4 text-sm font-medium text-silver-600 dark:text-silver-300 hover:text-accent"
            >
              {dict.restart}
            </button>
          </div>
        </div>
      </div>
    );
  }
}
