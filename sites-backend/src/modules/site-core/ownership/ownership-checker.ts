/**
 * Сама проверка владения хостом — тремя способами QA-ТЗ §2.4 (ТЗ
 * помощника §3.3). Ничего не пишет в базу: только «нашли наш токен или
 * нет и почему». Решение о статусе — у сервиса и крона.
 *
 * Токен — ТОЛЬКО токен кабинета, которому принадлежит запись хоста.
 * Подтверждение — на пару (кабинет, хост): чужой токен на том же хосте
 * нашему кабинету ничего не даёт (QA §5.1).
 *
 * `definitive` отличает «токена точно нет» (оба резолвера ответили без
 * него, файл 404, страница без меты) от «не смогли проверить» (таймаут,
 * 5xx, резолверы разошлись). Крон отзывает подтверждение только по
 * первому: упавший на минуту DNS-провайдер не должен снимать виджет.
 */

import {
  BodyTooLargeError,
  UnsafeExternalUrlError,
  readBodyWithLimit,
} from '../../../shared/external-url-guard';
import {
  VERIFY_FILE_PATH,
  VERIFY_META_NAME,
  verifyTxtName,
  verifyTxtValue,
} from '../../../brand';
import { HostAddress, hostOrigin } from '../hosts/host-normalize';
import { VERIFY_BODY_LIMIT_BYTES, VerifyMethod } from '../site-core.constants';
import { DohClient } from './doh.client';
import {
  DEFAULT_SAFE_HTTP_DEPS,
  RedirectToOtherHostError,
  SafeHttpDeps,
  TooManyRedirectsError,
  fetchSameOrigin,
  readPrefix,
} from './safe-http';

export type CheckCode =
  | 'VERIFIED'
  | 'DNS_NOT_FOUND'
  | 'DNS_RESOLVERS_DISAGREE'
  | 'DNS_UNAVAILABLE'
  | 'FILE_NOT_FOUND'
  | 'TOKEN_MISMATCH'
  | 'META_NOT_FOUND'
  | 'HTTP_ERROR'
  | 'REDIRECT_OTHER_HOST'
  | 'TOO_MANY_REDIRECTS'
  | 'BODY_TOO_LARGE'
  | 'UNSAFE_URL'
  | 'NETWORK_ERROR';

export interface CheckResult {
  ok: boolean;
  method: VerifyMethod;
  code: CheckCode;
  /** Человеку, по-русски. */
  message: string;
  /** true — токена точно нет (основание для `revoked` в кроне). */
  definitive: boolean;
}

const MESSAGES: Record<CheckCode, string> = {
  VERIFIED: 'Владение подтверждено',
  DNS_NOT_FOUND:
    'Запись пока не видна. DNS может обновляться до часа — проверьте имя и значение TXT-записи и повторите',
  DNS_RESOLVERS_DISAGREE:
    'Запись видна не у всех DNS-серверов — подождите, пока она разойдётся, и повторите',
  DNS_UNAVAILABLE:
    'Не удалось опросить DNS — повторите проверку через несколько минут',
  FILE_NOT_FOUND:
    'Файл подтверждения не найден по адресу /.well-known/… — проверьте, что он лежит в корне сайта',
  TOKEN_MISMATCH: 'Файл найден, но в первой строке не токен вашего кабинета',
  META_NOT_FOUND: 'На главной странице нет мета-тега с токеном вашего кабинета',
  HTTP_ERROR: 'Сайт ответил ошибкой — повторите проверку позже',
  REDIRECT_OTHER_HOST:
    'Сайт перенаправляет на другой адрес. Проверка идёт без перехода на другой хост — подтвердите этот хост через DNS или уберите перенаправление',
  TOO_MANY_REDIRECTS: 'Слишком много перенаправлений на сайте',
  BODY_TOO_LARGE:
    'Файл подтверждения слишком большой — в нём должен быть только токен',
  UNSAFE_URL:
    'Этот адрес нельзя открыть с нашего сервера — проверьте, что сайт доступен из интернета',
  NETWORK_ERROR:
    'Сайт не ответил вовремя — повторите проверку через несколько минут',
};

function result(
  method: VerifyMethod,
  code: CheckCode,
  definitive = false,
): CheckResult {
  return {
    ok: code === 'VERIFIED',
    method,
    code,
    message: MESSAGES[code],
    definitive: code === 'VERIFIED' ? false : definitive,
  };
}

/**
 * DNS: TXT `_v4c-verify.<хост>` = `v4c-verify=<токен>` у ВСЕХ резолверов.
 * Только точное имя хоста: TXT на apex подтверждает только apex
 * (поддомены не наследуются, Р-18).
 */
export async function checkDns(
  doh: DohClient,
  host: HostAddress,
  token: string,
): Promise<CheckResult> {
  const expected = verifyTxtValue(token);
  const answers = await doh.resolveTxtAll(verifyTxtName(host.host));
  if (answers.some((a) => !a.ok)) {
    // Хотя бы один резолвер не ответил: совпадения «двух независимых» нет.
    return result('dns', 'DNS_UNAVAILABLE');
  }
  const found = answers.map(
    (a) => a.ok && a.values.some((v) => v === expected),
  );
  if (found.every(Boolean)) return result('dns', 'VERIFIED');
  if (found.some(Boolean)) return result('dns', 'DNS_RESOLVERS_DISAGREE');
  return result('dns', 'DNS_NOT_FOUND', true);
}

