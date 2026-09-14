import { FormEvent, useEffect, useState } from 'react';
import { AlertCircle, Edit3, LoaderCircle, Plus, Trash2, UsersRound } from 'lucide-react';
import { supabase } from './lib/supabase';

type Member = { id: string; user_id: string; name: string; relation: string; allergies: string; notes: string };
type MemberDraft = Omit<Member, 'id' | 'user_id'>;

const emptyDraft = (): MemberDraft => ({ name: '', relation: '', allergies: '', notes: '' });

export function FamilyPanel({ userId, onMembersChange, readOnly = false }: { userId: string; onMembersChange?: (members: Member[]) => void; readOnly?: boolean }) {
  const [members, setMembers] = useState<Member[]>([]);
  const [draft, setDraft] = useState<MemberDraft>(emptyDraft);
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!supabase) return;
    void supabase
      .from('home_meds_members')
      .select('*')
      .eq('user_id', userId)
      .order('created_at')
      .then(({ data, error: loadError }) => {
        if (loadError) {
          setError('Не вдалося завантажити профілі родини. Спробуйте ще раз.');
          return;
        }
        const nextMembers = (data ?? []) as Member[];
        setMembers(nextMembers);
        onMembersChange?.(nextMembers);
      });
  }, [userId]);

  const close = (force = false) => {
    if (isSaving && !force) return;
    setOpen(false);
    setEditingId(null);
    setDraft(emptyDraft());
    setError('');
  };

  const add = () => {
    if (readOnly) return;
    setEditingId(null);
    setDraft(emptyDraft());
    setError('');
    setOpen(true);
  };

  const edit = (member: Member) => {
    if (readOnly) return;
    setEditingId(member.id);
    setDraft({ name: member.name, relation: member.relation, allergies: member.allergies, notes: member.notes });
    setError('');
    setOpen(true);
  };

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!supabase || readOnly) return;

    const name = draft.name.trim();
    if (!name) {
      setError('Вкажіть ім’я або назву профілю.');
      return;
    }

    const values: MemberDraft = {
      name,
      relation: draft.relation.trim(),
      allergies: draft.allergies.trim(),
      notes: draft.notes.trim(),
    };
    setIsSaving(true);
    setError('');

    if (editingId) {
      const { data, error: updateError } = await supabase
        .from('home_meds_members')
        .update(values)
        .eq('id', editingId)
        .eq('user_id', userId)
        .select()
        .single();
      setIsSaving(false);

      if (updateError || !data) {
        setError('Не вдалося оновити профіль. Перевірте з’єднання й спробуйте ще раз.');
        return;
      }
      const updated = data as Member;
      setMembers((items) => {
        const nextMembers = items.map((item) => (item.id === updated.id ? updated : item));
        onMembersChange?.(nextMembers);
        return nextMembers;
      });
      close(true);
      return;
    }

    const member: Member = { id: crypto.randomUUID(), user_id: userId, ...values };
    const { data, error: insertError } = await supabase.from('home_meds_members').insert(member).select().single();
    setIsSaving(false);

    if (insertError || !data) {
      setError('Не вдалося зберегти профіль. Перевірте з’єднання й спробуйте ще раз.');
      return;
    }
    setMembers((items) => {
      const nextMembers = [...items, data as Member];
      onMembersChange?.(nextMembers);
      return nextMembers;
    });
    close(true);
  };

  const remove = async (member: Member) => {
    if (!supabase || readOnly || !confirm(`Видалити профіль «${member.name}»?`)) return;
    setDeletingId(member.id);
    setError('');
    const { error: deleteError } = await supabase.from('home_meds_members').delete().eq('id', member.id).eq('user_id', userId);
    setDeletingId(null);
    if (deleteError) {
      setError('Не вдалося видалити профіль. Спробуйте ще раз.');
      return;
    }
    setMembers((items) => {
      const nextMembers = items.filter((item) => item.id !== member.id);
      onMembersChange?.(nextMembers);
      return nextMembers;
    });
  };

  return <section className="panel family-panel"><div className="panel-title"><div><p className="eyebrow">ВАША РОДИНА</p><h2>Для кого аптечка</h2></div>{!readOnly && <button type="button" className="outline-button" onClick={add}><Plus size={16} /> Додати</button>}</div>{readOnly && <p className="subtext">Лише перегляд — редагування доступне власнику та редакторам.</p>}{error && !open && <p className="form-hint" role="alert"><AlertCircle size={15} /> {error}</p>}{members.length ? <div className="family-grid">{members.map((member) => <article className="family-card" key={member.id}><span><UsersRound size={18} /></span><div><strong>{member.name}</strong><small>{member.relation || 'Член родини'}</small>{member.allergies && <p>Алергії: {member.allergies}</p>}{member.notes && <p>Примітки: {member.notes}</p>}</div>{!readOnly && <><button type="button" className="dots" aria-label={`Редагувати ${member.name}`} onClick={() => edit(member)}><Edit3 size={16} /></button><button type="button" className="dots danger-action" aria-label={`Видалити ${member.name}`} disabled={deletingId === member.id} onClick={() => void remove(member)}>{deletingId === member.id ? <LoaderCircle size={16} className="spin" /> : <Trash2 size={16} />}</button></>}</article>)}</div> : <p className="subtext">Додайте членів родини, щоб зберігати важливі застереження.</p>}{open && <div className="modal-backdrop" onMouseDown={() => close()}><form className="modal" onMouseDown={(event) => event.stopPropagation()} onSubmit={save}><div className="modal-head"><h2>{editingId ? 'Редагувати профіль' : 'Новий профіль'}</h2></div><label>Ім’я<input required autoFocus value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label><label>Хто це<input value={draft.relation} onChange={(event) => setDraft({ ...draft, relation: event.target.value })} placeholder="Наприклад, дитина" /></label><label>Алергії<input value={draft.allergies} onChange={(event) => setDraft({ ...draft, allergies: event.target.value })} placeholder="Лише відомі застереження" /></label><label>Примітки<textarea value={draft.notes} onChange={(event) => setDraft({ ...draft, notes: event.target.value })} /></label>{error && <p className="form-hint" role="alert"><AlertCircle size={15} /> {error}</p>}<button className="primary-button full" disabled={isSaving}>{isSaving ? 'Зберігаємо…' : 'Зберегти'}</button><button type="button" className="auth-text-button" disabled={isSaving} onClick={() => close()}>Скасувати</button></form></div>}</section>;
}
