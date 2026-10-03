<?php
/**
 * Чистые функции плагина (Э3, T): без WordPress, тестируются
 * tests/run.php. Хуки WordPress — includes/hooks.php.
 *
 *  - разбор настроек (ключ, origin виджета, endpoint вебхука, маски, цель);
 *  - тег загрузчика — тот же, что в TMA (assist-site-setup/snippet.ts),
 *    значения экранируются (htmlspecialchars), origin — только https;
 *  - «не показывать на страницах» — маски пути со `*`;
 *  - подпись вебхука целей и userHash — формат fixtures/goal-webhook-vectors.json;
 *  - событие цели из заказа WooCommerce (orderId — по шаблону §5-тер.1);
 *  - identify покупателя — JSON с JSON_HEX_* (`</script>` в имени не ломает тег);
 *  - повторы отправки через wp-cron — расписание.
 */
if (!defined('ABSPATH') && !defined('V4C_ASSIST_TESTING')) {
    exit;
}

/**
 * Публичный ключ сайта: только безопасные символы (префиксы ключа — бренд,
 * их проверяет загрузчик; здесь — чтобы значение не вышло из атрибута).
 */
const V4C_ASSIST_SITE_KEY_RE = '/^[A-Za-z0-9_]{8,64}$/';
/** Маска пути — как PATH_MASK кабинета. */
const V4C_ASSIST_PATH_MASK_RE = "~^/[A-Za-z0-9\\-._\\~%!$&'()*+,;=:@/]*$~";
/** orderId (§5-тер.1): `^[A-Za-z0-9._:-]{1,64}$`. */
const V4C_ASSIST_ORDER_ID_RE = '/^[A-Za-z0-9._:-]{1,64}$/';
/** Ключ цели (GOAL_KEY кабинета). */
const V4C_ASSIST_GOAL_KEY_RE = '/^[a-z0-9_-]{1,40}$/';
const V4C_ASSIST_POSITIONS = array('bottom-right', 'bottom-left', 'top-right', 'top-left');
/** Статусы заказа WooCommerce, которые уходят целью (§5-тер.1 детектор crm). */
const V4C_ASSIST_ORDER_STATUSES = array('completed', 'refunded', 'cancelled');
/** Паузы повторов отправки (секунды); после последней — сдаёмся. */
const V4C_ASSIST_RETRY_DELAYS = array(60, 300, 1800, 7200, 21600);

/**
 * Origin: https (или http://localhost стенда) без пути, логина, query.
 * Возвращает `scheme://host[:port]` или null.
 */
function v4c_assist_clean_origin($raw)
{
    if (!is_string($raw) || $raw === '' || strlen($raw) > 200) {
        return null;
    }
    $u = parse_url(trim($raw));
    if (!is_array($u) || empty($u['scheme']) || empty($u['host'])) {
        return null;
    }
    if (isset($u['user']) || isset($u['pass']) || isset($u['query']) || isset($u['fragment'])) {
        return null;
    }
    if (isset($u['path']) && $u['path'] !== '' && $u['path'] !== '/') {
        return null;
    }
    $scheme = strtolower($u['scheme']);
    $host = strtolower($u['host']);
    if (!preg_match('/^[a-z0-9.-]+$/', $host)) {
        return null;
    }
    $local = ($host === 'localhost' || $host === '127.0.0.1');
    if ($scheme !== 'https' && !($local && $scheme === 'http')) {
        return null;
    }
    $port = isset($u['port']) ? ':' . (int) $u['port'] : '';
    return $scheme . '://' . $host . $port;
}

/** https-адрес endpoint вебхука целей (копируется из TMA «Интеграции»). */
function v4c_assist_clean_endpoint($raw)
{
    if (!is_string($raw) || $raw === '' || strlen($raw) > 500) {
        return null;
    }
    $raw = trim($raw);
    $u = parse_url($raw);
    if (!is_array($u) || empty($u['host']) || isset($u['user']) || isset($u['pass']) || isset($u['fragment'])) {
        return null;
    }
    $origin = v4c_assist_clean_origin($u['scheme'] . '://' . $u['host'] . (isset($u['port']) ? ':' . $u['port'] : ''));
    if ($origin === null) {
        return null;
    }
    $path = isset($u['path']) ? $u['path'] : '/';
    if (!preg_match('~^/[A-Za-z0-9/_.-]*$~', $path)) {
        return null;
    }
    return $origin . $path;
}

