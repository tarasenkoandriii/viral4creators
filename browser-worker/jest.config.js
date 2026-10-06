// Unit: без Chromium и без сети (очередь, подпись, аренда, фильтр
// исходящего трафика на локальных сокетах, стоп-лист, затирание секрета).
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/test/unit/**/*.spec.ts'],
  clearMocks: true,
};
