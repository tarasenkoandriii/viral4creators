import { apiGet } from "./admin-api";
export type SonioxGroup = {
  window: "day" | "previous";
  operation: string;
  actorRole: string;
  source: string;
  status: string;
  calls: number;
  seconds: number;
  characters: number;
  words: number;
  latencyAvgMs: number | null;
  latencyP95Ms: number | null;
  confidence: number | null;
  lowConfidence?: number;
  actors?: number;
  accounts?: number;
  sites?: number;
};
export type SonioxEvent = {
  id: string;
  operation: string;
  source: string;
  actorRole: string;
  actorId: string | null;
  accountId: string | null;
  siteId: string | null;
  startedAt: string;
  finishedAt: string | null;
  status: string;
  reasonCode: string | null;
  elapsedMs: number | null;
  seconds: number;
  characters: number;
  words: number;
  language: string | null;
  confidence: number | null;
};
export type SonioxSource = {
  available: boolean;
  billingAvailable?: boolean;
  error?: string;
  keyConfigured?: boolean;
  generatedAt?: string;
  groups?: SonioxGroup[];
  hourly?: { at: string; calls: number; errors: number }[];
  recent?: SonioxEvent[];
  active?: SonioxEvent[];
  coverage?: {
    firstEventAt: string | null;
    active: number;
    interrupted: number;
  }[];
  usage?: {
    operation: string;
    calls: number;
    seconds: number;
    characters: number;
    costUsd: number;
    unpriced: number;
  }[];
};
export type SonioxDashboard = {
  generatedAt: string;
  generator: SonioxSource;
  sites: SonioxSource;
};
export const getSonioxDashboard = () =>
  apiGet<SonioxDashboard>("/admin/soniox");
export const sonioxFailures = (status: string) =>
  ["error", "timeout", "interrupted"].includes(status);
export const sonioxInWindow = (group: SonioxGroup, days: 1 | 7) =>
  days === 7 || group.window === "day";

export function sonioxHourSeries(
  rows: { at: string; calls: number; errors: number }[],
  days: 1 | 7,
  now = Date.now(),
) {
  const end = Math.floor(now / 3600000) * 3600000,
    map = new Map(
      rows.map((r) => [Math.floor(Date.parse(r.at) / 3600000) * 3600000, r]),
    );
  return Array.from({ length: days * 24 + 1 }, (_, i) => {
    const at = end - (days * 24 - i) * 3600000;
    return (
      map.get(at) ?? { at: new Date(at).toISOString(), calls: 0, errors: 0 }
    );
  });
}
