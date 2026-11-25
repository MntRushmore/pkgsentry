import { VERSION } from './version.js';

export interface HttpResponse<T = unknown> {
  status: number;
  body: T | undefined;
}

export class Http {
  constructor(
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
    private readonly timeoutMs = 8000,
  ) {}

  async request<T>(
    url: string,
    init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<HttpResponse<T>> {
    let res = await this.send(url, init);
    // One polite retry on rate limiting / brief outages (npm's downloads API rate limits bursts).
    if (res.status === 429 || res.status === 503) {
      const after = Number(res.headers.get('retry-after'));
      await new Promise((r) => setTimeout(r, Number.isFinite(after) && after > 0 ? Math.min(after * 1000, 2000) : 750));
      res = await this.send(url, init);
    }
    let body: T | undefined;
    if (init.method !== 'HEAD') {
      const text = await res.text();
      try {
        body = text ? (JSON.parse(text) as T) : undefined;
      } catch {
        body = undefined;
      }
    }
    return { status: res.status, body };
  }

  private send(url: string, init: { method?: string; body?: unknown; headers?: Record<string, string> }) {
    return this.fetchImpl(url, {
      method: init.method ?? 'GET',
      headers: {
        'user-agent': `pkgsentry/${VERSION} (+https://github.com/MntRushmore/pkgsentry)`,
        accept: 'application/json',
        ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...init.headers,
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      redirect: 'follow',
      signal: AbortSignal.timeout(this.timeoutMs),
    });
  }

  getJson<T>(url: string, headers?: Record<string, string>) {
    return this.request<T>(url, { headers });
  }

  postJson<T>(url: string, body: unknown) {
    return this.request<T>(url, { method: 'POST', body });
  }

  async head(url: string, headers?: Record<string, string>): Promise<number> {
    return (await this.request(url, { method: 'HEAD', headers })).status;
  }
}

export class RegistryError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}
