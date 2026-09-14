import {
  AlertTriangle,
  ArrowUpRight,
  Bell,
  Check,
  ChevronRight,
  CirclePlus,
  ClipboardList,
  Home,
  MapPin,
  MapPinned,
  MoreHorizontal,
  PackageCheck,
  Pill,
  Search,
  Settings,
  ShoppingBasket,
  Sparkles,
  Stethoscope,
  X,
} from 'lucide-react';
import { FormEvent, useEffect, useMemo, useState } from 'react';

type Section = 'today' | 'cabinet' | 'travel' | 'shopping';
type Medicine = {
  id: string;
  name: string;
  form: string;
  category: string;
  reason: string;
  expiry: string;
  quantity: number;
  unit: string;
  place: string;
};
type TravelItem = {
  id: string;
  title: string;
  category: string;
  note: string;
  inCabinet: boolean;
  packed: boolean;
  needBuy: boolean;
  bought: boolean;
};

const defaultMedicines: Medicine[] = [
  { id: 'nurofen', name: 'Нурофен', form: '200 мг · таблетки', category: 'Біль і температура', reason: 'Біль, гарячка', expiry: '2026-10-28', quantity: 18, unit: 'табл.', place: 'Верхня шухляда' },
  { id: 'loratadine', name: 'Лоратадин', form: '10 мг · таблетки', category: 'Алергія', reason: 'Сезонна алергія', expiry: '2026-11-13', quantity: 7, unit: 'табл.', place: 'Верхня шухляда' },
  { id: 'smecta', name: 'Смекта', form: 'порошок · саше', category: 'Травлення', reason: 'Розлад травлення', expiry: '2027-04-02', quantity: 4, unit: 'саше', place: 'Кухонна аптечка' },
  { id: 'chlorhexidine', name: 'Хлоргексидин', form: '0,05% · розчин', category: 'Рани й опіки', reason: 'Обробка шкіри', expiry: '2026-09-22', quantity: 1, unit: 'флакон', place: 'Ванна кімната' },
];

const defaultTravelItems: TravelItem[] = [
  { id: 'trip-1', title: 'Нурофен', category: 'Аптечка', note: '18 таблеток у домашній аптечці', inCabinet: true, packed: false, needBuy: false, bought: false },
  { id: 'trip-2', title: 'Пластирі', category: 'Аптечка', note: 'Взяти 8–10 штук', inCabinet: false, packed: false, needBuy: true, bought: false },
  { id: 'trip-3', title: 'Сонцезахисний крем SPF 50', category: 'Догляд', note: 'Для моря та екскурсій', inCabinet: false, packed: false, needBuy: true, bought: false },
  { id: 'trip-4', title: 'Страховий поліс', category: 'Документи', note: 'Завантажити офлайн-копію', inCabinet: false, packed: true, needBuy: false, bought: false },
  { id: 'trip-5', title: 'Лоратадин', category: 'Аптечка', note: '7 таблеток у домашній аптечці', inCabinet: true, packed: false, needBuy: false, bought: false },
];

function readStored<T>(key: string, fallback: T): T {
  try {
    const value = localStorage.getItem(key);
    return value ? (JSON.parse(value) as T) : fallback;
  } catch {
    return fallback;
  }
}

function daysUntil(date: string) {
  return Math.ceil((new Date(`${date}T00:00:00`).getTime() - new Date().setHours(0, 0, 0, 0)) / 86_400_000);
}

function expiryMeta(date: string) {
  const days = daysUntil(date);
  if (days < 0) return { label: `Прострочено ${Math.abs(days)} дн. тому`, tone: 'danger' };
  if (days <= 30) return { label: `Закінчується через ${days} дн.`, tone: 'warn' };
  return { label: `До ${new Intl.DateTimeFormat('uk-UA', { month: 'short', year: 'numeric' }).format(new Date(`${date}T00:00:00`))}`, tone: 'safe' };
}

function IconLogo() {
  return <div className="brand-mark"><span>+</span></div>;
}

