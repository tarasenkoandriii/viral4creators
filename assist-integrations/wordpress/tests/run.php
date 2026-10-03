<?php
/**
 * Тесты плагина без WordPress (Э3, T): чистые функции includes/ —
 * подпись s2s и userHash по общим векторам (fixtures/goal-webhook-vectors.json),
 * разбор настроек, тег загрузчика (экранирование pk/origin), маски
 * «не показывать», событие цели из заказа, identify, повторы.
 * Запуск: php wordpress/tests/run.php (CI: assist-integrations).
 */
define('V4C_ASSIST_TESTING', true);
require_once __DIR__ . '/../v4c-assist/includes/brand.php';
require_once __DIR__ . '/../v4c-assist/includes/functions.php';

$failures = 0;
$checks = 0;
function check($cond, $what)
{
    global $failures, $checks;
    $checks++;
    if (!$cond) {
        $failures++;
        fwrite(STDERR, "ПРОВАЛ: $what\n");
    }
}
function same($got, $want, $what)
{
    check($got === $want, $what . ' — получено ' . var_export($got, true) . ', ждали ' . var_export($want, true));
}

$vectors = json_decode(file_get_contents(__DIR__ . '/../../fixtures/goal-webhook-vectors.json'), true);
if (!is_array($vectors) || empty($vectors['webhook']) || empty($vectors['identity'])) {
    fwrite(STDERR, "нет векторов подписи\n");
    exit(1);
}

// ── Подпись и userHash — общие векторы (те же, что у сервера и npm) ──────
foreach ($vectors['webhook'] as $v) {
    same(v4c_assist_sign($v['secret'], $v['body'], $v['t']), $v['header'], 'подпись: ' . $v['name']);
    check(v4c_assist_sign($v['secret'] . 'x', $v['body'], $v['t']) !== $v['header'], 'чужой секрет — другая подпись');
}
foreach ($vectors['identity'] as $v) {
    same(v4c_assist_user_hash($v['secret'], $v['externalId']), $v['userHash'], 'userHash ' . $v['externalId']);
}

// ── Настройки ───────────────────────────────────────────────────────────
$pk = 'pk_live_AbCdEfGhIjKlMnOpQrStUvWx';
$s = v4c_assist_parse_settings(array(
    'site_key' => " $pk ",
    'widget_origin' => 'https://W.Example.com/',
    'position' => 'top-left',
    'hide_on' => "/checkout*\njavascript:alert(1)\n/cart, /account/*",
    'webhook_endpoint' => 'https://api.example.com/assist/v1/sites/abc123/goal-events',
    'order_goal_key' => 'purchase',
    'identify' => '1',
    'order_goals' => '1',
));
same($s['site_key'], $pk, 'ключ обрезан от пробелов');
same($s['widget_origin'], 'https://w.example.com', 'origin нормализован');
same($s['hide_on'], array('/checkout*', '/cart', '/account/*'), 'маски: мусор отброшен');
same($s['webhook_endpoint'], 'https://api.example.com/assist/v1/sites/abc123/goal-events', 'endpoint');
same($s['identify'], true, 'identify');
$bad = v4c_assist_parse_settings(array(
    'site_key' => 'pk"><script>alert(1)</script>',
    'widget_origin' => 'http://evil.example.com',
    'position' => 'middle',
    'webhook_endpoint' => 'http://api.example.com/x',
    'order_goal_key' => 'Bad Key',
));
same($bad['site_key'], '', 'ключ с разметкой — пусто');
same($bad['widget_origin'], V4C_ASSIST_WIDGET_ORIGIN_DEFAULT, 'http-origin — умолчание бренда');
same($bad['position'], '', 'позиция вне перечня');
same($bad['webhook_endpoint'], '', 'endpoint только https');
same($bad['order_goal_key'], 'purchase', 'ключ цели по шаблону');
same(v4c_assist_clean_origin('https://u:p@x.example.com'), null, 'origin с логином');
same(v4c_assist_clean_origin('https://x.example.com/path'), null, 'origin с путём');
same(v4c_assist_clean_origin('http://localhost:5176'), 'http://localhost:5176', 'localhost стенда');

