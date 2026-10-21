/**
 * Токенизатор shell-подобной строки команды БЕЗ исполнения (ТЗ §6).
 *
 * Семантика — подмножество POSIX sh для одного простого вызова:
 *  - пробел/таб разделяют слова; соседние куски слова склеиваются
 *    (`a"b"'c'` → `abc`);
 *  - '…' — всё буквально, до следующей `'`;
 *  - "…" — буквально, кроме `\` перед `\`, `"`, `$`, `` ` `` и переводом
 *    строки (как в sh); `\` перед другим символом остаётся `\`;
 *  - без кавычек `\x` → `x`, `\<перевод строки>` — продолжение строки.
 *
 * Никаких подстановок: ни `$…`, ни `` `…` ``, ни glob, ни `~`, ни
 * комментариев. Всё, что sh истолковал бы как управление или подстановку
 * (`; & | < > ( )`, перевод строки вне кавычек, `$` и `` ` `` вне
 * одинарных кавычек, `#`/`~` в начале слова), — неоднозначно, потому что
 * исполнитель-shell понял бы строку иначе, чем мы. Такие строки
 * отвергаются (`UNSUPPORTED_COMMAND`), а не «чинятся».
 *
 * Glob-символы `* ? [` без кавычек остаются буквальными (как shlex):
 * корпус платформы содержит `-map 0:a?` без кавычек, а мы никогда не
 * раскрываем шаблоны.
 */

export type TokenizeResult =
  { ok: true; tokens: string[] } | { ok: false; message: string };

const FORBIDDEN_UNQUOTED = new Set([';', '&', '|', '<', '>', '(', ')']);

export function tokenize(input: string): TokenizeResult {
  if (input.includes('\u0000')) {
    return { ok: false, message: 'NUL byte in command' };
  }
  // Управляющие символы, кроме таба/перевода строки/CR, — не текст команды.
  if (/[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(input)) {
    return { ok: false, message: 'control character in command' };
  }
  const tokens: string[] = [];
  let cur = '';
  let inWord = false;
  // bash раскрыл бы `{a,b}` без кавычек (brace expansion).
  let braceUnquoted = false;
  let commaUnquoted = false;
  let i = 0;
  const n = input.length;
  const fail = (message: string): TokenizeResult => ({ ok: false, message });

  while (i < n) {
    const c = input[i];
    if (c === ' ' || c === '\t' || c === '\r') {
      if (inWord) {
        if (braceUnquoted && commaUnquoted) {
          return fail('unquoted {…,…} (brace expansion)');
        }
        tokens.push(cur);
        cur = '';
        inWord = false;
        braceUnquoted = false;
        commaUnquoted = false;
      }
      i++;
      continue;
    }
    if (c === '\n') {
      // Перевод строки вне кавычек в sh — разделитель команд.
      return fail('unquoted newline (command separator)');
    }
    if (c === "'") {
      const end = input.indexOf("'", i + 1);
      if (end < 0) return fail('unterminated single quote');
      cur += input.slice(i + 1, end);
      inWord = true;
      i = end + 1;
      continue;
    }
    if (c === '"') {
      i++;
      let closed = false;
      while (i < n) {
        const d = input[i];
        if (d === '"') {
          closed = true;
          i++;
          break;
        }
        if (d === '\\') {
          const e = input[i + 1];
          if (e === undefined) return fail('dangling backslash');
          if (e === '\n') {
            i += 2;
            continue;
          }
          if (e === '\\' || e === '"' || e === '$' || e === '`') {
            cur += e;
            i += 2;
            continue;
          }
          cur += '\\';
          i++;
          continue;
        }
        if (d === '$')
          return fail('"$" inside double quotes (shell expansion)');
        if (d === '`') return fail('backquote (command substitution)');
        cur += d;
        i++;
      }
      if (!closed) return fail('unterminated double quote');
      inWord = true;
      continue;
    }
    if (c === '\\') {
      const e = input[i + 1];
      if (e === undefined) return fail('dangling backslash');
      if (e === '\n') {
        i += 2;
        continue;
      }
      cur += e;
      inWord = true;
      i += 2;
      continue;
    }
    if (c === '$') return fail('"$" (shell expansion)');
    if (c === '`') return fail('backquote (command substitution)');
    if (FORBIDDEN_UNQUOTED.has(c)) {
      return fail(`unquoted shell operator "${c}"`);
    }
    if (!inWord && (c === '#' || c === '~')) {
      return fail(`"${c}" at word start (comment/tilde expansion)`);
    }
    if (c === '{') braceUnquoted = true;
    if (c === ',') commaUnquoted = true;
    cur += c;
    inWord = true;
    i++;
  }
  if (inWord) {
    if (braceUnquoted && commaUnquoted) {
      return fail('unquoted {…,…} (brace expansion)');
    }
    tokens.push(cur);
  }
  return { ok: true, tokens };
}