/** Маски «не показывать» из текста (по строке или через запятую), ≤ 20. */
function v4c_assist_parse_masks($raw)
{
    $out = array();
    if (!is_string($raw)) {
        return $out;
    }
    foreach (preg_split('/[\r\n,]+/', $raw) as $m) {
        $m = trim($m);
        if ($m === '' || strlen($m) > 200 || !preg_match(V4C_ASSIST_PATH_MASK_RE, $m)) {
            continue;
        }
        if (!in_array($m, $out, true)) {
            $out[] = $m;
        }
        if (count($out) >= 20) {
            break;
        }
    }
    return $out;
}

/**
 * Настройки из формы/опции → нормализованный массив. Неверное значение —
 * пусто (виджет не вставляется, вебхук не шлётся), а не «как-нибудь».
 * Секреты здесь не разбираются — они в отдельных опциях (autoload = no).
 */
function v4c_assist_parse_settings($raw)
{
    $raw = is_array($raw) ? $raw : array();
    $key = isset($raw['site_key']) && is_string($raw['site_key']) ? trim($raw['site_key']) : '';
    $origin = isset($raw['widget_origin']) ? v4c_assist_clean_origin($raw['widget_origin']) : null;
    $position = isset($raw['position']) && in_array($raw['position'], V4C_ASSIST_POSITIONS, true)
        ? $raw['position'] : '';
    $goal = isset($raw['order_goal_key']) && is_string($raw['order_goal_key'])
        && preg_match(V4C_ASSIST_GOAL_KEY_RE, $raw['order_goal_key']) ? $raw['order_goal_key'] : 'purchase';
    return array(
        'site_key' => preg_match(V4C_ASSIST_SITE_KEY_RE, $key) ? $key : '',
        'widget_origin' => $origin !== null ? $origin : V4C_ASSIST_WIDGET_ORIGIN_DEFAULT,
        'position' => $position,
        'hide_on' => v4c_assist_parse_masks(isset($raw['hide_on']) ? (is_array($raw['hide_on']) ? implode("\n", $raw['hide_on']) : $raw['hide_on']) : ''),
        'webhook_endpoint' => isset($raw['webhook_endpoint']) ? (string) v4c_assist_clean_endpoint($raw['webhook_endpoint']) : '',
        'order_goal_key' => $goal,
        'identify' => !empty($raw['identify']),
        'order_goals' => !empty($raw['order_goals']),
        // Э6-бис: разметка data-assist-id для голосового управления — по
        // умолчанию включена (сохранённые до Э6-бис настройки ключа не имеют).
        // Форма настроек шлёт маркер `assist_ids_present`: снятая галочка
        // не приходит вовсе — без маркера её нельзя было бы выключить.
        'assist_ids' => array_key_exists('assist_ids_present', $raw)
            ? !empty($raw['assist_ids'])
            : (!array_key_exists('assist_ids', $raw) || !empty($raw['assist_ids'])),
    );
}

