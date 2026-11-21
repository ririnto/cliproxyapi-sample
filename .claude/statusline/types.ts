import type { StdioOptions } from "node:child_process";

export type JsonRecord = Record<string, unknown>;

export type Metric =
  | {
      type: "percentage";
      label: string;
      percentage: number;
      resetsInMs?: number;
    }
  | {
      type: "usage";
      label: string;
      used: number;
      total: number;
      resetsInMs?: number;
    }
  | { type: "credit"; label: string; remaining: number; currency?: string }
  | {
      type: "budget";
      label: string;
      percentage: number;
      used: number;
      total: number;
      currency?: string;
      resetsInMs?: number;
    };
export interface Snapshot {
  groups: {
    label?: string;
    metrics: Metric[];
    deduplicateWithNativeQuota?: boolean;
  }[];
}
export interface FetchOptions {
  headers: Record<string, string>;
  method: string;
  redirect?: RequestInit["redirect"];
  signal: AbortSignal;
}
export type Fetch = (
  url: string,
  options: FetchOptions
) => Response | Promise<Response>;
export interface UsageOptions {
  credential?: unknown;
  now?: number | Date;
  fetch?: Fetch;
  onUsageError?: () => void;
  cache?: boolean;
  cacheDir?: string;
  cacheTtlMs?: number;
  home?: string;
  environment?: Record<string, string | undefined>;
  platform?: string;
  execFile?: (
    file: string,
    args: string[],
    options: { encoding: BufferEncoding; timeout: number; stdio?: StdioOptions }
  ) => string;
}

export interface UsageRuntime {
  withUsageCache: <T>(
    provider: string,
    credentialIdentity: unknown,
    options: UsageOptions,
    fetchSnapshot: (options: UsageOptions) => T | Promise<T>
  ) => Promise<T | Snapshot | undefined>;
  requestJson: (
    url: string,
    headers: Record<string, string>,
    fetchFunction: Fetch,
    onUsageError: (() => void) | undefined
  ) => Promise<{ payload?: JsonRecord; status: number | undefined }>;
}
