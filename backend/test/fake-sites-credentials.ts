/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-this-alias -- дублёр клиента внутреннего API */
/**
 * Поддельный внутренний API хранилища учётных данных sites-backend (Э-С Ш2)
 * для тестов генератора: записи и секреты — в памяти, с теми же правилами,
 * что у настоящего (аренда только на хост учётки, личная запись — только
 * владельцу, удалённая запись — 404). Режимы отказа — `offline` (сеть,
 * 5xx), `unconfigured` (CREDENTIALS_NOT_CONFIGURED), `refuseSite`
 * (кабинет не даёт завести учётку).
 */
import {
  SitesRejectedError,
  SitesUnavailableError,
  type SitesCredentialPurpose,
  type SitesCredentialSecrets,
  type SitesInternalClient,
} from '../src/modules/sites-internal/sites-internal.client';

export interface FakeRecord {
  kind: 'site' | 'user';
  id: string;
  owner: string;
  clientRef: string | null;
  /** Личная запись: сайт записи не меняется (как USER_SESSION_ORIGIN_MISMATCH). */
  origin?: string;
  hostIds: string[];
  secrets: Partial<Record<SitesCredentialPurpose, string>>;
}

export class FakeSitesCredentials {
  records = new Map<string, FakeRecord>();
  calls: string[] = [];
  configuredFlag = true;
  offline = false;
  unconfigured = false;
  refuseSite = false;
  private seq = 0;

  private guard(name: string) {
    this.calls.push(name);
    if (this.offline) throw new SitesUnavailableError('нет связи');
    if (this.unconfigured) {
      throw new SitesUnavailableError(
        'кабинет сайтов вернул ошибку',
        'CREDENTIALS_NOT_CONFIGURED',
      );
    }
  }

  private gone(): never {
    throw new SitesRejectedError(404, 'NOT_FOUND', 'нет записи');
  }

  private find(kind: 'site' | 'user', id: string, owner: string) {
    const r = this.records.get(id);
    if (!r || r.kind !== kind || r.owner !== owner) this.gone();
    return r;
  }

  private upsert(
    kind: 'site' | 'user',
    owner: string,
    clientRef: string | null,
    hostIds: string[],
    origin?: string,
  ): FakeRecord {
    for (const r of this.records.values()) {
      if (
        r.kind === kind &&
        r.owner === owner &&
        clientRef &&
        r.clientRef === clientRef
      ) {
        if (origin !== undefined && r.origin !== origin) {
          throw new SitesRejectedError(
            409,
            'USER_SESSION_ORIGIN_MISMATCH',
            'другой сайт',
          );
        }
        return r;
      }
    }
    const rec: FakeRecord = {
      kind,
      id: `${kind}-${++this.seq}`,
      owner,
      clientRef,
      ...(origin !== undefined ? { origin } : {}),
      hostIds,
      secrets: {},
    };
    this.records.set(rec.id, rec);
    return rec;
  }

  client(): SitesInternalClient {
    const self = this;
    const flags = (r: FakeRecord) => ({
      password: !!r.secrets.password,
      loginFields: !!r.secrets['login-fields'],
      session: !!r.secrets['session-cookies'],
    });
    return {
      configured: () => self.configuredFlag,
      async upsertTestAccount(telegramId: string, req: any) {
        self.guard('upsertTestAccount');
        if (self.refuseSite) {
          throw new SitesRejectedError(403, 'HOST_NOT_MANAGED', 'не ваш');
        }
        const r = self.upsert('site', telegramId, req.clientRef ?? null, [
          req.hostId,
        ]);
        return { id: r.id, secrets: flags(r) };
      },
      async upsertUserSession(ownerRef: string, req: any) {
        self.guard('upsertUserSession');
        const r = self.upsert(
          'user',
          ownerRef,
          req.clientRef ?? null,
          [],
          req.origin,
        );
        return { id: r.id, origin: req.origin, secrets: flags(r) };
      },
      async putTestAccountSecret(
        telegramId: string,
        id: string,
        purpose: SitesCredentialPurpose,
        secret: string | null,
      ) {
        self.guard('putTestAccountSecret');
        const r = self.find('site', id, telegramId);
        if (secret === null) delete r.secrets[purpose];
        else r.secrets[purpose] = secret;
        return { id: r.id, secrets: flags(r) };
      },
      async putUserSessionSecret(
        ownerRef: string,
        id: string,
        purpose: SitesCredentialPurpose,
        secret: string | null,
      ) {
        self.guard('putUserSessionSecret');
        const r = self.find('user', id, ownerRef);
        if (secret === null) delete r.secrets[purpose];
        else r.secrets[purpose] = secret;
        return { id: r.id, secrets: flags(r) };
      },
      async leaseSecrets(
        telegramId: string,
        req: { testAccountId: string; hostId: string; runRef?: string },
      ): Promise<SitesCredentialSecrets> {
        self.guard(`leaseSecrets:${req.runRef ?? ''}`);
        const r = self.find('site', req.testAccountId, telegramId);
        if (!r.hostIds.includes(req.hostId)) {
          throw new SitesRejectedError(403, 'CREDENTIAL_LEASE_DENIED', 'хост');
        }
        return { ...r.secrets };
      },
      async readUserSession(
        ownerRef: string,
        id: string,
      ): Promise<SitesCredentialSecrets> {
        self.guard('readUserSession');
        return { ...self.find('user', id, ownerRef).secrets };
      },
      async forgetTestAccountSecrets(telegramId: string, id: string) {
        self.guard('forgetTestAccountSecrets');
        const r = self.find('site', id, telegramId);
        const n = Object.keys(r.secrets).length;
        r.secrets = {};
        return { forgotten: n };
      },
      async deleteUserSession(ownerRef: string, id: string) {
        self.guard('deleteUserSession');
        self.find('user', id, ownerRef);
        self.records.delete(id);
        return { deleted: true };
      },
    } as unknown as SitesInternalClient;
  }
}
