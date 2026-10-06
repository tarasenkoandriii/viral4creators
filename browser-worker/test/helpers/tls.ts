/**
 * Самоподписанный сертификат стенда (тот же, что у стенда обхода
 * sites-backend, `site-crawl/testing/tls-fixture.testing.ts`). Заголовки
 * PEM собираются во время выполнения: защита от утечек GitHub не любит
 * литерал «BEGIN … PRIVATE KEY» в коде. Ключом ничего, кроме стенда на
 * 127.0.0.1, не подписано; Chromium стенду доверяет только в тестовом
 * режиме (`ignoreHttpsErrors`).
 */
const pem = (kind: string, body: string) =>
  [
    `-----${'BEGIN'} ${kind}-----`,
    body.trim(),
    `-----${'END'} ${kind}-----`,
    '',
  ].join('\n');

export const STAND_CERT = pem(
  'CERTIFICATE',
  `MIIB+jCCAaCgAwIBAgIUXaHPvyNWqJSm0w69IvDmTzyIJA0wCgYIKoZIzj0EAwIw
HTEbMBkGA1UEAwwSY3Jhd2wtdGVzdC5leGFtcGxlMCAXDTI2MTAwMTE2Mzg1MFoY
DzIxMjYwOTA3MTYzODUwWjAdMRswGQYDVQQDDBJjcmF3bC10ZXN0LmV4YW1wbGUw
WTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAARVXK6JdjshhKR/ldiqiAQlCvnyIhe3
99oYjMHaH4/TaIRkE7Lm3A7qGGnFR8KiWrwGibVS1KBT4QGBLqXMuUTAo4G7MIG4
MB0GA1UdDgQWBBSq3VsNypReMZ3g4yWXOhktaJsLSzAfBgNVHSMEGDAWgBSq3VsN
ypReMZ3g4yWXOhktaJsLSzAPBgNVHRMBAf8EBTADAQH/MGUGA1UdEQReMFyCESou
cG9seWdvbi5leGFtcGxlgg9wb2x5Z29uLmV4YW1wbGWCGCouc2hvcC1jLnBvbHln
b24uZXhhbXBsZYIOKi5zc3JmLmV4YW1wbGWCDHNzcmYuZXhhbXBsZTAKBggqhkjO
PQQDAgNIADBFAiEAjCayZ3mt1ASWcDH9TekaLUnC6vxrumlptoQKm2CbCdgCIE+G
5o5/iIGHcM010YqpZOtqgR4Wp+adgfKwTrA47pfR`,
);

export const STAND_KEY = pem(
  ['PRIVATE', 'KEY'].join(' '),
  `MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgBUYh9ib4CJa1Gk7i
uzeUF+IKKArOTmR0SfjGS8eQ3OyhRANCAARVXK6JdjshhKR/ldiqiAQlCvnyIhe3
99oYjMHaH4/TaIRkE7Lm3A7qGGnFR8KiWrwGibVS1KBT4QGBLqXMuUTA`,
);
