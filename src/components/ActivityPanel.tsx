import { History, LoaderCircle, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabase';

type Activity = {
  id: string;
  actor_user_id: string | null;
  entity_type: 'medicine' | 'trip' | 'trip_item' | 'family_member' | 'shopping';
  action: 'created' | 'updated' | 'deleted';
  label: string;
  created_at: string;
};

const entityLabel: Record<Activity['entity_type'], string> = {
  medicine: 'ліки',
  trip: 'подорож',
  trip_item: 'пункт чекліста',
  family_member: 'профіль родини',
  shopping: 'покупку',
};

const actionLabel: Record<Activity['action'], string> = {
  created: 'додано',
  updated: 'змінено',
  deleted: 'видалено',
};

export function ActivityPanel({ ownerUserId, currentUserId, names }: { ownerUserId: string; currentUserId: string; names: Map<string, string> }) {
  const [items, setItems] = useState<Activity[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (!supabase) return;
    setLoading(true);
    const { data, error: loadError } = await supabase
      .from('home_meds_activity_log')
      .select('id, actor_user_id, entity_type, action, label, created_at')
      .eq('owner_user_id', ownerUserId)
      .order('created_at', { ascending: false })
      .limit(24);
    setLoading(false);
    if (loadError) {
      setError('Журнал з’явиться після запуску останньої міграції.');
      return;
    }
    setError('');
    setItems((data ?? []) as Activity[]);
  }, [ownerUserId]);

  useEffect(() => { void load(); }, [load]);

  const localNames = useMemo(() => new Map(names), [names]);
  const actorName = (actorUserId: string | null) => actorUserId === currentUserId ? 'Ви' : (actorUserId ? localNames.get(actorUserId) || 'Учасник родини' : 'Система');

  return <section className="panel activity-panel">
    <div className="panel-title"><div><p className="eyebrow">ІСТОРІЯ</p><h2>Останні зміни</h2></div><button aria-label="Оновити журнал" className="icon-button" onClick={() => void load()} type="button">{loading ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}</button></div>
    {error && <p className="subtext">{error}</p>}
    {!error && !loading && !items.length && <p className="subtext">Тут з’являться зміни в ліках, поїздках, чеклістах і профілях родини.</p>}
    {!!items.length && <div className="activity-list">{items.map((item) => <div className="activity-row" key={item.id}><span className={'activity-dot ' + item.action} /><div><strong>{actorName(item.actor_user_id)} {actionLabel[item.action]} {entityLabel[item.entity_type]}</strong><p>{item.label}</p></div><time dateTime={item.created_at}>{new Date(item.created_at).toLocaleString('uk-UA', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</time></div>)}</div>}
  </section>;
}
