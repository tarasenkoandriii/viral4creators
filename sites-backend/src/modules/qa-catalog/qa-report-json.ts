import { json, type Request, type Response, type NextFunction } from 'express';
const REPORT_PATH =
  /^\/qa\/sites\/[A-Za-z0-9_-]{1,64}\/runs\/[A-Za-z0-9_-]{1,64}\/reports$/;
/** The report limit applies only here; Nest's default parser remains on other routes. */
export function qaReportImportJson() {
  const parse = json({ limit: '520kb' });
  return function qaReportImportMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ) {
    if (
      req.method !== 'POST' ||
      !(REPORT_PATH.test(req.path) || req.path === '/qa/ci/reports')
    )
      return next();
    parse(req, res, (error?: unknown) => {
      if (!error) return next();
      const tooLarge = (error as { type?: string }).type === 'entity.too.large';
      res.status(tooLarge ? 413 : 400).json({
        success: false,
        error: {
          code: tooLarge ? 'QA_REPORT_TOO_LARGE' : 'QA_REPORT_INVALID',
          message: 'Не удалось прочитать JSON-отчёт QA.',
        },
        meta: { path: req.path, timestamp: new Date().toISOString() },
      });
    });
  };
}
