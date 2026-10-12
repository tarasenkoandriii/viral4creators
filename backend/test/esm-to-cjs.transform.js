/**
 * Заход 13 (Р-З13-В5): jest 29 исполняет модули как CommonJS и не умеет
 * `require()` ESM-пакета, а `sanitize-html` ≥ 2.17.7 (исправленные
 * версии) тянет ESM-only `htmlparser2@12` и его семейство (`domhandler`,
 * `domutils`, `dom-serializer`, `entities`, `domelementtype`). В проде
 * этого вопроса нет — Node 24 делает `require(esm)` сам.
 *
 * Здесь — только перевод синтаксиса `import`/`export` в CommonJS
 * (`ts.transpileModule`, без проверки типов) для этих пакетов; какие
 * именно — `transformIgnorePatterns` в backend/package.json. Код самих
 * пакетов не меняется, поэтому тесты санитайзера проверяют ту же логику,
 * что работает в проде.
 */
const crypto = require('crypto');
const fs = require('fs');
const ts = require('typescript');

const SELF = fs.readFileSync(__filename, 'utf8');

module.exports = {
  process(sourceText, sourcePath) {
    const out = ts.transpileModule(sourceText, {
      fileName: sourcePath,
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
        inlineSourceMap: true,
      },
    });
    return { code: out.outputText };
  },
  getCacheKey(sourceText, sourcePath) {
    return crypto
      .createHash('sha1')
      .update(SELF)
      .update(ts.version)
      .update(sourcePath)
      .update(sourceText)
      .digest('hex');
  },
};
