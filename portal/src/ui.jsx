import { useEffect, useState } from 'react';
import { STATUS } from './lib';

export const Pill = ({ s, children }) => {
  const [tone, label] = STATUS[s] || ['neutral', s];
  return <span className={`pill ${tone}`}>{children ?? label}</span>;
};

export const Kpi = ({ label, value, hint, tone }) => (
  <div className="card kpi">
    <div className="lbl">{label}</div>
    <div className={`val ${tone || ''}`}>{value}</div>
    {hint && <div className="hint">{hint}</div>}
  </div>
);

export const Modal = ({ title, sub, onClose, children, wide }) => {
  useEffect(() => {
    const k = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={wide ? { width: 'min(960px,100%)' } : undefined}>
        <header>
          <div><h2>{title}</h2>{sub && <div className="muted small">{sub}</div>}</div>
          <button className="x" onClick={onClose} aria-label="Close">×</button>
        </header>
        {children}
      </div>
    </div>
  );
};

export const Field = ({ label, children }) => (<div className="field"><label>{label}</label>{children}</div>);

export const Empty = ({ children }) => <div className="empty">{children}</div>;

export function useAsync(fn, deps) {
  const [state, set] = useState({ loading: true, data: null, error: null });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true; set((s) => ({ ...s, loading: true }));
    fn().then((data) => live && set({ loading: false, data, error: null }))
        .catch((error) => live && set({ loading: false, data: null, error }));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return { ...state, reload: () => setTick((t) => t + 1) };
}

export const Seg = ({ value, onChange, options }) => (
  <div className="seg">{options.map(([v, l]) => <button key={v} className={value === v ? 'on' : ''} onClick={() => onChange(v)}>{l}</button>)}</div>
);