function AddMedicineModal({ onClose, onSave }: { onClose: () => void; onSave: (medicine: Medicine) => void }) {
  const [name, setName] = useState('');
  const [category, setCategory] = useState('Біль і температура');
  const [expiry, setExpiry] = useState('');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim() || !expiry) return;
    onSave({ id: crypto.randomUUID(), name: name.trim(), form: 'форма не вказана', category, reason: 'Додайте призначення', expiry, quantity: 1, unit: 'уп.', place: 'Домашня аптечка' });
    onClose();
  };
  return <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
    <form className="modal" onSubmit={submit} onMouseDown={(event) => event.stopPropagation()}>
      <div className="modal-head"><div><p className="eyebrow">НОВА ПОЗИЦІЯ</p><h2>Додати ліки</h2></div><button type="button" className="icon-button" onClick={onClose}><X size={20} /></button></div>
      <label>Назва препарату<input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="Наприклад, Парацетамол" /></label>
      <label>Категорія<select value={category} onChange={(event) => setCategory(event.target.value)}><option>Біль і температура</option><option>Алергія</option><option>Травлення</option><option>Рани й опіки</option><option>Застуда</option><option>Інше</option></select></label>
      <label>Термін придатності<input type="date" value={expiry} onChange={(event) => setExpiry(event.target.value)} /></label>
      <p className="form-hint">Зберігайте лише дані, яким довіряєте. Інформація в застосунку не замінює інструкцію чи консультацію лікаря.</p>
      <button className="primary-button full" type="submit"><CirclePlus size={18} /> Зберегти ліки</button>
    </form>
  </div>;
}

function AddTravelModal({ onClose, onSave }: { onClose: () => void; onSave: (item: TravelItem) => void }) {
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState('Аптечка');
  const [needBuy, setNeedBuy] = useState(true);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!title.trim()) return;
    onSave({ id: crypto.randomUUID(), title: title.trim(), category, note: needBuy ? 'Додано до списку покупок' : 'Взяти з дому', inCabinet: !needBuy, packed: false, needBuy, bought: false });
    onClose();
  };
  return <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
    <form className="modal" onSubmit={submit} onMouseDown={(event) => event.stopPropagation()}>
      <div className="modal-head"><div><p className="eyebrow">ПОДОРОЖ</p><h2>Додати до списку</h2></div><button type="button" className="icon-button" onClick={onClose}><X size={20} /></button></div>
      <label>Що потрібно взяти<input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Наприклад, репелент" /></label>
      <label>Категорія<select value={category} onChange={(event) => setCategory(event.target.value)}><option>Аптечка</option><option>Догляд</option><option>Документи</option><option>Одяг</option><option>Техніка</option></select></label>
      <label className="toggle-line"><input type="checkbox" checked={needBuy} onChange={(event) => setNeedBuy(event.target.checked)} /><span>Потрібно купити</span></label>
      <button className="primary-button full" type="submit"><CirclePlus size={18} /> Додати до подорожі</button>
    </form>
  </div>;
}

