/**
 * Самоподписанный сертификат ТОЛЬКО для локального https-стенда тестов
 * обхода (site-crawl/testing/local-sites.testing.ts). Имена — в
 * зарезервированной зоне `.example` (RFC 2606): `*.polygon.example`,
 * `*.shop-c.polygon.example`, `*.ssrf.example`; срок — 100 лет, чтобы
 * тесты не «протухали». Ключ не секрет: им ничего, кроме стенда на
 * 127.0.0.1, не подписано, и доверяет ему только тестовый агент
 * (`PinnedHttpDeps.tlsCa`). Пересоздать:
 *   openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
 *     -keyout key.pem -out cert.pem -days 36500 -subj "/CN=crawl-test.example" \
 *     -addext "subjectAltName=DNS:*.polygon.example,DNS:polygon.example,DNS:*.shop-c.polygon.example,DNS:*.ssrf.example,DNS:ssrf.example"
 */

export const TEST_TLS_CERT = `-----BEGIN CERTIFICATE-----
MIIB+jCCAaCgAwIBAgIUXaHPvyNWqJSm0w69IvDmTzyIJA0wCgYIKoZIzj0EAwIw
HTEbMBkGA1UEAwwSY3Jhd2wtdGVzdC5leGFtcGxlMCAXDTI2MTAwMTE2Mzg1MFoY
DzIxMjYwOTA3MTYzODUwWjAdMRswGQYDVQQDDBJjcmF3bC10ZXN0LmV4YW1wbGUw
WTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAARVXK6JdjshhKR/ldiqiAQlCvnyIhe3
99oYjMHaH4/TaIRkE7Lm3A7qGGnFR8KiWrwGibVS1KBT4QGBLqXMuUTAo4G7MIG4
MB0GA1UdDgQWBBSq3VsNypReMZ3g4yWXOhktaJsLSzAfBgNVHSMEGDAWgBSq3VsN
ypReMZ3g4yWXOhktaJsLSzAPBgNVHRMBAf8EBTADAQH/MGUGA1UdEQReMFyCESou
cG9seWdvbi5leGFtcGxlgg9wb2x5Z29uLmV4YW1wbGWCGCouc2hvcC1jLnBvbHln
b24uZXhhbXBsZYIOKi5zc3JmLmV4YW1wbGWCDHNzcmYuZXhhbXBsZTAKBggqhkjO
PQQDAgNIADBFAiEAjCayZ3mt1ASWcDH9TekaLUnC6vxrumlptoQKm2CbCdgCIE+G
5o5/iIGHcM010YqpZOtqgR4Wp+adgfKwTrA47pfR
-----END CERTIFICATE-----
`;

export const TEST_TLS_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgBUYh9ib4CJa1Gk7i
uzeUF+IKKArOTmR0SfjGS8eQ3OyhRANCAARVXK6JdjshhKR/ldiqiAQlCvnyIhe3
99oYjMHaH4/TaIRkE7Lm3A7qGGnFR8KiWrwGibVS1KBT4QGBLqXMuUTA
-----END PRIVATE KEY-----
`;