// ── Тег загрузчика: без опций — РОВНО код вставки TMA ────────────────────
same(
    v4c_assist_loader_tag(array('site_key' => $pk, 'widget_origin' => 'https://w.example.com')),
    '<script async src="https://w.example.com' . V4C_ASSIST_LOADER_PATH . '" data-site="' . $pk . '"></script>',
    'тег как snippet.ts'
);
same(
    v4c_assist_loader_tag($s),
    '<script async src="https://w.example.com/v1/loader.js" data-site="' . $pk . '" data-position="top-left" data-hide-on="/checkout*,/cart,/account/*"></script>',
    'тег с позицией и масками'
);
same(v4c_assist_loader_tag($bad), '', 'неверный ключ — тега нет');
same(v4c_assist_loader_tag(array('site_key' => $pk, 'widget_origin' => 'javascript:alert(1)')), '', 'неверный origin — тега нет');
// Маска с кавычкой (разрешена путём) экранируется в атрибуте.
$t = v4c_assist_loader_tag(array('site_key' => $pk, 'widget_origin' => 'https://w.example.com', 'hide_on' => array("/it's*")));
check(strpos($t, 'data-hide-on="/it&#039;s*"') !== false, 'кавычка в маске экранирована: ' . $t);

// ── «Не показывать» ─────────────────────────────────────────────────────
check(v4c_assist_path_hidden('/checkout/pay?x=1', array('/checkout*')), 'checkout скрыт');
check(!v4c_assist_path_hidden('/catalog', array('/checkout*')), 'каталог виден');
check(v4c_assist_path_hidden('/account/orders', array('/account/*')), 'маска /account/*');
check(!v4c_assist_path_hidden('/account', array('/account/*')), '/account без слеша — не под /account/*');
check(!v4c_assist_path_hidden('/a.b', array('/a?b')), 'символы маски — буквально, кроме *');

// ── Событие цели из заказа ─────────────────────────────────────────────
$e = v4c_assist_order_event(array('number' => 'A-1042', 'status' => 'completed', 'total' => '1299.00', 'currency' => 'uah', 'date' => '2026-10-03T10:00:00.000Z'), 'purchase');
same($e, array('goalKey' => 'purchase', 'orderId' => 'A-1042', 'value' => 1299.0, 'currency' => 'UAH', 'status' => 'completed', 'occurredAt' => '2026-10-03T10:00:00.000Z'), 'событие покупки');
same(v4c_assist_event_body($e), $vectors['webhook'][0]['body'], 'покупка — тело как в векторе');
same(v4c_assist_webhook_headers($vectors['webhook'][0]['secret'], v4c_assist_event_body($e), 'A-1042', $vectors['webhook'][0]['t'])[V4C_ASSIST_SIGNATURE_HEADER], $vectors['webhook'][0]['header'], 'заголовок подписи покупки');
$r = v4c_assist_order_event(array('number' => 'A-1042', 'status' => 'refunded', 'total' => '1299', 'date' => '2026-10-04T08:30:00.000Z'), 'purchase');
same(v4c_assist_event_body($r), $vectors['webhook'][1]['body'], 'возврат — тело как в векторе');
$h = v4c_assist_webhook_headers($vectors['webhook'][1]['secret'], v4c_assist_event_body($r), 'A-1042', $vectors['webhook'][1]['t']);
same($h[V4C_ASSIST_SIGNATURE_HEADER], $vectors['webhook'][1]['header'], 'заголовок подписи возврата');
same($h['Idempotency-Key'], 'A-1042', 'Idempotency-Key = номер заказа');
same(v4c_assist_order_event(array('number' => '7', 'status' => 'processing'), 'purchase'), null, 'processing — не цель');
same(v4c_assist_order_event(array('number' => 'ivan@example.com', 'status' => 'completed'), 'purchase'), null, 'e-mail в номере — не шлём (сервер дал бы 422)');
same(v4c_assist_order_event(array('number' => '+380501234567', 'status' => 'completed'), 'purchase'), null, 'телефон в номере — не шлём');
same(v4c_assist_order_event(array('number' => '380501234567', 'status' => 'completed'), 'purchase'), null, 'телефон цифрами — не шлём');
check(v4c_assist_order_event(array('number' => '10423', 'status' => 'completed'), 'purchase') !== null, 'обычный номер заказа — шлём');
same(v4c_assist_order_event(array('number' => 'A 1', 'status' => 'completed'), 'purchase'), null, 'пробел в номере');

