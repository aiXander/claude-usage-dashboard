import { useState } from 'react';
import type { ProjectEntry } from '../lib/types';
import { homeRelative, int, usd } from '../lib/format';

/**
 * Hide projects from the current view, or keep only one. A project is a
 * folder with its own `.claude-costs` ledger under the scanned root (the
 * server's `projectOf`); everything without one rolls up into its nearest
 * ledgered ancestor.
 *
 * Edits are a draft until Apply: each apply is a re-scan, so toggling five
 * projects should cost one, not five.
 */
export function ProjectFilter({
  projects,
  home,
  onApply,
  onClose,
}: {
  projects: ProjectEntry[];
  home: string;
  onApply: (exclude: string[]) => void;
  onClose: () => void;
}) {
  const [hidden, setHidden] = useState(() => new Set(projects.filter((p) => p.hidden).map((p) => p.path)));

  const toggle = (path: string) => {
    const next = new Set(hidden);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    setHidden(next);
  };
  const only = (path: string) => setHidden(new Set(projects.map((p) => p.path).filter((p) => p !== path)));

  const shown = projects.length - hidden.size;

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Filter projects">
        <header>
          <h2>Projects in this view</h2>
          <p>
            Hidden projects drop out of every number, chart and tab: their transcripts, cost ledger and prompts. Use{' '}
            <b>only</b> to look at a single project.
          </p>
        </header>

        <div className="body">
          {projects.map((p) => {
            const on = !hidden.has(p.path);
            return (
              <div className={`rowitem projectrow${on ? '' : ' off'}`} key={p.path}>
                <button className="check" aria-pressed={on} onClick={() => toggle(p.path)} title={on ? 'Hide' : 'Show'}>
                  {on ? '✓' : ''}
                </button>
                <button className="name mono linklike" onClick={() => toggle(p.path)} title={p.path}>
                  {homeRelative(p.path, home) || '~'}
                </button>
                <span className="meta">{int(p.prompts)} prompts</span>
                {p.cost > 0 ? <span className="badge">{usd(p.cost)}</span> : <span className="badge dim">no ledger</span>}
                <button className="btn ghost onlybtn" onClick={() => only(p.path)}>
                  only
                </button>
              </div>
            );
          })}
        </div>

        <footer>
          <div className="dim" style={{ flex: 1, fontSize: 12 }}>
            {shown} of {projects.length} projects shown
          </div>
          <button className="btn ghost" disabled={!hidden.size} onClick={() => setHidden(new Set())}>
            Show all
          </button>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!shown} onClick={() => onApply([...hidden])}>
            Apply
          </button>
        </footer>
      </div>
    </div>
  );
}
