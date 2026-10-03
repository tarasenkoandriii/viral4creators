/// <reference types="vite/client" />

/**
 * Э6-бис (Т-1, §5-бис.12 способ 2): хук подачи звука через WebAudio — ТОЛЬКО
 * в тестовой сборке чанка голоса (`npm run build:test-audio` → dist-test/);
 * в боевой сборке `false`, код хука вырезается (проверка — size-budget.mjs).
 */
declare const __V4C_TEST_AUDIO__: boolean;