export default function App() {
  const [section, setSection] = useState<Section>('today');
  const [medicines, setMedicines] = useState<Medicine[]>(() => readStored('home-meds:medicines', defaultMedicines));
  const [travelItems, setTravelItems] = useState<TravelItem[]>(() => readStored('home-meds:travel', defaultTravelItems));
  const [medicineModalOpen, setMedicineModalOpen] = useState(false);
  const [travelModalOpen, setTravelModalOpen] = useState(false);
  const [query, setQuery] = useState('');

  useEffect(() => localStorage.setItem('home-meds:medicines', JSON.stringify(medicines)), [medicines]);
  useEffect(() => localStorage.setItem('home-meds:travel', JSON.stringify(travelItems)), [travelItems]);

  const expiring = useMemo(() => medicines.filter((medicine) => daysUntil(medicine.expiry) <= 30).sort((a, b) => a.expiry.localeCompare(b.expiry)), [medicines]);
  const searchResults = useMemo(() => medicines.filter((medicine) => `${medicine.name} ${medicine.category} ${medicine.reason}`.toLowerCase().includes(query.toLowerCase())), [medicines, query]);
  const shopping = useMemo(() => travelItems.filter((item) => item.needBuy), [travelItems]);
  const packedCount = travelItems.filter((item) => item.packed).length;
  const toggleTravel = (id: string, key: 'packed' | 'bought') => setTravelItems((items) => items.map((item) => item.id === id ? { ...item, [key]: !item[key] } : item));
  const nav = (target: Section) => { setSection(target); setQuery(''); };

  const navItems: { id: Section; label: string; icon: typeof Home }[] = [
    { id: 'today', label: 'Сьогодні', icon: Home },
    { id: 'cabinet', label: 'Аптечка', icon: Pill },
    { id: 'travel', label: 'Подорожі', icon: MapPinned },
    { id: 'shopping', label: 'Покупки', icon: ShoppingBasket },
  ];

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><IconLogo /><span>home <b>meds</b></span></div>
      <div className="household"><div className="household-avatar">І</div><div><strong>Сімейна аптечка</strong><small>Ірина та родина</small></div><ChevronRight size={16} /></div>
      <nav>{navItems.map(({ id, label, icon: Icon }) => <button key={id} className={`nav-link ${section === id ? 'active' : ''}`} onClick={() => nav(id)}><Icon size={19} /><span>{label}</span>{id === 'shopping' && shopping.length > 0 && <em>{shopping.length}</em>}</button>)}</nav>
      <div className="sidebar-spacer" />
      <div className="safety-card"><div className="safety-icon"><Stethoscope size={20} /></div><strong>Важливо</strong><p>Завжди звіряйтеся з інструкцією до препарату.</p><button>Дізнатися більше <ArrowUpRight size={14} /></button></div>
      <button className="settings"><Settings size={18} /> Налаштування</button>
    </aside>

    <main className="content">
      <header className="topbar">
        <div className="mobile-brand"><IconLogo /><b>home meds</b></div>
        <div className="search"><Search size={19} /><input value={query} onChange={(event) => { setQuery(event.target.value); if (section !== 'cabinet') setSection('cabinet'); }} placeholder="Пошук у аптечці" /></div>
        <button className="notification"><Bell size={20} /><span>2</span></button>
        <button className="profile">І</button>
      </header>

      {section === 'today' && <TodayPage expiring={expiring} medicines={medicines} travelItems={travelItems} onAddMedicine={() => setMedicineModalOpen(true)} onGoTravel={() => nav('travel')} />}
      {section === 'cabinet' && <CabinetPage medicines={searchResults} query={query} onAdd={() => setMedicineModalOpen(true)} />}
      {section === 'travel' && <TravelPage items={travelItems} packedCount={packedCount} onAdd={() => setTravelModalOpen(true)} onTogglePacked={(id) => toggleTravel(id, 'packed')} onGoShopping={() => nav('shopping')} />}
      {section === 'shopping' && <ShoppingPage items={shopping} onToggleBought={(id) => toggleTravel(id, 'bought')} />}
    </main>
    {medicineModalOpen && <AddMedicineModal onClose={() => setMedicineModalOpen(false)} onSave={(medicine) => setMedicines((items) => [medicine, ...items])} />}
    {travelModalOpen && <AddTravelModal onClose={() => setTravelModalOpen(false)} onSave={(item) => setTravelItems((items) => [...items, item])} />}
  </div>;
}

