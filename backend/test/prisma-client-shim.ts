/**
 * Подмена `@prisma/client` для тестов — ТОЛЬКО когда настоящего
 * клиента нет.
 *
 * ## Зачем
 *
 * Клиент Prisma генерируется командой `prisma generate`, которой нужна
 * сеть до `binaries.prisma.sh`. В CI она есть (doc/CI.md), в песочнице
 * разработки — нет. Из-за этого 46 наборов из 225 падали НА ЗАГРУЗКЕ
 * модуля, не дойдя ни до одной проверки: их цепочка импортов задевает
 * `SessionService`, а та рантаймом импортирует `Prisma`/`WorkflowKind`
 * из `@prisma/client`.
 *
 * Пятая часть тестов, которую нельзя прогнать перед пушем, — это не
 * «мелкое неудобство стенда»: регрессия в них обнаруживается только в
 * CI, то есть после того, как ошибка уже написана и отправлена.
 *
 * ## Почему это безопасно
 *
 * Настоящий клиент, если он есть, реэкспортируется как есть — в CI
 * поведение не меняется ни на байт. Заглушка включается ровно тогда,
 * когда без неё набор просто не запустился бы.
 *
 * Заглушка отдаёт `Prisma.DbNull`/`JsonNull` символами (их сравнивают
 * по ссылке, и этого достаточно), а любой другой именованный экспорт —
 * объектом, у которого значение свойства равно его имени. Это ровно
 * семантика перечислений Prisma: `WorkflowKind.SINGLE === 'SINGLE'`.
 * Перечисления добавляются в схему постоянно, и список здесь устарел
 * бы к следующей миграции.
 */

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-var-requires */

/**
 * Откуда брать настоящего клиента. Обычно это `@prisma/client/default`:
 * путь с `/default` НЕ подменяется маппингом (он матчит только точное
 * `@prisma/client`), поэтому мы честно пробуем настоящий модуль, а не
 * самих себя.
 *
 * Переменная окружения нужна ровно одному тесту — тому, что проверяет
 * главное обещание этого файла: «настоящий клиент есть — он и
 * реэкспортируется». Подменить `@prisma/client/default` виртуальным
 * моком jest для ЧУЖОГО файла (мок ставит спек, а требует модуль этот
 * файл) получалось лишь через раз: в полном прогоне тест падал
 * примерно в половине случаев. Настоящий файл на диске убирает
 * недетерминированность целиком. В обычном прогоне переменная не
 * задана, и поведение ровно прежнее.
 */
function realClientModule(): string {
  return process.env.PRISMA_CLIENT_SHIM_MODULE || '@prisma/client/default';
}

function loadReal(): any | null {
  try {
    return require(realClientModule());
  } catch {
    return null;
  }
}

function buildStub(): any {
  const enumLike = new Proxy(
    {},
    { get: (_target, key) => (typeof key === 'string' ? key : undefined) },
  );
  const base: Record<string, unknown> = {
    __esModule: true,
    Prisma: {
      DbNull: Symbol.for('Prisma.DbNull'),
      JsonNull: Symbol.for('Prisma.JsonNull'),
      AnyNull: Symbol.for('Prisma.AnyNull'),
    },
    PrismaClient: class PrismaClientStub {},
  };
  return new Proxy(base, {
    get: (target, key) => {
      if (key in target) return (target as any)[key];
      if (key === 'default') return undefined;
      // Любой неизвестный именованный экспорт — перечисление.
      return enumLike;
    },
  });
}

module.exports = loadReal() ?? buildStub();
