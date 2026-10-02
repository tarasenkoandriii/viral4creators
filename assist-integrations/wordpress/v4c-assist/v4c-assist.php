<?php
/**
 * Plugin Name: V4C Assist (имя — после решения бренда В-1)
 * Description: ИИ-помощник на сайте: код вставки виджета, «не показывать на страницах», WooCommerce — identify покупателя с userHash и цели заказов (вебхук s2s).
 * Version: 0.1.0
 * Requires PHP: 7.4
 * Requires at least: 6.0
 * License: Proprietary
 * Text Domain: v4c-assist
 *
 * Э3, агент T (ТЗ §3-бис.2, §5-тер.1 детектор crm, В-44). Без внешних
 * зависимостей и без composer. Логика — чистые функции в includes/
 * (тестируются tests/run.php без WordPress); здесь — только хуки WP:
 *  - wp_footer: тег загрузчика (pk, origin, позиция, data-hide-on) — экранирование esc_attr/esc_url;
 *  - WooCommerce залогиненный покупатель: V4CAssist('identify', {name, email, externalId, userHash}) —
 *    userHash = HMAC-SHA256(секрет идентичности, externalId), секрет — в опции (autoload = no);
 *  - woocommerce_order_status_{completed,refunded,cancelled}: s2s-событие цели
 *    POST https://<api>/assist/v1/sites/<siteId>/goal-events с подписью и Idempotency-Key = номер заказа
 *    (wp_remote_post, неблокирующий, повтор через wp-cron при сбое);
 *  - страница настроек (manage_options, nonce).
 */
if (!defined('ABSPATH')) {
    exit;
}
require_once __DIR__ . '/includes/brand.php';
require_once __DIR__ . '/includes/functions.php';
require_once __DIR__ . '/includes/hooks.php';
