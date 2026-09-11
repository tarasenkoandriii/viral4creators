/** @type {import('tailwindcss').Config} */
//
// Design tokens ported from SilverFinance (tailwind.config.ts there) — the
// same "silver / platinum fintech" palette, sky accent, Sora + JetBrains
// Mono, glow/card shadows and the metallic sheen. Dark mode is class-based
// so it can follow Telegram's colorScheme (see src/lib/telegram.ts) rather
// than only the OS setting.
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        display: ['Sora', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: [
          '"JetBrains Mono"',
          'ui-monospace',
          'SFMono-Regular',
          'monospace',
        ],
      },
      colors: {
        silver: {
          50: '#f7f8fa',
          100: '#eef0f4',
          200: '#dde1e9',
          300: '#c2c9d6',
          // Вторичный текст — тоже по темам (этап 29). Во всём коде
          // silver-400 стоит ТОЛЬКО на тексте и иконках (границы берут
          // silver-300/700), а #9aa4b8 на белом даёт 2.6:1 — подписи,
          // хинты и подзаголовки в светлой теме читались с трудом. В
          // светлой теме тон темнеет до ≈4.8:1, в тёмной не меняется.
          400: 'rgb(var(--silver-400) / <alpha-value>)',
          // Б-4.6: silver-500 оставался КОНСТАНТОЙ для обеих тем, хотя
          // стоит на тексте — неактивные пункты навигации, нейтральные
          // бейджи, номера шагов, описания режимов: 3.32–4.27 при норме
          // 4.5. Теперь он переменный, как silver-400: в светлой теме
          // темнеет, в тёмной остаётся прежним #737f97.
          500: 'rgb(var(--silver-500) / <alpha-value>)',
          // Этап 81 (по запросу владельца продукта — «тёмная тема в
          // тонах Телеграм»): 600–950 были константами, одинаковыми в
          // обеих темах — тёмная тема оставалась чёрным вариантом той
          // же серой палитры SilverFinance, ничем не напоминая Telegram.
          // Теперь это тоже переменные: в светлой теме — БУКВАЛЬНО те
          // же значения, что были константами раньше (см. `:root` в
          // src/index.css, ничего в светлой теме не изменилось ни на
          // бит), в тёмной — палитра классической тёмной темы Telegram
          // Desktop (тёмно-синий, не серый). Подобраны так, чтобы
          // светлота (а значит и контраст текста/фона) совпадала с
          // прежними значениями с точностью до сотых — проверено
          // пересчётом контраста по формуле WCAG, см. src/index.css.
          600: 'rgb(var(--silver-600) / <alpha-value>)',
          700: 'rgb(var(--silver-700) / <alpha-value>)',
          800: 'rgb(var(--silver-800) / <alpha-value>)',
          900: 'rgb(var(--silver-900) / <alpha-value>)',
          950: 'rgb(var(--silver-950) / <alpha-value>)',
        },
        // Акцент — переменная, а не константа (этап 29, аудит тем).
        // SilverFinance тёмный по рождению, и его sky-300 (#7dd3fc) на
        // светлом фоне даёт контраст ~1.5:1 — то есть `text-accent` в
        // светлой теме читался как бледное пятно. В светлой теме акцент
        // темнеет до sky-600, в тёмной остаётся прежним; `accent-on` —
        // чернила НА акцентной заливке, они меняются в обратную сторону.
        // Значения — в src/index.css (`--accent`, `--accent-on`).
        accent: {
          DEFAULT: 'rgb(var(--accent) / <alpha-value>)',
          on: 'rgb(var(--accent-on) / <alpha-value>)',
          glow: '#38bdf8',
        },
      },
      boxShadow: {
        glow: '0 0 40px -10px rgba(56,189,248,0.45)',
        card: '0 1px 0 0 rgba(255,255,255,0.04) inset, 0 20px 50px -20px rgba(0,0,0,0.5)',
      },
      backgroundImage: {
        'silver-sheen':
          'linear-gradient(120deg, #c2c9d6 0%, #f7f8fa 25%, #9aa4b8 50%, #f7f8fa 75%, #c2c9d6 100%)',
      },
      keyframes: {
        sheen: {
          '0%': { backgroundPosition: '0% 50%' },
          '100%': { backgroundPosition: '200% 50%' },
        },
        fadeIn: {
          '0%': { opacity: '0', transform: 'translateY(6px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        pulseRing: {
          '0%': { boxShadow: '0 0 0 0 rgba(244,63,94,0.55)' },
          '100%': { boxShadow: '0 0 0 14px rgba(244,63,94,0)' },
        },
      },
      animation: {
        sheen: 'sheen 6s linear infinite',
        fadeIn: 'fadeIn 0.2s ease-out',
        pulseRing: 'pulseRing 1.2s ease-out infinite',
      },
    },
  },
  plugins: [],
};