// ── identify ────────────────────────────────────────────────────────────
$sec = $vectors['identity'][0]['secret'];
$js = v4c_assist_identify_script(array('name' => '</script><script>alert(1)</script>', 'email' => 'a@b.c', 'externalId' => 'customer-42'), $sec);
check(strpos($js, '<') === false && strpos($js, '>') === false, 'имя с </script> не закрывает тег: ни «<», ни «>»');
check(strpos($js, '"userHash":"' . $vectors['identity'][0]['userHash'] . '"') !== false, 'userHash в identify');
check(strpos($js, "window." . V4C_ASSIST_GLOBAL . "('identify',") !== false, 'вызов identify через глобал бренда');
$noSecret = v4c_assist_identify_script(array('externalId' => 'customer-42'), '');
check(strpos($noSecret, 'userHash') === false, 'без секрета — «заявлено», без userHash');
same(v4c_assist_identify_script(array(), $sec), '', 'пустой покупатель — ничего');

// ── Повторы ─────────────────────────────────────────────────────────────
same(v4c_assist_retry_delay(0), 60, 'первый повтор через минуту');
same(v4c_assist_retry_delay(4), 21600, 'последний повтор');
same(v4c_assist_retry_delay(5), null, 'дальше — сдаёмся');
check(v4c_assist_should_retry(0) && v4c_assist_should_retry(503) && v4c_assist_should_retry(429), 'сеть/5xx/429 — повтор');
check(!v4c_assist_should_retry(204) && !v4c_assist_should_retry(401) && !v4c_assist_should_retry(422), '2xx/401/422 — без повтора');

// ── Э6-бис: data-assist-id для голосового управления ────────────────────
same(v4c_assist_parse_settings(array())['assist_ids'], true, 'разметка по умолчанию включена (старые настройки)');
same(v4c_assist_parse_settings(array('assist_ids_present' => '1'))['assist_ids'], false, 'галочку снять можно');
same(v4c_assist_parse_settings(array('assist_ids_present' => '1', 'assist_ids' => '1'))['assist_ids'], true, 'галочка стоит');
$a = v4c_assist_loop_add_to_cart_args(array('class' => 'button', 'attributes' => array('aria-label' => 'Add')));
same($a['attributes']['data-assist-id'], 'add-to-cart', 'кнопка «В кошик» в списке — add-to-cart');
same($a['attributes']['aria-label'], 'Add', 'чужие атрибуты целы');
$own = v4c_assist_loop_add_to_cart_args(array('attributes' => array('data-assist-id' => 'buy-x')));
same($own['attributes']['data-assist-id'], 'buy-x', 'разметку темы не перетираем');
same(v4c_assist_loop_add_to_cart_args('x'), 'x', 'не массив — как есть');
$form = '<form role="search"><input type="search" class="search-field" name="s" value=""><input type="submit" name="go"></form>';
$out = v4c_assist_search_form_html($form);
check(strpos($out, '<input data-assist-id="search" type="search"') !== false, 'поиск размечен');
same(substr_count($out, 'data-assist-id'), 1, 'размечено ровно одно поле');
same(v4c_assist_search_form_html('<input data-assist-id="q" name="s">'), '<input data-assist-id="q" name="s">', 'своя разметка поиска — не трогаем');
same(v4c_assist_menu_link_attrs(array('href' => 'https://shop.example.com/dostavka/'), 'shop.example.com')['data-assist-id'], 'nav-dostavka', 'меню: nav-<сегмент>');
same(v4c_assist_menu_link_attrs(array('href' => 'https://shop.example.com/'), 'shop.example.com')['data-assist-id'], 'nav-home', 'главная');
same(v4c_assist_menu_link_attrs(array('href' => '/shop/%D0%BA%D0%BE%D1%88%D0%B8%D0%BA/'), 'shop.example.com')['data-assist-id'] ?? null, null, 'кириллический слаг без латиницы — без разметки');
same(isset(v4c_assist_menu_link_attrs(array('href' => 'https://evil.example/x'), 'shop.example.com')['data-assist-id']), false, 'чужой домен — без разметки');
same(v4c_assist_menu_link_attrs(array('href' => '/a', 'data-assist-id' => 'mine'), 'h')['data-assist-id'], 'mine', 'своя разметка меню — не трогаем');
same(v4c_assist_clean_assist_id('Нова Пошта'), '', 'ключ — только латиница');
$js = v4c_assist_assist_ids_script();
check(strpos($js, '<') === false && strpos($js, 'innerHTML') === false, 'скрипт разметки без «<» и HTML-приёмников');
check(strpos($js, 'single_add_to_cart_button') !== false && strpos($js, 'add-to-cart') !== false, 'кнопка «В кошик» на странице товара');

if ($failures) {
    fwrite(STDERR, "wordpress: провалов $failures из $checks\n");
    exit(1);
}
echo "wordpress: $checks проверок, векторов подписи " . count($vectors['webhook']) . " — ок\n";
