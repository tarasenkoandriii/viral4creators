/**
 * Самоподписанный сертификат ТОЛЬКО для https-стенда тестов песочницы K3
 * (k3-sites.testing.ts). Почему не сертификат стенда K1: его имена — в зоне
 * `.example`, а песочница по правилам ядра (normalizeHostInput) такие
 * «внутренние» имена отвергает ещё до сети. Здесь — 40 доменов
 * `k3sb01.com`…`k3sb40.com` (+ поддомены): у каждого теста свой eTLD+1,
 * счётчики «обходов домена» не пересекаются. Срок — 100 лет; ключ не
 * секрет: доверяет ему только тестовый агент (`PinnedHttpDeps.tlsCa`).
 * Пересоздать:
 *   SANS=$(for i in $(seq -w 1 40); do printf "DNS:k3sb%s.com,DNS:*.k3sb%s.com," $i $i; done)
 *   openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
 *     -keyout key.pem -out cert.pem -days 36500 -subj "/CN=k3sb-polygon" \
 *     -addext "subjectAltName=${SANS%,}"
 */

export const K3_TLS_CERT = `-----BEGIN CERTIFICATE-----
MIIFqjCCBVCgAwIBAgIUFrP8UhdgDaFKfvrNXYSMJzaMlN0wCgYIKoZIzj0EAwIw
FzEVMBMGA1UEAwwMazNzYi1wb2x5Z29uMCAXDTI2MTAwMTE3MDU0NVoYDzIxMjYw
OTA3MTcwNTQ1WjAXMRUwEwYDVQQDDAxrM3NiLXBvbHlnb24wWTATBgcqhkjOPQIB
BggqhkjOPQMBBwNCAATcQifj4RSqYgtjKs6VtApsRKfu4i1IuCtGzJW6HqBFGZHE
MqOQxRCo+NUH0FCnD13tm5Vzbm34wOgrcdFLjEl5o4IEdjCCBHIwHQYDVR0OBBYE
FOZnfG3ii1M2ax7fjyab/jxMoZbGMB8GA1UdIwQYMBaAFOZnfG3ii1M2ax7fjyab
/jxMoZbGMA8GA1UdEwEB/wQFMAMBAf8wggQdBgNVHREEggQUMIIEEIIKazNzYjAx
LmNvbYIMKi5rM3NiMDEuY29tggprM3NiMDIuY29tggwqLmszc2IwMi5jb22CCmsz
c2IwMy5jb22CDCouazNzYjAzLmNvbYIKazNzYjA0LmNvbYIMKi5rM3NiMDQuY29t
ggprM3NiMDUuY29tggwqLmszc2IwNS5jb22CCmszc2IwNi5jb22CDCouazNzYjA2
LmNvbYIKazNzYjA3LmNvbYIMKi5rM3NiMDcuY29tggprM3NiMDguY29tggwqLmsz
c2IwOC5jb22CCmszc2IwOS5jb22CDCouazNzYjA5LmNvbYIKazNzYjEwLmNvbYIM
Ki5rM3NiMTAuY29tggprM3NiMTEuY29tggwqLmszc2IxMS5jb22CCmszc2IxMi5j
b22CDCouazNzYjEyLmNvbYIKazNzYjEzLmNvbYIMKi5rM3NiMTMuY29tggprM3Ni
MTQuY29tggwqLmszc2IxNC5jb22CCmszc2IxNS5jb22CDCouazNzYjE1LmNvbYIK
azNzYjE2LmNvbYIMKi5rM3NiMTYuY29tggprM3NiMTcuY29tggwqLmszc2IxNy5j
b22CCmszc2IxOC5jb22CDCouazNzYjE4LmNvbYIKazNzYjE5LmNvbYIMKi5rM3Ni
MTkuY29tggprM3NiMjAuY29tggwqLmszc2IyMC5jb22CCmszc2IyMS5jb22CDCou
azNzYjIxLmNvbYIKazNzYjIyLmNvbYIMKi5rM3NiMjIuY29tggprM3NiMjMuY29t
ggwqLmszc2IyMy5jb22CCmszc2IyNC5jb22CDCouazNzYjI0LmNvbYIKazNzYjI1
LmNvbYIMKi5rM3NiMjUuY29tggprM3NiMjYuY29tggwqLmszc2IyNi5jb22CCmsz
c2IyNy5jb22CDCouazNzYjI3LmNvbYIKazNzYjI4LmNvbYIMKi5rM3NiMjguY29t
ggprM3NiMjkuY29tggwqLmszc2IyOS5jb22CCmszc2IzMC5jb22CDCouazNzYjMw
LmNvbYIKazNzYjMxLmNvbYIMKi5rM3NiMzEuY29tggprM3NiMzIuY29tggwqLmsz
c2IzMi5jb22CCmszc2IzMy5jb22CDCouazNzYjMzLmNvbYIKazNzYjM0LmNvbYIM
Ki5rM3NiMzQuY29tggprM3NiMzUuY29tggwqLmszc2IzNS5jb22CCmszc2IzNi5j
b22CDCouazNzYjM2LmNvbYIKazNzYjM3LmNvbYIMKi5rM3NiMzcuY29tggprM3Ni
MzguY29tggwqLmszc2IzOC5jb22CCmszc2IzOS5jb22CDCouazNzYjM5LmNvbYIK
azNzYjQwLmNvbYIMKi5rM3NiNDAuY29tMAoGCCqGSM49BAMCA0gAMEUCIDAruNdJ
AooBAnAO5WsjA0DaYXUfgyohCCnSbY/lxAUvAiEAvRpzgyAcEY2dFvlJ3fRH39/z
xoWBpJ5PuEJo2vb0cMA=
-----END CERTIFICATE-----
`;

export const K3_TLS_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg1dZe/q0Cp2vC5oVX
OkHTNsrk/Xph5LQb565hd3QZ48qhRANCAATcQifj4RSqYgtjKs6VtApsRKfu4i1I
uCtGzJW6HqBFGZHEMqOQxRCo+NUH0FCnD13tm5Vzbm34wOgrcdFLjEl5
-----END PRIVATE KEY-----
`;

/** Домены, на которые выписан сертификат. */
export const K3_DOMAINS: readonly string[] = Array.from(
  { length: 40 },
  (_, i) => `k3sb${String(i + 1).padStart(2, '0')}.com`,
);
