import type { ReactNode } from "react";

export function Skeleton({ rows = 6, label }: { rows?: number; label: string }) {
  return (
    <output aria-busy="true" aria-label={label} style={{ display: "block" }}>
      {Array.from({ length: rows }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
        <div key={i} className="skeleton" style={{ height: "var(--row-min)", marginBottom: "var(--s2)" }} />
      ))}
    </output>
  );
}

export function ErrorState({ what, error, retry }: { what: string; error: unknown; retry: () => void }) {
  const msg = error instanceof Error ? error.message : String(error);
  return (
    <div className="state error" role="alert">
      <h3>Could not load {what}</h3>
      <p>{msg}</p>
      <button type="button" className="ghost" onClick={retry}>
        Try again
      </button>
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="state">
      <h3>{title}</h3>
      {children}
    </div>
  );
}
