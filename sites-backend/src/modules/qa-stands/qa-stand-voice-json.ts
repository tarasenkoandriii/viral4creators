import { json, type Request, type Response, type NextFunction } from 'express';
export function qaStandVoiceJson() {
  const parser = json({ limit: '1500kb' });
  return function qaStandVoiceBody(
    req: Request,
    res: Response,
    next: NextFunction,
  ) {
    if (
      req.method !== 'POST' ||
      !/^\/qa\/sites\/[A-Za-z0-9_-]{1,100}\/stands\/voice\/?$/.test(req.path)
    )
      return next();
    parser(req, res, (error?: unknown) => {
      if (!error) return next();
      const large = (error as { type?: string }).type === 'entity.too.large';
      res.status(large ? 413 : 400).json({
        success: false,
        error: {
          code: large ? 'QA_STAND_AUDIO_TOO_LARGE' : 'QA_STAND_AUDIO_INVALID',
          message: 'Не удалось прочитать запись.',
        },
        meta: { path: req.path, timestamp: new Date().toISOString() },
      });
    });
  };
}
