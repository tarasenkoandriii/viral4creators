<?php
/**
 * Зеркало публичных имён sites-backend/src/brand.ts (сверяет
 * assist-integrations/scripts/brand.test.ts). Бренд не решён (В-1).
 */
if (!defined('ABSPATH') && !defined('V4C_ASSIST_TESTING')) {
    exit;
}
define('V4C_ASSIST_WIDGET_ORIGIN_DEFAULT', 'https://w.v4c.example.invalid');
define('V4C_ASSIST_LOADER_PATH', '/v1/loader.js');
define('V4C_ASSIST_GLOBAL', 'V4CAssist');
define('V4C_ASSIST_PLUGIN_SLUG', 'v4c-assist');
define('V4C_ASSIST_SIGNATURE_HEADER', 'X-Assist-Signature');
