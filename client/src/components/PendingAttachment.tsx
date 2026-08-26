import { File, X } from 'lucide-react';
import { useEffect, useMemo } from 'react';

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function PendingAttachment({ file, onRemove }: { file: File; onRemove: () => void }) {
  const isImage = file.type.startsWith('image/');
  const previewUrl = useMemo(() => isImage ? URL.createObjectURL(file) : null, [file, isImage]);

  useEffect(() => () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  return <div className={`pending-attachment ${isImage ? 'image' : 'file'}`}>
    {previewUrl ? <img src={previewUrl} alt={`Preview of ${file.name}`} /> : <div className="pending-file-icon"><File size={24} /></div>}
    <div className="pending-attachment-meta"><strong title={file.name}>{file.name}</strong><span>{formatSize(file.size)}</span></div>
    <button type="button" className="pending-attachment-remove" onClick={onRemove} aria-label={`Remove ${file.name}`}><X size={15} /></button>
  </div>;
}
