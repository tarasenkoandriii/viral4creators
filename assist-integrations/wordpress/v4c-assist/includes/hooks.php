<?php
/**
 * Хуки WordPress/WooCommerce (Э3, T). Вся логика — в functions.php
 * (тесты без WordPress); здесь только чтение опций, вывод и расписание.
 *
 * Опции: `v4c_assist_settings` (без секретов), секреты — отдельно,
 * `autoload = no`: `v4c_assist_webhook_secret`, `v4c_assist_identity_secret`.
 * Страница настроек — manage_options + nonce (settings API + свой nonce для
 * секретов: пустое поле секрета — «оставить прежний»).
 */
if (!defined('ABSPATH')) {
    exit;
}

const V4C_ASSIST_OPTION = 'v4c_assist_settings';
const V4C_ASSIST_OPTION_WEBHOOK_SECRET = 'v4c_assist_webhook_secret';
const V4C_ASSIST_OPTION_IDENTITY_SECRET = 'v4c_assist_identity_secret';
const V4C_ASSIST_CRON_HOOK = 'v4c_assist_send_goal';

function v4c_assist_settings()
{
    return v4c_assist_parse_settings(get_option(V4C_ASSIST_OPTION, array()));
}

// ── Тег загрузчика и identify ─────────────────────────────────────────

add_action('wp_footer', 'v4c_assist_render_footer', 20);

function v4c_assist_render_footer()
{
    if (is_admin()) {
        return;
    }
    $s = v4c_assist_settings();
    $path = isset($_SERVER['REQUEST_URI']) ? wp_unslash($_SERVER['REQUEST_URI']) : '/';
    if (v4c_assist_path_hidden($path, $s['hide_on'])) {
        return;
    }
    $tag = v4c_assist_loader_tag($s);
    if ($tag === '') {
        return;
    }
    if ($s['identify'] && is_user_logged_in()) {
        $user = wp_get_current_user();
        $script = v4c_assist_identify_script(
            array(
                'name' => (string) $user->display_name,
                'email' => (string) $user->user_email,
                'externalId' => 'wp-' . (int) $user->ID,
            ),
            (string) get_option(V4C_ASSIST_OPTION_IDENTITY_SECRET, '')
        );
        if ($script !== '') {
            if (function_exists('wp_print_inline_script_tag')) {
                wp_print_inline_script_tag($script);
            } else {
                echo '<script>' . $script . '</script>'; // уже экранировано JSON_HEX_*
            }
        }
    }
    // Тег собран из проверенных значений и экранирован в v4c_assist_loader_tag.
    echo $tag . "\n"; // phpcs:ignore WordPress.Security.EscapeOutput
}

// ── Э6-бис: разметка data-assist-id для голосового управления ─────────

add_filter('woocommerce_loop_add_to_cart_args', 'v4c_assist_filter_loop_add_to_cart', 20, 1);
add_filter('woocommerce_cart_item_remove_link', 'v4c_assist_filter_cart_remove_link', 20, 1);
add_filter('get_search_form', 'v4c_assist_filter_search_form', 20, 1);
add_filter('nav_menu_link_attributes', 'v4c_assist_filter_menu_link', 20, 1);
add_action('wp_footer', 'v4c_assist_render_assist_ids', 30);

/** Э6-тер (и): путь корзины WooCommerce этого сайта (страница отмены «В кошик»). */
function v4c_assist_site_cart_path()
{
    if (!function_exists('wc_get_cart_url')) {
        return null;
    }
    return v4c_assist_cart_path(wc_get_cart_url(), (string) parse_url(home_url('/'), PHP_URL_HOST));
}

function v4c_assist_filter_loop_add_to_cart($args)
{
    return v4c_assist_settings()['assist_ids'] ? v4c_assist_loop_add_to_cart_args($args, v4c_assist_site_cart_path()) : $args;
}

function v4c_assist_filter_cart_remove_link($html)
{
    return v4c_assist_settings()['assist_ids'] ? v4c_assist_cart_item_remove_link($html) : $html;
}

function v4c_assist_filter_search_form($html)
{
    return v4c_assist_settings()['assist_ids'] ? v4c_assist_search_form_html($html) : $html;
}

function v4c_assist_filter_menu_link($atts)
{
    if (!v4c_assist_settings()['assist_ids']) {
        return $atts;
    }
    $host = (string) parse_url(home_url('/'), PHP_URL_HOST);
    return v4c_assist_menu_link_attrs($atts, $host, v4c_assist_site_cart_path());
}