function TodayPage({ expiring, medicines, travelItems, onAddMedicine, onGoTravel }: { expiring: Medicine[]; medicines: Medicine[]; travelItems: TravelItem[]; onAddMedicine: () => void; onGoTravel: () => void }) {
  const travelReady = travelItems.length ? Math.round((travelItems.filter((item) => item.packed).length / travelItems.length) * 100) : 0;
  return <div className="page fade-in">
    <div className="page-head"><div><p className="eyebrow">НЕДІЛЯ, 14 ВЕРЕСНЯ</p><h1>Доброго дня, Ірино <span>✦</span></h1><p className="subtext">Усе важливе для вашої родини — під рукою.</p></div><button className="primary-button" onClick={onAddMedicine}><CirclePlus size={18} /> Додати ліки</button></div>
    <section className="status-banner"><div className="banner-icon"><AlertTriangle size={22} /></div><div><strong>Є речі, які варто перевірити</strong><p>У 2 препаратів закінчується термін придатності найближчим часом.</p></div><button onClick={() => document.getElementById('expiry-section')?.scrollIntoView({ behavior: 'smooth' })}>Переглянути <ChevronRight size={17} /></button></section>
    <div className="stats-grid"><Stat icon={<Pill />} color="teal" value={medicines.length.toString()} label="позицій в аптечці" /><Stat icon={<AlertTriangle />} color="orange" value={expiring.length.toString()} label="потребують уваги" /><Stat icon={<ShoppingBasket />} color="blue" value={travelItems.filter((item) => item.needBuy && !item.bought).length.toString()} label="потрібно купити" /></div>
    <div className="dashboard-grid">
      <section className="panel expiry-panel" id="expiry-section"><div className="panel-title"><div><p className="eyebrow">АПТЕЧКА</p><h2>Строки придатності</h2></div><button className="text-button">Всі ліки <ChevronRight size={16} /></button></div><div className="medicine-list">{expiring.slice(0, 3).map((medicine) => <MedicineLine key={medicine.id} medicine={medicine} />)}</div></section>
      <section className="trip-card"><div className="trip-map"><MapPin size={20} /><span>ЛИСТОПАД 2026</span></div><p className="eyebrow">НАСТУПНА ПОДОРОЖ</p><h2>Вікенд у Львові</h2><p>3 дні · 2 людини</p><div className="progress-meta"><span>Зібрано {travelReady}%</span><span>{travelItems.filter((item) => item.packed).length}/{travelItems.length} речей</span></div><div className="progress"><i style={{ width: `${travelReady}%` }} /></div><button onClick={onGoTravel}>Відкрити список <ChevronRight size={17} /></button></section>
    </div>
    <section className="panel quick-panel"><div className="panel-title"><div><p className="eyebrow">ШВИДКІ ДІЇ</p><h2>Подбайте про аптечку</h2></div></div><div className="quick-actions"><button onClick={onAddMedicine}><span className="quick-icon green"><Pill /></span><span><b>Додати ліки</b><small>За назвою або фото</small></span><ChevronRight size={17} /></button><button onClick={onGoTravel}><span className="quick-icon purple"><MapPinned /></span><span><b>Зібратися в подорож</b><small>Список речей і покупок</small></span><ChevronRight size={17} /></button><button><span className="quick-icon blue"><ClipboardList /></span><span><b>Перевірити наявність</b><small>Оновити кількість</small></span><ChevronRight size={17} /></button></div></section>
  </div>;
}

function Stat({ icon, color, value, label }: { icon: React.ReactNode; color: string; value: string; label: string }) { return <div className="stat-card"><span className={`stat-icon ${color}`}>{icon}</span><div><strong>{value}</strong><p>{label}</p></div></div>; }

function MedicineLine({ medicine }: { medicine: Medicine }) { const meta = expiryMeta(medicine.expiry); return <div className="medicine-line"><div className="pill-symbol"><Pill size={19} /></div><div className="medicine-copy"><strong>{medicine.name}</strong><small>{medicine.form} · {medicine.quantity} {medicine.unit}</small></div><span className={`status ${meta.tone}`}>{meta.label}</span><button className="dots"><MoreHorizontal size={19} /></button></div>; }

function CabinetPage({ medicines, query, onAdd }: { medicines: Medicine[]; query: string; onAdd: () => void }) { return <div className="page fade-in"><div className="page-head"><div><p className="eyebrow">ВАША КОЛЕКЦІЯ</p><h1>Домашня аптечка</h1><p className="subtext">{query ? `Результати для «${query}»` : 'Ліки, засоби першої допомоги та догляду.'}</p></div><button className="primary-button" onClick={onAdd}><CirclePlus size={18} /> Додати ліки</button></div><div className="filter-row"><button className="filter active">Усі <span>{medicines.length}</span></button><button className="filter">Біль і температура</button><button className="filter">Алергія</button><button className="filter">Травлення</button></div><section className="cabinet-grid">{medicines.map((medicine) => { const meta = expiryMeta(medicine.expiry); return <article className="medicine-card" key={medicine.id}><div className="card-top"><span className="pill-symbol"><Pill size={20} /></span><button className="dots"><MoreHorizontal size={20} /></button></div><p className="category">{medicine.category}</p><h3>{medicine.name}</h3><p className="form">{medicine.form}</p><div className="card-divider" /><div className="card-details"><span>{medicine.quantity} {medicine.unit}</span><span><PackageCheck size={15} /> {medicine.place}</span></div><span className={`status ${meta.tone}`}>{meta.label}</span></article>; })}</section>{medicines.length === 0 && <div className="empty"><Pill size={32} /><h2>Нічого не знайдено</h2><p>Спробуйте інший запит або додайте препарат.</p></div>}</div>; }

