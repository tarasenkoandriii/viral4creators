/**
 * Окружение jest для sites-backend (`setupFiles` в package.json).
 *
 * sites-backend живёт на Vercel: платформа задаёт `VERCEL` и сама
 * переписывает `X-Forwarded-For`, поэтому `clientIp` берёт первый адрес
 * заголовка (`shared/client-ip.ts`, П-С1 захода 10). Приёмочные наборы
 * написаны под эту топологию — свежий XFF на запрос разводит окна
 * лимитов по адресу, «хвост цепочки прокси не делает адрес новым».
 * Здесь тесты по умолчанию «на Vercel», как backend `rate-limit.spec.ts`;
 * ветку «вне Vercel» (адрес сокета, `TRUSTED_PROXY_CIDRS`) проверяют
 * `shared/client-ip.spec.ts` и `web-request.client-ip.spec.ts`, явно
 * передавая env. Заданное снаружи значение не перетирается.
 */
process.env.VERCEL ??= '1';