function v4c_assist_render_assist_ids()
{
    if (is_admin() || !v4c_assist_settings()['assist_ids'] || !function_exists('is_woocommerce')) {
        return;
    }
    $script = v4c_assist_assist_ids_script(v4c_assist_site_cart_path());
    if (function_exists('wp_print_inline_script_tag')) {
        wp_print_inline_script_tag($script);
    } else {
        echo '<script>' . $script . '</script>'; // константы, JSON_HEX_*
    }
}

// ── Цели заказов WooCommerce (s2s, повтор через wp-cron) ───────────────

foreach (V4C_ASSIST_ORDER_STATUSES as $v4c_status) {
    add_action('woocommerce_order_status_' . $v4c_status, 'v4c_assist_on_order_status', 10, 1);
}
add_action(V4C_ASSIST_CRON_HOOK, 'v4c_assist_send_goal', 10, 3);

/** Смена статуса — только постановка в wp-cron: страница магазина не ждёт сеть. */
function v4c_assist_on_order_status($orderId)
{
    $s = v4c_assist_settings();
    if (!$s['order_goals'] || $s['webhook_endpoint'] === '') {
        return;
    }
    $order = function_exists('wc_get_order') ? wc_get_order($orderId) : null;
    if (!$order) {
        return;
    }
    wp_schedule_single_event(time(), V4C_ASSIST_CRON_HOOK, array((int) $orderId, (string) $order->get_status(), 0));
}

function v4c_assist_send_goal($orderId, $status, $attempt)
{
    $s = v4c_assist_settings();
    $secret = (string) get_option(V4C_ASSIST_OPTION_WEBHOOK_SECRET, '');
    if ($s['webhook_endpoint'] === '' || $secret === '' || !function_exists('wc_get_order')) {
        return;
    }
    $order = wc_get_order($orderId);
    if (!$order) {
        return;
    }
    $created = $order->get_date_completed() ?: $order->get_date_created();
    $event = v4c_assist_order_event(
        array(
            'number' => (string) $order->get_order_number(),
            'status' => (string) $status,
            'total' => $order->get_total(),
            'currency' => $order->get_currency(),
            'date' => $created ? gmdate('Y-m-d\TH:i:s.000\Z', $created->getTimestamp()) : '',
        ),
        $s['order_goal_key']
    );
    if ($event === null) {
        return;
    }
    $body = v4c_assist_event_body($event);
    $response = wp_remote_post($s['webhook_endpoint'], array(
        'timeout' => 10,
        'redirection' => 0,
        'headers' => v4c_assist_webhook_headers($secret, $body, $event['orderId'], time()),
        'body' => $body,
    ));
    $code = is_wp_error($response) ? 0 : (int) wp_remote_retrieve_response_code($response);
    if (!v4c_assist_should_retry($code)) {
        return;
    }
    $delay = v4c_assist_retry_delay($attempt);
    if ($delay !== null) {
        // Повтор с тем же Idempotency-Key: сервер не задвоит событие.
        wp_schedule_single_event(time() + $delay, V4C_ASSIST_CRON_HOOK, array((int) $orderId, (string) $status, (int) $attempt + 1));
    }
}

// ── Страница настроек ─────────────────────────────────────────────────

add_action('admin_menu', 'v4c_assist_admin_menu');
add_action('admin_init', 'v4c_assist_admin_init');

function v4c_assist_admin_menu()
{
    add_options_page(__('Виджет помощника', 'v4c-assist'), __('Помощник', 'v4c-assist'), 'manage_options', V4C_ASSIST_PLUGIN_SLUG, 'v4c_assist_settings_page');
}

function v4c_assist_admin_init()
{
    register_setting(V4C_ASSIST_PLUGIN_SLUG, V4C_ASSIST_OPTION, array(
        'type' => 'array',
        'sanitize_callback' => 'v4c_assist_sanitize_settings',
        'default' => array(),
    ));
}

/** Сохранение формы: настройки — разбором; секреты — отдельными опциями без autoload. */
function v4c_assist_sanitize_settings($raw)
{
    if (!current_user_can('manage_options')) {
        return get_option(V4C_ASSIST_OPTION, array());
    }
    $raw = is_array($raw) ? wp_unslash($raw) : array();
    foreach (array('webhook_secret' => V4C_ASSIST_OPTION_WEBHOOK_SECRET, 'identity_secret' => V4C_ASSIST_OPTION_IDENTITY_SECRET) as $field => $option) {
        $v = isset($raw[$field]) && is_string($raw[$field]) ? trim($raw[$field]) : '';
        if ($v !== '' && strlen($v) <= 200 && preg_match('/^[A-Za-z0-9_.-]+$/', $v)) {
            update_option($option, $v, false);
        }
        unset($raw[$field]);
    }
    return v4c_assist_parse_settings($raw);
}