function TravelPage({ items, packedCount, onAdd, onTogglePacked, onGoShopping }: { items: TravelItem[]; packedCount: number; onAdd: () => void; onTogglePacked: (id: string) => void; onGoShopping: () => void }) { const buying = items.filter((item) => item.needBuy && !item.bought).length; return <div className="page fade-in"><div className="page-head"><div><p className="eyebrow">ПЛАНУВАЛЬНИК</p><h1>Подорожі</h1><p className="subtext">Збирайтеся спокійно: усе потрібне в одному списку.</p></div><button className="primary-button" onClick={onAdd}><CirclePlus size={18} /> Додати пункт</button></div><section className="travel-hero"><div><div className="hero-label"><MapPinned size={17} /> НАСТУПНА ПОДОРОЖ</div><h2>Вікенд у Львові</h2><p>20–23 листопада · 3 дні · Ірина та Олег</p><div className="hero-chips"><span><PackageCheck size={15} /> {packedCount}/{items.length} зібрано</span><button onClick={onGoShopping}><ShoppingBasket size={15} /> {buying} купити</button></div></div><div className="travel-art"><span>✦</span><span>◌</span><span>✧</span></div></section><div className="travel-layout"><section className="panel packing-panel"><div className="panel-title"><div><p className="eyebrow">ЧЕКЛІСТ</p><h2>Що взяти з собою</h2></div><span className="completion">{packedCount} з {items.length}</span></div><div className="packing-list">{items.map((item) => <div className={`packing-item ${item.packed ? 'packed' : ''}`} key={item.id}><button className={`check ${item.packed ? 'checked' : ''}`} onClick={() => onTogglePacked(item.id)} aria-label="Позначити як зібране">{item.packed && <Check size={14} />}</button><div><span className="item-category">{item.category}</span><strong>{item.title}</strong><small>{item.note}</small></div>{item.inCabinet && <span className="cabinet-tag">Є вдома</span>}{item.needBuy && !item.bought && <span className="buy-tag">Купити</span>}</div>)}</div></section><aside className="travel-side"><section className="panel"><p className="eyebrow">РОЗУМНИЙ СПИСОК</p><h2>Аптечка в дорогу</h2><p className="side-copy">Додайте лише те, що знадобиться саме вам, і перевірте строки придатності.</p><button className="outline-button" onClick={onAdd}><Sparkles size={17} /> Додати рекомендацію</button></section><section className="tip"><AlertTriangle size={19} /><p><b>Перед виїздом</b>Переконайтеся, що ліки зберігаються в оригінальній упаковці.</p></section></aside></div></div>; }

function ShoppingPage({ items, onToggleBought }: { items: TravelItem[]; onToggleBought: (id: string) => void }) { const open = items.filter((item) => !item.bought).length; return <div className="page fade-in"><div className="page-head"><div><p className="eyebrow">ДО ПОДОРОЖІ</p><h1>Список покупок</h1><p className="subtext">{open ? `Ще ${open} ${open === 1 ? 'покупка' : 'покупки'} до подорожі у Львів.` : 'Усе куплено — чудово!'}</p></div><button className="outline-button"><ClipboardList size={18} /> Поділитися</button></div><section className="panel shopping-panel"><div className="shopping-heading"><div><span className="shopping-number">{open}</span><div><h2>Потрібно купити</h2><p>Зібрано зі списку подорожі</p></div></div><ShoppingBasket size={25} /></div><div className="shopping-list">{items.map((item) => <div className={`shopping-item ${item.bought ? 'bought' : ''}`} key={item.id}><button className={`check ${item.bought ? 'checked' : ''}`} onClick={() => onToggleBought(item.id)}>{item.bought && <Check size={14} />}</button><div><strong>{item.title}</strong><small>{item.category} · {item.note}</small></div><button className="dots"><MoreHorizontal size={20} /></button></div>)}</div></section></div>; }
