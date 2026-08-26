import type { ReactNode } from 'react';
import { X } from 'lucide-react';

type Props = { title: string; children: ReactNode; onClose: () => void; wide?: boolean };

export function Modal({ title, children, onClose, wide = false }: Props) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <header className="modal-header">
          <h2>{title}</h2>
          <button className="icon-button" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </header>
        <div className="modal-body">{children}</div>
      </section>
    </div>
  );
}
