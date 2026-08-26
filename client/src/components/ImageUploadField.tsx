import { Image as ImageIcon, Upload, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';

type Props = {
  name: string;
  label: string;
  accept?: string;
  required?: boolean;
  disabled?: boolean;
  currentUrl?: string | null;
};

export function ImageUploadField({ name, label, accept = 'image/png,image/jpeg,image/webp', required = false, disabled = false, currentUrl = null }: Props) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const localUrlRef = useRef<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(currentUrl);
  const [fileName, setFileName] = useState('');

  const revokeLocalUrl = () => {
    if (!localUrlRef.current) return;
    URL.revokeObjectURL(localUrlRef.current);
    localUrlRef.current = null;
  };

  const clearSelection = () => {
    if (inputRef.current) inputRef.current.value = '';
    revokeLocalUrl();
    setPreviewUrl(currentUrl);
    setFileName('');
  };

  useEffect(() => {
    if (!fileName) setPreviewUrl(currentUrl);
  }, [currentUrl, fileName]);

  useEffect(() => {
    const input = inputRef.current;
    const form = input?.form;
    if (!form) return;
    const handleReset = () => window.setTimeout(clearSelection, 0);
    form.addEventListener('reset', handleReset);
    return () => form.removeEventListener('reset', handleReset);
  });

  useEffect(() => () => revokeLocalUrl(), []);

  return <div className={`image-upload-field ${disabled ? 'disabled' : ''}`}>
    <span className="field-label">{label}</span>
    <div className="image-upload-preview">
      {previewUrl ? <img src={previewUrl} alt={`${label} preview`} /> : <div className="image-upload-placeholder"><ImageIcon size={24} /></div>}
      <div className="image-upload-details">
        <strong>{fileName || (currentUrl ? 'Current image' : 'No image selected')}</strong>
        <span>PNG, JPEG, WebP{accept.includes('image/gif') ? ' or GIF' : ''}</span>
        <div className="image-upload-actions">
          <label className="secondary-button small" htmlFor={inputId}><Upload size={14} /> Choose image</label>
          {fileName && <button type="button" className="icon-button danger" onClick={clearSelection} aria-label="Clear selected image"><X size={15} /></button>}
        </div>
      </div>
    </div>
    <input
      ref={inputRef}
      id={inputId}
      className="visually-hidden-file"
      type="file"
      name={name}
      accept={accept}
      required={required}
      disabled={disabled}
      onChange={(event) => {
        const file = event.target.files?.[0];
        if (!file) return clearSelection();
        revokeLocalUrl();
        const nextUrl = URL.createObjectURL(file);
        localUrlRef.current = nextUrl;
        setPreviewUrl(nextUrl);
        setFileName(file.name);
      }}
    />
  </div>;
}
