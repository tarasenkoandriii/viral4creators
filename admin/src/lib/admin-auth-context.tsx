'use client';

// Клиентская сессия. AdminSession — httpOnly cookie, JS не может
// прочитать сам token — состояние "залогинен ли я" узнаётся ТОЛЬКО через
// реальный запрос GET /admin/auth/me (401 = не залогинен или сессия
// истекла), не через чтение cookie на клиенте.
//
// Перенесено из проекта Devil's Advocate
// (apps/admin/src/lib/admin-auth-context.tsx).

import { createContext, useCallback, useContext, useEffect, useRef, useState, ReactNode } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { getMe, logout as logoutRequest } from './endpoints';
import { ApiRequestError } from './admin-api';
import type { AdminMe } from './types';

interface AdminAuthState {
  me: AdminMe | null;
  /** Первая проверка личности ещё идёт — шапку и страницу рисовать рано. */
  loading: boolean;
  /**
   * Сервис недоступен (сеть, шлюз), а не «не вошёл» (этап 50, В-5.14):
   * раньше обрыв сети давал `me = null` без редиректа и без сообщения —
   * заголовок страницы и всё.
   */
  unreachable: string | null;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}

const AdminAuthContext = createContext<AdminAuthState | null>(null);

export function AdminAuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<AdminMe | null>(null);
  const [loading, setLoading] = useState(true);
  const [unreachable, setUnreachable] = useState<string | null>(null);
  const router = useRouter();
  const pathname = usePathname();

  // Этап 50 (В-5.13): личность перепроверяется на каждый переход, но
  // `loading` поднимается только при ПЕРВОЙ проверке. Раньше шапка
  // исчезала на ~360 мс при каждом клике по вкладке, а контент прыгал.
  const checkedOnce = useRef(false);

  const refresh = useCallback(async () => {
    if (!checkedOnce.current) setLoading(true);
    try {
      const result = await getMe();
      setMe(result);
      setUnreachable(null);
    } catch (err) {
      setMe(null);
      if (err instanceof ApiRequestError && err.httpStatus === 401) {
        // 401 — честный редирект на /login, не молчаливый показ пустых данных.
        setUnreachable(null);
        if (pathname !== '/login') router.replace('/login');
      } else if (err instanceof ApiRequestError) {
        // Аудит 14.09.2026 (М-7.9): 502/503/500 от шлюза — это «сервис
        // недоступен», а не «не вошёл»; раньше любой ApiRequestError
        // выбрасывал на /login, где тот же 5xx повторялся при входе.
        setUnreachable(`Сервис ответил ошибкой ${err.httpStatus}: ${err.message}`);
      } else {
        // Не ответ сервера, а его отсутствие: редирект на /login только
        // запутает — входить не во что.
        setUnreachable(
          err instanceof Error && err.message
            ? `Нет связи с сервисом: ${err.message}`
            : 'Нет связи с сервисом'
        );
      }
    } finally {
      checkedOnce.current = true;
      setLoading(false);
    }
  }, [pathname, router]);

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  const logout = useCallback(async () => {
    await logoutRequest();
    setMe(null);
    router.replace('/login');
  }, [router]);

  return (
    <AdminAuthContext.Provider value={{ me, loading, unreachable, refresh, logout }}>
      {unreachable && pathname !== '/login' ? (
        <main className="admin-main">
          <h1>Админка</h1>
          <p className="critical">{unreachable}</p>
          <button type="button" onClick={() => void refresh()}>
            Повторить
          </button>
        </main>
      ) : (
        children
      )}
    </AdminAuthContext.Provider>
  );
}

export function useAdminAuth(): AdminAuthState {
  const ctx = useContext(AdminAuthContext);
  if (!ctx) {
    throw new Error('useAdminAuth must be used within AdminAuthProvider');
  }
  return ctx;
}
