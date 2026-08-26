import { useEffect, type ReactNode } from 'react';

export type ContextMenuItem = { label: string; icon?: ReactNode; danger?: boolean; disabled?: boolean; separator?: boolean; onClick?: () => void };

export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: ContextMenuItem[]; onClose: () => void }) {
  useEffect(() => {
    const close = () => onClose();
    window.addEventListener('click', close);
    window.addEventListener('blur', close);
    window.addEventListener('resize', close);
    return () => { window.removeEventListener('click', close); window.removeEventListener('blur', close); window.removeEventListener('resize', close); };
  }, [onClose]);
  const menuWidth = Math.min(230, Math.max(160, window.innerWidth - 16));
  const menuHeight = Math.min(420, items.length * 38 + 24);
  const left = Math.max(8, Math.min(x, window.innerWidth - menuWidth - 8));
  const top = Math.max(8, Math.min(y, window.innerHeight - menuHeight - 8));
  return (
    <div className="context-menu" style={{ left, top }} onClick={(event) => event.stopPropagation()}>
      {items.map((item, index) => item.separator ? <div key={index} className="context-separator" /> : (
        <button key={`${item.label}-${index}`} className={item.danger ? 'danger' : ''} disabled={item.disabled} onClick={() => { item.onClick?.(); onClose(); }}>
          <span>{item.label}</span>{item.icon}
        </button>
      ))}
    </div>
  );
}
