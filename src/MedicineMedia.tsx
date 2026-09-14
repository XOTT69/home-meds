import { Camera, ImagePlus, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { supabase } from './lib/supabase';

export function MedicinePhotoUploader({ userId, value, onChange }: { userId: string; value?: string; onChange: (path?: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const choose = async (file?: File) => {
    if (!file) return;
    const extensions: Record<string, string> = {
      'image/jpeg': 'jpg',
      'image/png': 'png',
      'image/webp': 'webp',
      'image/heic': 'heic',
      'image/heif': 'heif',
    };
    const extension = extensions[file.type];
    if (!extension) return setMessage('Підійде фото JPG, PNG, WebP або HEIC. SVG та інші файли не завантажуються.');
    if (file.size > 5_000_000) return setMessage('Фото має бути менше 5 МБ.');
    setPending(true); setMessage('');
    const path = `${userId}/${crypto.randomUUID()}.${extension}`;
    const { error } = await supabase!.storage.from('home-meds-photos').upload(path, file, {
      upsert: false,
      contentType: file.type,
    });
    setPending(false);
    if (error) return setMessage('Не вдалося завантажити фото.');
    onChange(path);
  };
  return <div className="photo-upload"><input ref={input} className="visually-hidden" type="file" accept="image/*" capture="environment" onChange={(e) => void choose(e.target.files?.[0])} /><button type="button" className="outline-button" disabled={pending} onClick={() => input.current?.click()}>{value ? <Camera size={16} /> : <ImagePlus size={16} />}{pending ? 'Завантажуємо…' : value ? 'Змінити фото' : 'Додати фото упаковки'}</button>{value && <button type="button" className="icon-button" title="Прибрати фото" onClick={() => onChange(undefined)}><X size={16} /></button>}{message && <small>{message}</small>}</div>;
}