function v4c_assist_attr($v)
{
    return htmlspecialchars((string) $v, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
}

/**
 * Тег загрузчика. Без позиции и масок — РОВНО код вставки TMA:
 * `<script async src="<origin>/v1/loader.js" data-site="<pk>"></script>`.
 * Пустой ключ — пустая строка (нечего вставлять).
 */
function v4c_assist_loader_tag(array $s)
{
    if (empty($s['site_key']) || !preg_match(V4C_ASSIST_SITE_KEY_RE, $s['site_key'])) {
        return '';
    }
    $origin = v4c_assist_clean_origin(isset($s['widget_origin']) ? $s['widget_origin'] : '');
    if ($origin === null) {
        return '';
    }
    $tag = '<script async src="' . v4c_assist_attr($origin . V4C_ASSIST_LOADER_PATH)
        . '" data-site="' . v4c_assist_attr($s['site_key']) . '"';
    if (!empty($s['position']) && in_array($s['position'], V4C_ASSIST_POSITIONS, true)) {
        $tag .= ' data-position="' . v4c_assist_attr($s['position']) . '"';
    }
    if (!empty($s['hide_on']) && is_array($s['hide_on'])) {
        $masks = array_values(array_filter($s['hide_on'], function ($m) {
            return is_string($m) && strpos($m, ',') === false && preg_match(V4C_ASSIST_PATH_MASK_RE, $m);
        }));
        if ($masks) {
            $tag .= ' data-hide-on="' . v4c_assist_attr(implode(',', $masks)) . '"';
        }
    }
    return $tag . '></script>';
}

/** Путь подходит под маску со `*` (как маски кабинета; без регистра нет — пути чувствительны). */
function v4c_assist_mask_match($path, $mask)
{
    $re = '~^' . str_replace('\*', '.*', preg_quote($mask, '~')) . '$~';
    return (bool) preg_match($re, $path);
}

/** «Не показывать на этой странице» — путь без query. */
function v4c_assist_path_hidden($path, array $masks)
{
    $p = parse_url((string) $path, PHP_URL_PATH);
    $p = is_string($p) && $p !== '' ? $p : '/';
    foreach ($masks as $m) {
        if (is_string($m) && v4c_assist_mask_match($p, $m)) {
            return true;
        }
    }
    return false;
}

/** `t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<тело>")>` — как sites-backend и npm. */
function v4c_assist_sign($secret, $body, $t)
{
    return 't=' . (int) $t . ',v1=' . hash_hmac('sha256', ((int) $t) . '.' . $body, (string) $secret);
}

/** userHash = hex HMAC-SHA256(секрет идентичности, externalId). */
function v4c_assist_user_hash($secret, $externalId)
{
    return hash_hmac('sha256', (string) $externalId, (string) $secret);
}

/**
 * Событие цели из заказа. `$order` — массив (hooks.php собирает его из
 * WC_Order): number, status, total, currency, date (ISO 8601 UTC).
 * null — статус не наш или номер не проходит шаблон (сервер ответил бы
 * 422 — не шлём вовсе, номер заказа не должен быть e-mail/телефоном).
 */
function v4c_assist_order_event(array $order, $goalKey)
{
    $status = isset($order['status']) ? (string) $order['status'] : '';
    if (!in_array($status, V4C_ASSIST_ORDER_STATUSES, true)) {
        return null;
    }
    $id = isset($order['number']) ? (string) $order['number'] : '';
    // Шаблон уже не пускает «@» и «+»; телефон цифрами — отдельно (§5-тер.16 п.1).
    if (!preg_match(V4C_ASSIST_ORDER_ID_RE, $id) || preg_match('/^\d{9,15}$/', $id)) {
        return null;
    }
    if (!preg_match(V4C_ASSIST_GOAL_KEY_RE, (string) $goalKey)) {
        return null;
    }
    $event = array('goalKey' => (string) $goalKey, 'orderId' => $id);
    if ($status === 'completed' && isset($order['total']) && is_numeric($order['total'])) {
        $event['value'] = round((float) $order['total'], 2);
        $cur = isset($order['currency']) ? strtoupper((string) $order['currency']) : '';
        if (preg_match('/^[A-Z]{3}$/', $cur)) {
            $event['currency'] = $cur;
        }
    }
    $event['status'] = $status;
    $event['occurredAt'] = isset($order['date']) && is_string($order['date']) && $order['date'] !== ''
        ? $order['date'] : gmdate('Y-m-d\TH:i:s.000\Z');
    return $event;
}

/** Тело события — сериализуется ОДИН раз (подпись и отправка видят одни байты). */
function v4c_assist_event_body(array $event)
{
    return json_encode($event, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
}

/** Заголовки запроса вебхука. */
function v4c_assist_webhook_headers($secret, $body, $orderId, $t)
{
    return array(
        'Content-Type' => 'application/json',
        V4C_ASSIST_SIGNATURE_HEADER => v4c_assist_sign($secret, $body, $t),
        'Idempotency-Key' => (string) $orderId,
    );
}

/**
 * Встроенный скрипт identify залогиненного покупателя. Очередь — та же,
 * что у кода вставки (загрузчик забирает `.q`). JSON_HEX_* — имя
 * `</script><script>…` остаётся строкой, не тегом.
 */
function v4c_assist_identify_script(array $customer, $identitySecret)
{
    $data = array();
    foreach (array('name', 'email', 'externalId') as $k) {
        if (isset($customer[$k]) && is_string($customer[$k]) && $customer[$k] !== '') {
            $data[$k] = function_exists('mb_substr')
                ? mb_substr($customer[$k], 0, 200, 'UTF-8')
                : substr($customer[$k], 0, 200);
        }
    }
    if (!$data) {
        return '';
    }
    if (isset($data['externalId']) && is_string($identitySecret) && $identitySecret !== '') {
        $data['userHash'] = v4c_assist_user_hash($identitySecret, $data['externalId']);
    }
    $g = V4C_ASSIST_GLOBAL;
    $json = json_encode($data, JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT | JSON_UNESCAPED_UNICODE);
    return "window.$g=window.$g||function(){(window.$g.q=window.$g.q||[]).push(arguments)};"
        . "window.$g('identify'," . $json . ');';
}

/** Через сколько секунд повторить попытку N (0 — первая неудачная); null — сдаёмся. */
function v4c_assist_retry_delay($attempt)
{
    $attempt = (int) $attempt;
    $delays = V4C_ASSIST_RETRY_DELAYS;
    return $attempt >= 0 && array_key_exists($attempt, $delays) ? $delays[$attempt] : null;
}

/** Ответ сервера: 2xx — готово; 4xx (кроме 408/429) — повтор не поможет. */
function v4c_assist_should_retry($httpCode)
{
    $c = (int) $httpCode;
    if ($c >= 200 && $c < 300) {
        return false;
    }
    if ($c === 408 || $c === 429 || $c === 0 || $c >= 500) {
        return true;
    }
    return false;
}

// ── Э6-бис: разметка data-assist-id для голосового управления ─────────
//
// ТЗ помощника §5-бис.4: «Плагин WordPress/WooCommerce расставляет
// data-assist-id на стандартных элементах темы автоматически». Разметка —
// самый надёжный путь поиска цели голосовой командой; а `add-to-cart` —
// единственное, что снимает ложный стоп-лист со слов «Купити/Купить» на
// кнопке «В кошик» (§5-бис.5). Свою разметку темы плагин не перетирает.

/** Ключ разметки: латиница, цифры, «-» (как ASSIST_ID_RE сервера). */
function v4c_assist_clean_assist_id($v)
{
    $v = strtolower(preg_replace('/[^A-Za-z0-9-]+/', '-', (string) $v));
    $v = trim($v, '-');
    if ($v === '' || strlen($v) > 60) {
        return '';
    }
    return $v;
}

/** Кнопка «В кошик» в списке товаров (фильтр woocommerce_loop_add_to_cart_args). */
function v4c_assist_loop_add_to_cart_args($args)
{
    if (!is_array($args)) {
        return $args;
    }
    if (!isset($args['attributes']) || !is_array($args['attributes'])) {
        $args['attributes'] = array();
    }
    if (!isset($args['attributes']['data-assist-id'])) {
        $args['attributes']['data-assist-id'] = 'add-to-cart';
    }
    return $args;
}

/** Поле поиска формы темы (фильтр get_search_form): первое поле name="s". */
function v4c_assist_search_form_html($html)
{
    if (!is_string($html) || strpos($html, 'data-assist-id') !== false) {
        return $html;
    }
    return preg_replace('/<input\b(?=[^>]*\bname=(["\'])s\1)/i', '<input data-assist-id="search"', $html, 1);
}

/**
 * Ссылка меню (фильтр nav_menu_link_attributes): `nav-<последний сегмент
 * пути>` (`/dostavka/` → `nav-dostavka`); главная — `nav-home`; чужой
 * домен и якоря — без разметки.
 */
function v4c_assist_menu_link_attrs($atts, $siteHost)
{
    if (!is_array($atts) || isset($atts['data-assist-id']) || empty($atts['href'])) {
        return $atts;
    }
    $u = parse_url((string) $atts['href']);
    if (!is_array($u)) {
        return $atts;
    }
    if (!empty($u['host']) && strtolower($u['host']) !== strtolower((string) $siteHost)) {
        return $atts;
    }
    $path = isset($u['path']) ? trim($u['path'], '/') : '';
    $parts = $path === '' ? array() : explode('/', $path);
    $last = $parts ? rawurldecode(end($parts)) : 'home';
    $id = v4c_assist_clean_assist_id($last);
    if ($id !== '') {
        $atts['data-assist-id'] = 'nav-' . $id;
    }
    return $atts;
}

/**
 * Кнопки, у которых в WooCommerce нет фильтра атрибутов (кнопка «В кошик» на
 * странице товара), — маленький встроенный скрипт без HTML-приёмников:
 * только setAttribute на элементах стандартных классов темы.
 */
function v4c_assist_assist_ids_script()
{
    $map = array(
        '.single_add_to_cart_button' => 'add-to-cart',
        '.woocommerce-product-search-field' => 'search',
        '.woocommerce-widget-layered-nav-dropdown__submit' => 'apply-filter',
    );
    $js = '(function(){var m=' . json_encode($map, JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT | JSON_UNESCAPED_SLASHES) . ';'
        . 'Object.keys(m).forEach(function(s){document.querySelectorAll(s+\':not([data-assist-id])\').forEach(function(e){e.setAttribute(\'data-assist-id\',m[s])})})})();';
    return $js;
}
