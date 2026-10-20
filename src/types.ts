export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
}

export interface AuthUser {
  id: number;
  username: string;
}

export type IpType = "v4" | "v6";

export interface HostRecordRow {
  hostname: string;
  ip_version: 4 | 6;
  ip_address: string;
  expires_at: number;
}
