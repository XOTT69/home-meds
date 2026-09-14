import { FormEvent, useEffect, useState } from 'react';
import { Plus, Trash2, UsersRound } from 'lucide-react';
import { supabase } from './lib/supabase';

type Member = { id: string; user_id: string; name: string; relation: string; allergies: string; notes: string };

export function FamilyPanel({ userId }: { userId: string }) {
  const [members, setMembers] = useState<Member[]>([]);
  const [draft, setDraft] = useState({ name: '', relation: '', allergies: '', notes: '' });
  const [open, setOpen] = useState(false);

  useEffect(() => { void supabase!.from('home_meds_members').select('*').eq('user_id', userId).then(({ data }) => setMembers((data ?? []) as Member[])); }, [userId]);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    const member: Member = { id: crypto.randomUUID(), user_id: userId, ...draft };
    const { error } = await supabase!.from('home_meds_members').insert(member);
    if (!error) { setMembers((items) => [...items, member]); setDraft({ name: '', relation: '', allergies: '', notes: '' }); setOpen(false); }
  };
  const remove = async (member: Member) => {
    if (!confirm(`Видалити профіль «${member.name}»?`)) return;
    setMembers((items) => items.filter((item) => item.id !== member.id));
    await supabase!.from('home_meds_members').delete().eq('id', member.id);
  };

  return <section className="panel family-panel"><div className="panel-title"><div><p className="eyebrow">ВАША РОДИНА</p><h2>Для кого аптечка</h2></div><button className="outline-button" onClick={() => setOpen(true)}><Plus size={16} /> Додати</button></div>{members.length ? <div className="family-grid">{members.map((member) => <article className="family-card" key={member.id}><span><UsersRound size={18} /></span><div><strong>{member.name}</strong><small>{member.relation || 'Член родини'}</small>{member.allergies && <p>Алергії: {member.allergies}</p>}</div><button className="dots danger-action" onClick={() => void remove(member)}><Trash2 size={16} /></button></article>)}</div> : <p className="subtext">Додайте членів родини, щоб зберігати важливі застереження.</p>}{open && <div className="modal-backdrop"><form className="modal" onSubmit={save}><div className="modal-head"><h2>Новий профіль</h2></div><label>Ім’я<input required autoFocus value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></label><label>Хто це<input value={draft.relation} onChange={(e) => setDraft({ ...draft, relation: e.target.value })} placeholder="Наприклад, дитина" /></label><label>Алергії<input value={draft.allergies} onChange={(e) => setDraft({ ...draft, allergies: e.target.value })} placeholder="Лише відомі застереження" /></label><label>Примітки<textarea value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} /></label><button className="primary-button full">Зберегти</button><button type="button" className="auth-text-button" onClick={() => setOpen(false)}>Скасувати</button></form></div>}</section>;
}