/** Ошибки исходящего запроса → итог проверки. */
function fromFetchError(method: VerifyMethod, error: unknown): CheckResult {
  if (error instanceof RedirectToOtherHostError) {
    return result(method, 'REDIRECT_OTHER_HOST', true);
  }
  if (error instanceof TooManyRedirectsError) {
    return result(method, 'TOO_MANY_REDIRECTS', true);
  }
  if (error instanceof UnsafeExternalUrlError) {
    return result(method, 'UNSAFE_URL');
  }
  if (error instanceof BodyTooLargeError) {
    return result(method, 'BODY_TOO_LARGE', true);
  }
  return result(method, 'NETWORK_ERROR');
}

/** 404/410 — файла/страницы нет; прочие не-2xx — «не смогли проверить». */
function fromStatus(method: VerifyMethod, status: number): CheckResult | null {
  if (status >= 200 && status < 300) return null;
  if (status === 404 || status === 410) {
    return result(
      method,
      method === 'file' ? 'FILE_NOT_FOUND' : 'HTTP_ERROR',
      true,
    );
  }
  return result(method, 'HTTP_ERROR');
}

/** Первая строка файла (без BOM и пробелов по краям). */
export function firstLine(text: string): string {
  return text.replace(/^﻿/, '').split(/\r?\n/, 1)[0].trim();
}

/**
 * Файл `https://<хост>/.well-known/v4c-verify.txt`, токен в первой строке.
 * Тело — `readBodyWithLimit` (≤ 64 КБ): файл-маркер больше — не маркер.
 */
export async function checkFile(
  host: HostAddress,
  token: string,
  deps: SafeHttpDeps = DEFAULT_SAFE_HTTP_DEPS,
): Promise<CheckResult> {
  try {
    const { res } = await fetchSameOrigin(
      `${hostOrigin(host)}${VERIFY_FILE_PATH}`,
      deps,
      { headers: { accept: 'text/plain' } },
    );
    const bad = fromStatus('file', res.status);
    if (bad) {
      await res.body?.cancel().catch(() => undefined);
      return bad;
    }
    const body = await readBodyWithLimit(res, VERIFY_BODY_LIMIT_BYTES);
    return firstLine(body.toString('utf8')) === token
      ? result('file', 'VERIFIED')
      : result('file', 'TOKEN_MISMATCH', true);
  } catch (error) {
    return fromFetchError('file', error);
  }
}

const META_TAG_RE = /<meta\b[^>]*>/gi;
const ATTR_RE = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;

/** Все `content` мета-тегов с `name="<имя>"` (регистр имени не важен). */
export function metaContents(html: string, name: string): string[] {
  const out: string[] = [];
  const want = name.toLowerCase();
  for (const tag of html.match(META_TAG_RE) ?? []) {
    const attrs: Record<string, string> = {};
    for (const m of tag.matchAll(ATTR_RE)) {
      attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
    }
    if ((attrs.name ?? '').trim().toLowerCase() === want) {
      out.push((attrs.content ?? '').trim());
    }
  }
  return out;
}

/** Мета `<meta name="v4c-verify" content="<токен>">` на `/`. */
export async function checkMeta(
  host: HostAddress,
  token: string,
  deps: SafeHttpDeps = DEFAULT_SAFE_HTTP_DEPS,
): Promise<CheckResult> {
  try {
    const { res } = await fetchSameOrigin(`${hostOrigin(host)}/`, deps, {
      headers: { accept: 'text/html' },
    });
    const bad = fromStatus('meta', res.status);
    if (bad) {
      await res.body?.cancel().catch(() => undefined);
      return bad;
    }
    const html = (await readPrefix(res, VERIFY_BODY_LIMIT_BYTES)).toString(
      'utf8',
    );
    return metaContents(html, VERIFY_META_NAME).includes(token)
      ? result('meta', 'VERIFIED')
      : result('meta', 'META_NOT_FOUND', true);
  } catch (error) {
    return fromFetchError('meta', error);
  }
}

/** Проверка выбранным способом. */
export class OwnershipChecker {
  constructor(
    private readonly doh: DohClient = new DohClient(),
    private readonly http: SafeHttpDeps = DEFAULT_SAFE_HTTP_DEPS,
  ) {}

  check(
    method: VerifyMethod,
    host: HostAddress,
    token: string,
  ): Promise<CheckResult> {
    switch (method) {
      case 'dns':
        return checkDns(this.doh, host, token);
      case 'file':
        return checkFile(host, token, this.http);
      case 'meta':
        return checkMeta(host, token, this.http);
    }
  }

  /** Все TXT-значения у первого резолвера — для «чужих записей» при отзыве. */
  async txtValues(host: HostAddress): Promise<string[]> {
    const answers = await this.doh.resolveTxtAll(verifyTxtName(host.host));
    const first = answers.find((a) => a.ok);
    return first && first.ok ? first.values : [];
  }

  /** Первая строка файла-маркера, если он есть (для «чужих файлов»). */
  async fileFirstLine(host: HostAddress): Promise<string | null> {
    try {
      const { res } = await fetchSameOrigin(
        `${hostOrigin(host)}${VERIFY_FILE_PATH}`,
        this.http,
      );
      if (res.status < 200 || res.status >= 300) {
        await res.body?.cancel().catch(() => undefined);
        return null;
      }
      const body = await readBodyWithLimit(res, VERIFY_BODY_LIMIT_BYTES);
      return firstLine(body.toString('utf8')) || null;
    } catch {
      return null;
    }
  }

  get httpDeps(): SafeHttpDeps {
    return this.http;
  }
}
