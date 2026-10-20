import type { IpType } from "./types";

const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function normalizeHostname(value: string | null): string | null {
  if (value === null) return null;
  const hostname = value.trim().toLowerCase().replace(/\.$/, "");
  if (hostname.length < 1 || hostname.length > 253) return null;
  const labels = hostname.split(".");
  if (labels.some((label) => !HOST_LABEL.test(label))) return null;
  return hostname;
}

export function parseIpType(value: string | null, allowAll = false): IpType | "all" | null {
  if (value === "v4" || value === "v6") return value;
  if (allowAll && (value === null || value === "all")) return "all";
  return null;
}

export function parseOutput(value: string | null): "txt" | "json" | null {
  if (value === null || value === "txt") return "txt";
  if (value === "json") return "json";
  return null;
}

function normalizeIpv4(value: string): string | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const numbers = parts.map((part) => (/^(0|[1-9]\d{0,2})$/.test(part) ? Number(part) : -1));
  if (numbers.some((part) => part < 0 || part > 255)) return null;
  return numbers.join(".");
}

export function normalizeIp(value: string | null): { ip: string; version: 4 | 6 } | null {
  if (!value) return null;
  const candidate = value.trim();
  const ipv4 = normalizeIpv4(candidate);
  if (ipv4) return { ip: ipv4, version: 4 };
  if (!candidate.includes(":") || !/^[0-9a-f:.]+$/i.test(candidate)) return null;
  try {
    const hostname = new URL(`http://[${candidate}]/`).hostname;
    if (!hostname.startsWith("[") || !hostname.endsWith("]")) return null;
    return { ip: hostname.slice(1, -1).toLowerCase(), version: 6 };
  } catch {
    return null;
  }
}
