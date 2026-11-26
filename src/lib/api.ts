import type { DirListing, Report, RootEntry } from './types';

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error || `${res.status} ${res.statusText}`);
  return body as T;
}

export const listDir = (path?: string) =>
  json<DirListing>(`/api/fs${path ? `?path=${encodeURIComponent(path)}` : ''}`);

export const listRoots = () => json<{ roots: RootEntry[]; claudeHome: string }>('/api/roots');

export interface Progress {
  phase: string;
  done: number;
  total: number;
  fromCache: number;
  parsed: number;
}

/** Analysis runs as a polled job — a cold scan can read hundreds of MB. */
export async function analyze(
  root: string,
  exclude: string[],
  onProgress: (p: Progress) => void,
): Promise<Report> {
  const { id } = await json<{ id: string }>('/api/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ root, exclude }),
  });

  for (;;) {
    await new Promise((r) => setTimeout(r, 220));
    const res = await fetch(`/api/analyze/${id}`);
    const body = await res.json();
    if (body.status === 'done') return body.result as Report;
    if (!res.ok || body.status === 'error') throw new Error(body.error || 'analysis failed');
    if (body.progress) onProgress(body.progress as Progress);
  }
}