function v4c_assist_settings_page()
{
    if (!current_user_can('manage_options')) {
        return;
    }
    $s = v4c_assist_settings();
    $has = function ($option) {
        return get_option($option, '') !== '';
    };
    $name = V4C_ASSIST_OPTION;
    echo '<div class="wrap"><h1>' . esc_html__('Виджет помощника', 'v4c-assist') . '</h1>';
    echo '<form method="post" action="options.php">';
    settings_fields(V4C_ASSIST_PLUGIN_SLUG); // nonce + option_page
    echo '<table class="form-table" role="presentation">';
    $row = function ($label, $html) {
        echo '<tr><th scope="row">' . esc_html($label) . '</th><td>' . $html . '</td></tr>';
    };
    $row(__('Публичный ключ сайта (pk_…)', 'v4c-assist'), '<input class="regular-text" name="' . esc_attr($name) . '[site_key]" value="' . esc_attr($s['site_key']) . '">');
    $row(__('Адрес виджета (origin)', 'v4c-assist'), '<input class="regular-text" name="' . esc_attr($name) . '[widget_origin]" value="' . esc_attr($s['widget_origin']) . '">');
    $pos = '<select name="' . esc_attr($name) . '[position]"><option value="">' . esc_html__('Как в кабинете', 'v4c-assist') . '</option>';
    foreach (V4C_ASSIST_POSITIONS as $p) {
        $pos .= '<option value="' . esc_attr($p) . '"' . selected($s['position'], $p, false) . '>' . esc_html($p) . '</option>';
    }
    $row(__('Положение кнопки', 'v4c-assist'), $pos . '</select>');
    $row(__('Не показывать на страницах (маска в строке, например /checkout*)', 'v4c-assist'), '<textarea class="large-text" rows="3" name="' . esc_attr($name) . '[hide_on]">' . esc_textarea(implode("\n", $s['hide_on'])) . '</textarea>');
    $row(__('Разметка для голосового управления', 'v4c-assist'), '<label><input type="checkbox" name="' . esc_attr($name) . '[assist_ids]" value="1"' . checked($s['assist_ids'], true, false) . '> ' . esc_html__('data-assist-id на кнопках «В корзину», «Удалить» в корзине, поиске и меню (помощник находит их надёжнее и может убрать добавленное из корзины)', 'v4c-assist') . '</label><input type="hidden" name="' . esc_attr($name) . '[assist_ids_present]" value="1">');
    $row(__('Узнавать вошедших покупателей', 'v4c-assist'), '<label><input type="checkbox" name="' . esc_attr($name) . '[identify]" value="1"' . checked($s['identify'], true, false) . '> ' . esc_html__('имя, e-mail и проверенный id покупателя (userHash)', 'v4c-assist') . '</label>');
    $row(__('Секрет идентичности', 'v4c-assist'), '<input type="password" autocomplete="new-password" class="regular-text" name="' . esc_attr($name) . '[identity_secret]" placeholder="' . esc_attr($has(V4C_ASSIST_OPTION_IDENTITY_SECRET) ? __('сохранён — оставьте пустым, чтобы не менять', 'v4c-assist') : '') . '">');
    $row(__('Заказы WooCommerce — целями', 'v4c-assist'), '<label><input type="checkbox" name="' . esc_attr($name) . '[order_goals]" value="1"' . checked($s['order_goals'], true, false) . '> completed / refunded / cancelled</label>');
    $row(__('Ключ цели', 'v4c-assist'), '<input name="' . esc_attr($name) . '[order_goal_key]" value="' . esc_attr($s['order_goal_key']) . '">');
    $row(__('Адрес вебхука целей', 'v4c-assist'), '<input class="large-text" name="' . esc_attr($name) . '[webhook_endpoint]" value="' . esc_attr($s['webhook_endpoint']) . '">');
    $row(__('Секрет вебхука целей', 'v4c-assist'), '<input type="password" autocomplete="new-password" class="regular-text" name="' . esc_attr($name) . '[webhook_secret]" placeholder="' . esc_attr($has(V4C_ASSIST_OPTION_WEBHOOK_SECRET) ? __('сохранён — оставьте пустым, чтобы не менять', 'v4c-assist') : '') . '">');
    echo '</table>';
    submit_button();
    echo '</form></div>';
}
