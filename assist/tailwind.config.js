/** @type {import('tailwindcss').Config} */
//
// Токены — те же, что у frontend/ (палитра silver + акцент по темам,
// значения переменных — src/index.css): клиентские TMA выглядят одной
// семьёй с генератором. Тёмная тема — классом, по Telegram colorScheme
// (site-tma-kit/src/telegram.ts → applyTheme).
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
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
          400: 'rgb(var(--silver-400) / <alpha-value>)',
          500: 'rgb(var(--silver-500) / <alpha-value>)',
          600: 'rgb(var(--silver-600) / <alpha-value>)',
          700: 'rgb(var(--silver-700) / <alpha-value>)',
          800: 'rgb(var(--silver-800) / <alpha-value>)',
          900: 'rgb(var(--silver-900) / <alpha-value>)',
          950: 'rgb(var(--silver-950) / <alpha-value>)',
        },
        accent: {
          DEFAULT: 'rgb(var(--accent) / <alpha-value>)',
          on: 'rgb(var(--accent-on) / <alpha-value>)',
        },
      },
    },
  },
  plugins: [],
};
