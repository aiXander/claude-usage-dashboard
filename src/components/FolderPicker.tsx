import { useEffect, useState } from 'react';
import { listDir, listRoots } from '../lib/api';
import type { DirListing, RootEntry } from '../lib/types';
import { homeRelative, int, usd } from '../lib/format';

/**
 * Point the dashboard at any folder. Two ways in: the quick list of roots
 * Claude already has data for, or a plain directory walk for anything else.
 */
export function FolderPicker({
  initialPath,
  onPick,
  onClose,
}: {
  initialPath?: string;
  onPick: (path: string) => void;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<'known' | 'browse'>('known');
  const [roots, setRoots] = useState<RootEntry[] | null>(null);
  const [listing, setListing] = useState<DirListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    listRoots()
      .then((r) => setRoots(r.roots))
      .catch((e) => setError(String(e.message || e)));
  }, []);

  const go = (path?: string) => {
    setLoading(true);
    setError(null);
    listDir(path)
      .then(setListing)
      .catch((e) => setError(String(e.message || e)))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    if (mode === 'browse' && !listing) go(initialPath);
  }, [mode]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const home = listing?.home ?? '';
  const crumbs = listing ? listing.path.split('/').filter(Boolean) : [];

  return (
    <div className="modal-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Choose a project folder">
        <header>
          <h2>Choose a project</h2>
          <p>
            Usage is read from Claude&apos;s own records: the <code className="mono">.claude-costs</code> ledgers under
            the folder, its session transcripts, and your prompt history.
          </p>
        </header>

        <div className="tabs sub" role="tablist">
          <button className="tab" role="tab" aria-selected={mode === 'known'} onClick={() => setMode('known')}>
            Projects with data
          </button>
          <button className="tab" role="tab" aria-selected={mode === 'browse'} onClick={() => setMode('browse')}>
            Browse folders
          </button>
        </div>

        {mode === 'browse' && listing ? (
          <div className="crumb">
            <button onClick={() => go('/')}>/</button>
            {crumbs.map((part, i) => (
              <span key={i} style={{ display: 'contents' }}>
                <button onClick={() => go('/' + crumbs.slice(0, i + 1).join('/'))}>{part}</button>
                {i < crumbs.length - 1 ? <span className="dim">/</span> : null}
              </span>
            ))}
          </div>
        ) : null}

        <div className="body">
          {error ? <div style={{ padding: 12, color: 'var(--critical)' }}>{error}</div> : null}

          {mode === 'known' ? (
            !roots ? (
              <div style={{ padding: 16, color: 'var(--ink-muted)' }}>Scanning…</div>
            ) : (
              roots.map((root) => (
                <button className="rowitem" key={root.path} onClick={() => onPick(root.path)}>
                  <span className="name mono">{homeRelative(root.path, home || '')}</span>
                  <span className="meta">{int(root.prompts)} prompts</span>
                  {root.cost > 0 ? <span className="badge">{usd(root.cost)}</span> : <span className="badge dim">no ledger</span>}
                </button>
              ))
            )
          ) : (
            <>
              {listing?.parent ? (
                <button className="rowitem" onClick={() => go(listing.parent!)}>
                  <span className="name mono">../</span>
                </button>
              ) : null}
              {loading ? <div style={{ padding: 12, color: 'var(--ink-muted)' }}>Reading…</div> : null}
              {listing?.dirs.map((dir) => (
                <button className="rowitem" key={dir.path} onDoubleClick={() => go(dir.path)} onClick={() => go(dir.path)}>
                  <span className="name mono">{dir.name}/</span>
                  {dir.hasLedger ? <span className="badge">ledger</span> : null}
                  {!dir.hasLedger && dir.hasClaudeData ? <span className="badge dim">sessions</span> : null}
                </button>
              ))}
              {listing && !listing.dirs.length && !loading ? (
                <div style={{ padding: 12, color: 'var(--ink-muted)' }}>No subfolders.</div>
              ) : null}
            </>
          )}
        </div>

        <footer>
          <div className="mono dim" style={{ flex: 1, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {mode === 'browse' ? homeRelative(listing?.path ?? '', home) : 'Pick a project above'}
          </div>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          {mode === 'browse' ? (
            <button className="btn primary" disabled={!listing} onClick={() => listing && onPick(listing.path)}>
              Analyze this folder
            </button>
          ) : null}
        </footer>
      </div>
    </div>
  );
}
