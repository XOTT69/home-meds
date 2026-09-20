import {
  AlertTriangle,
  CalendarClock,
  Camera,
  Check,
  ClipboardList,
  Edit3,
  FileDown,
  ImageIcon,
  MapPinned,
  Pill,
  Plus,
  Search,
  ShieldAlert,
  ShoppingBasket,
  Trash2,
  UserRound,
  X,
  type LucideIcon,
} from 'lucide-react';
import type { User } from '@supabase/supabase-js';
import { type FormEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AuthScreen } from './AuthScreen';
import { FamilyPanel } from './FamilyPanel';
import { MedicinePhotoUploader } from './MedicineMedia';
import { HouseholdSharingPanel, type HouseholdAccessState } from './components/HouseholdSharingPanel';
import { ActivityPanel } from './components/ActivityPanel';
import { NotificationSettings } from './components/NotificationSettings';
import { isSupabaseConfigured, supabase } from './lib/supabase';
import { lookupMedicineByBarcode, lookupMedicineByName, lookupMedicineByText, recognizePackageText, type MedicineLookup } from './lib/medicineLookup';

type MedicineShoppingStatus = 'pending' | 'done';
type MedicineQuantityUnit = 'packages' | 'tablets' | 'capsules' | 'millilitres' | 'pieces' | 'other';

type Med = {
  id: string;
  name: string;
  category: string;
  quantity: number;
  minimumQuantity: number;
  quantityUnit: MedicineQuantityUnit;
  place: string;
  expiry: string;
  barcode?: string;
  photoPath?: string;
  activeIngredient: string;
  dosage: string;
  instructions: string;
  warnings: string;
  memberIds: string[];
  notes: string;
  shoppingStatus?: MedicineShoppingStatus;
  purchaseDoneAt?: string;
};

type Trip = {
  id: string;
  title: string;
  destination: string;
  starts_on: string | null;
  ends_on: string | null;
  travellers: string;
  notes: string;
  template: TripTemplate;
};

type TripTemplate = 'custom' | 'city' | 'sea' | 'road' | 'child';

type TripItem = {
  id: string;
  tripId: string;
  title: string;
  category: string;
  note: string;
  inCabinet: boolean;
  packed: boolean;
  needBuy: boolean;
  bought: boolean;
  sourceMedicineId?: string;
};

type ManualShoppingItem = {
  id: string;
  title: string;
  quantity: string;
  note: string;
  done: boolean;
};

type Profile = {
  user_id: string;
  display_name: string;
  household_name: string;
};

type FamilyMember = {
  id: string;
  name: string;
  relation: string;
  allergies: string;
  notes: string;
};

type StoredItem = {
  id: string;
  kind: string;
  payload: unknown;
};

const createId = () => crypto.randomUUID();
const newMedicine = (): Med => ({
  id: createId(),
  name: '',
  category: 'Інше',
  quantity: 1,
  minimumQuantity: 0,
  quantityUnit: 'packages',
  place: 'Домашня аптечка',
  expiry: '',
  memberIds: [],
  notes: '',
  activeIngredient: '',
  dosage: '',
  instructions: '',
  warnings: '',
});
const newTrip = (): Trip => ({
  id: createId(),
  title: '',
  destination: '',
  starts_on: null,
  ends_on: null,
  travellers: '',
  notes: '',
  template: 'custom',
});
const newTripItem = (tripId: string): TripItem => ({
  id: createId(),
  tripId,
  title: '',
  category: 'Аптечка',
  note: '',
  inCabinet: false,
  packed: false,
  needBuy: false,
  bought: false,
});
const newManualShoppingItem = (): ManualShoppingItem => ({
  id: createId(),
  title: '',
  quantity: '',
  note: '',
  done: false,
});

const tripTemplates: Record<TripTemplate, { label: string; hint: string; items: Array<{ title: string; category: string; note: string }> }> = {
  custom: { label: 'Свій список', hint: 'Почніть із чистого чекліста.', items: [] },
  city: { label: 'Вікенд у місті', hint: 'Базове для короткої міської подорожі.', items: [
    { title: 'Особисті ліки', category: 'Аптечка', note: 'Перевірити кількість на дні поїздки' },
    { title: 'Пластирі', category: 'Аптечка', note: '' },
    { title: 'Зарядний пристрій', category: 'Речі', note: '' },
  ] },
  sea: { label: 'Море', hint: 'Базовий список для сонця й дороги.', items: [
    { title: 'Особисті ліки', category: 'Аптечка', note: '' },
    { title: 'Засіб SPF', category: 'Догляд', note: 'Підібрати під шкіру' },
    { title: 'Засіб після сонця', category: 'Догляд', note: '' },
    { title: 'Пляшка води в дорогу', category: 'Речі', note: '' },
  ] },
  road: { label: 'Авто / дорога', hint: 'Найнеобхідніше в дорогу.', items: [
    { title: 'Особисті ліки', category: 'Аптечка', note: '' },
    { title: 'Аптечка автомобіля', category: 'Безпека', note: 'Перевірити комплектність' },
    { title: 'Вода', category: 'Речі', note: '' },
    { title: 'Документи', category: 'Документи', note: '' },
  ] },
  child: { label: 'З дитиною', hint: 'Нагадування для сімейної поїздки.', items: [
    { title: 'Особисті ліки дитини', category: 'Аптечка', note: 'Звірити з призначенням лікаря' },
    { title: 'Термометр', category: 'Аптечка', note: '' },
    { title: 'Вода та перекус', category: 'Речі', note: '' },
    { title: 'Контакти лікаря / страховка', category: 'Документи', note: '' },
  ] },
};
const navigation: Array<{ id: 'meds' | 'trips' | 'profile'; label: string; Icon: LucideIcon }> = [
  { id: 'meds', label: 'Аптечка', Icon: Pill },
  { id: 'trips', label: 'Подорожі', Icon: MapPinned },
  { id: 'profile', label: 'Профіль', Icon: UserRound },
];

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function numberValue(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : fallback;
}

function booleanValue(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

const quantityUnitOptions: Array<{ value: MedicineQuantityUnit; label: string; short: string }> = [
  { value: 'packages', label: 'Пачки', short: 'пач.' },
  { value: 'tablets', label: 'Таблетки', short: 'табл.' },
  { value: 'capsules', label: 'Капсули', short: 'капс.' },
  { value: 'millilitres', label: 'Мілілітри', short: 'мл' },
  { value: 'pieces', label: 'Штуки', short: 'шт.' },
  { value: 'other', label: 'Інше', short: 'од.' },
];

function quantityUnitShort(unit: MedicineQuantityUnit): string {
  return quantityUnitOptions.find((option) => option.value === unit)?.short ?? 'од.';
}

function formatMedicineQuantity(value: number, unit: MedicineQuantityUnit): string {
  return `${new Intl.NumberFormat('uk-UA', { maximumFractionDigits: 2 }).format(value)} ${quantityUnitShort(unit)}`;
}

function QuantityStepper({
  label,
  value,
  unit,
  onChange,
  onUnitChange,
  hint,
}: {
  label: string;
  value: number;
  unit: MedicineQuantityUnit;
  onChange: (value: number) => void;
  onUnitChange?: (unit: MedicineQuantityUnit) => void;
  hint?: string;
}) {
  const step = unit === 'millilitres' ? 10 : 1;
  return <div className="form-field quantity-field">
    <span>{label}</span>
    <div className="quantity-control">
      <button aria-label={`Зменшити: ${label}`} disabled={value <= 0} onClick={() => onChange(Math.max(0, value - step))} type="button">−</button>
      <input aria-label={label} inputMode="decimal" min="0" step={unit === 'millilitres' ? '1' : '0.5'} type="number" value={value} onChange={(event) => onChange(numberValue(event.target.value))} />
      <button aria-label={`Збільшити: ${label}`} onClick={() => onChange(value + step)} type="button">+</button>
      {onUnitChange ? <select aria-label="Одиниця обліку" value={unit} onChange={(event) => onUnitChange(event.target.value as MedicineQuantityUnit)}>
        {quantityUnitOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select> : <span className="quantity-unit-label">{quantityUnitShort(unit)}</span>}
    </div>
    {hint && <small>{hint}</small>}
  </div>;
}

function normalizeMedicine(payload: unknown, fallbackId: string): Med {
  const data = asRecord(payload);
  const memberIds = Array.isArray(data.memberIds)
    ? data.memberIds.filter((id): id is string => typeof id === 'string')
    : [];
  const shoppingStatus = data.shoppingStatus === 'done' || data.shoppingStatus === 'pending'
    ? data.shoppingStatus
    : undefined;
  const quantityUnit = ['packages', 'tablets', 'capsules', 'millilitres', 'pieces', 'other'].includes(stringValue(data.quantityUnit))
    ? stringValue(data.quantityUnit) as MedicineQuantityUnit
    : 'packages';

  return {
    id: stringValue(data.id, fallbackId),
    name: stringValue(data.name),
    category: stringValue(data.category, 'Інше'),
    quantity: numberValue(data.quantity, 1),
    minimumQuantity: numberValue(data.minimumQuantity ?? data.minQuantity),
    quantityUnit,
    place: stringValue(data.place, 'Домашня аптечка'),
    expiry: stringValue(data.expiry),
    barcode: stringValue(data.barcode) || undefined,
    photoPath: stringValue(data.photoPath) || undefined,
    activeIngredient: stringValue(data.activeIngredient),
    dosage: stringValue(data.dosage),
    instructions: stringValue(data.instructions),
    warnings: stringValue(data.warnings),
    memberIds,
    notes: stringValue(data.notes),
    shoppingStatus,
    purchaseDoneAt: stringValue(data.purchaseDoneAt) || undefined,
  };
}

function normalizeTripItem(payload: unknown, fallbackId: string): TripItem {
  const data = asRecord(payload);
  return {
    id: stringValue(data.id, fallbackId),
    tripId: stringValue(data.tripId),
    title: stringValue(data.title),
    category: stringValue(data.category, 'Аптечка'),
    note: stringValue(data.note),
    inCabinet: booleanValue(data.inCabinet),
    packed: booleanValue(data.packed),
    needBuy: booleanValue(data.needBuy),
    bought: booleanValue(data.bought),
    sourceMedicineId: stringValue(data.sourceMedicineId) || undefined,
  };
}

function normalizeManualShoppingItem(payload: unknown, fallbackId: string): ManualShoppingItem {
  const data = asRecord(payload);
  return {
    id: stringValue(data.id, fallbackId),
    title: stringValue(data.title),
    quantity: stringValue(data.quantity),
    note: stringValue(data.note),
    done: booleanValue(data.done),
  };
}

function isLowStock(medicine: Med): boolean {
  return medicine.minimumQuantity > 0 && medicine.quantity <= medicine.minimumQuantity;
}

function daysUntilExpiry(value: string): number | null {
  if (!value) return null;
  const matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!matched) return null;
  const target = new Date(Number(matched[1]), Number(matched[2]) - 1, Number(matched[3]));
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((target.getTime() - today.getTime()) / 86_400_000);
}

function expiryLabel(value: string): string {
  const days = daysUntilExpiry(value);
  if (days === null) return 'Термін не вказано';
  if (days < 0) return 'Термін минув';
  if (days === 0) return 'Спливає сьогодні';
  if (days === 1) return 'Спливає завтра';
  return 'До терміну ' + days + ' дн.';
}

function errorText(error: unknown, fallback: string): string {
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') {
    return error.message;
  }
  return fallback;
}

function householdAccessFromRpc(value: unknown): HouseholdAccessState | null {
  const root = Array.isArray(value) ? asRecord(value[0]) : asRecord(value);
  const embedded = asRecord(root.household) ?? asRecord(root.data) ?? root;
  const householdId = stringValue(embedded.household_id ?? embedded.id ?? root.household_id ?? root.id);
  const ownerUserId = stringValue(
    embedded.owner_user_id ?? embedded.owner_id ?? root.owner_user_id ?? root.owner_id,
  );
  if (!householdId || !ownerUserId) return null;

  const rawRole = stringValue(embedded.current_role ?? embedded.role ?? root.current_role ?? root.role).toLowerCase();
  return {
    household_id: householdId,
    owner_user_id: ownerUserId,
    role: rawRole === 'owner' ? 'owner' : rawRole === 'viewer' ? 'viewer' : 'editor',
    invite_code: stringValue(embedded.invite_code ?? root.invite_code) || null,
    household_name: stringValue(
      embedded.household_name ?? embedded.name ?? root.household_name ?? root.name,
    ),
  };
}

function householdMigrationIsMissing(error: unknown): boolean {
  const record = asRecord(error);
  const code = stringValue(record.code);
  const message = errorText(error, '').toLowerCase();
  return code === 'PGRST202'
    || (message.includes('home_meds_get_household')
      && (message.includes('could not find') || message.includes('does not exist') || message.includes('schema cache')));
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <label className="form-field">
    <span>{label}</span>
    {children}
    {hint && <small>{hint}</small>}
  </label>;
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [onClose]);

  return <div className="modal-backdrop" onMouseDown={onClose}>
    <section aria-modal="true" aria-label={title} className="modal roomy-modal" role="dialog" onMouseDown={(event) => event.stopPropagation()}>
      <div className="modal-head">
        <h2>{title}</h2>
        <button aria-label="Закрити" className="icon-button" onClick={onClose} type="button"><X /></button>
      </div>
      {children}
    </section>
  </div>;
}

function MedicinePhoto({ path, name }: { path?: string; name: string }) {
  const [url, setUrl] = useState('');

  useEffect(() => {
    let disposed = false;
    if (!path) {
      setUrl('');
      return undefined;
    }

    void supabase!.storage.from('home-meds-photos').createSignedUrl(path, 60 * 60).then(({ data }) => {
      if (!disposed) setUrl(data?.signedUrl ?? '');
    });
    return () => {
      disposed = true;
    };
  }, [path]);

  if (!path || !url) {
    return <span aria-hidden="true" className="medicine-photo-placeholder"><ImageIcon size={20} /></span>;
  }
  return <img alt={'Упаковка: ' + name} className="medicine-photo" src={url} />;
}

function MedicineEditor({
  value,
  members,
  userId,
  onSave,
  onClose,
}: {
  value: Med;
  members: FamilyMember[];
  userId: string;
  onSave: (medicine: Med) => Promise<boolean>;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const [scanMessage, setScanMessage] = useState('');
  const [scanProgress, setScanProgress] = useState<number | null>(null);
  const [recognizedText, setRecognizedText] = useState('');
  const [nameLookupBusy, setNameLookupBusy] = useState(false);
  const scanInput = useRef<HTMLInputElement>(null);
  const packageScanInput = useRef<HTMLInputElement>(null);

  const setValue = <Key extends keyof Med>(key: Key, nextValue: Med[Key]) => {
    setDraft((current) => ({ ...current, [key]: nextValue }));
  };

  const toggleMember = (memberId: string) => {
    setDraft((current) => ({
      ...current,
      memberIds: current.memberIds.includes(memberId)
        ? current.memberIds.filter((id) => id !== memberId)
        : [...current.memberIds, memberId],
    }));
  };

  const applyLookup = (lookup: MedicineLookup, origin: 'barcode' | 'photo' | 'name') => {
    setDraft((current) => ({
      ...current,
      name: lookup.name || current.name,
      category: lookup.category || current.category,
      activeIngredient: lookup.activeIngredient || current.activeIngredient,
      dosage: lookup.dosage || current.dosage,
      instructions: lookup.instructions || current.instructions,
      warnings: lookup.warnings || current.warnings,
    }));
    if (origin === 'name') {
      setScanMessage(lookup.confidence === 'exact'
        ? 'Дані знайдено за назвою й підставлено. Перевірте їх за упаковкою або офіційною інструкцією.'
        : 'Знайдено ймовірний збіг за назвою. Перевірте препарат і дозування перед збереженням.');
    } else if (origin === 'barcode') {
      setScanMessage(lookup.instructions || lookup.warnings
        ? 'Ліки знайдено за штрихкодом. Дані з довідника підставлено — перевірте їх за упаковкою.'
        : 'Ліки знайдено за штрихкодом. Перевірте назву й дозування за упаковкою.');
    } else {
      setScanMessage('З фото знайдено ймовірну назву. Будь ласка, перевірте збіг перед збереженням.');
    }
  };

  const scanBarcode = async (file?: File) => {
    if (!file) return;
    type Detector = { detect: (image: ImageBitmap) => Promise<Array<{ rawValue?: string }>> };
    type DetectorConstructor = new (options: { formats: string[] }) => Detector;
    const BarcodeDetector = (window as unknown as { BarcodeDetector?: DetectorConstructor }).BarcodeDetector;
    if (!BarcodeDetector) {
      setScanMessage('Сканування штрихкоду недоступне в цьому браузері. Додайте код вручну.');
      return;
    }

    try {
      const bitmap = await createImageBitmap(file);
      try {
        const detector = new BarcodeDetector({ formats: ['ean_13', 'ean_8', 'code_128', 'qr_code'] });
        const result = await detector.detect(bitmap);
        const barcode = result[0]?.rawValue;
        if (barcode) {
          setValue('barcode', barcode);
          setScanMessage('Штрихкод розпізнано. Шукаємо дані про ліки…');
          const lookup = await lookupMedicineByBarcode(barcode);
          if (lookup) applyLookup(lookup, 'barcode');
          else setScanMessage('Штрихкод розпізнано: ' + barcode + '. У безкоштовному довіднику даних не знайдено — можна спробувати фото упаковки або заповнити картку вручну.');
        } else {
          setScanMessage('Штрихкод на фото не знайдено. Спробуйте зробити чіткіше фото.');
        }
      } finally {
        bitmap.close();
      }
    } catch {
      setScanMessage('Фото не вдалося прочитати. Спробуйте інше зображення.');
    }
  };

  const scanPackage = async (file?: File) => {
    if (!file) return;
    setScanMessage('Читаємо текст із фото упаковки…');
    setScanProgress(0);
    setRecognizedText('');
    try {
      const text = await recognizePackageText(file, setScanProgress);
      setRecognizedText(text);
      if (!text) {
        setScanMessage('Текст на фото не розпізнано. Зробіть фото при хорошому світлі, без відблисків.');
        return;
      }
      setScanMessage('Шукаємо назву серед розпізнаного тексту…');
      const lookup = await lookupMedicineByText(text);
      if (lookup) applyLookup(lookup, 'photo');
      else setScanMessage('Текст з упаковки прочитано, але точного кандидата не знайдено. Перевірте назву вручну.');
    } catch {
      setScanMessage('Не вдалося прочитати фото. Спробуйте чіткіше фото лицьової сторони упаковки.');
    } finally {
      setScanProgress(null);
    }
  };

  const searchByName = async () => {
    const name = draft.name.trim();
    if (name.length < 3) {
      setScanMessage('Введіть щонайменше 3 символи назви препарату.');
      return;
    }
    setNameLookupBusy(true);
    setScanMessage('Шукаємо препарат за назвою…');
    try {
      const lookup = await lookupMedicineByName(name);
      if (lookup) applyLookup(lookup, 'name');
      else setScanMessage('У відкритих довідниках нічого не знайдено. Перевірте написання або спробуйте штрихкод чи фото упаковки.');
    } finally {
      setNameLookupBusy(false);
    }
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    try {
      if (await onSave(draft)) onClose();
    } finally {
      setSaving(false);
    }
  };

  return <Modal onClose={onClose} title={value.name ? 'Редагувати ліки' : 'Додати ліки'}>
    <form className="form-grid medicine-editor" onSubmit={(event) => void submit(event)}>
      <div className="form-two-columns">
        <div className="form-field">
          <span>Назва</span>
          <div className="name-lookup-row">
            <input
              aria-label="Назва ліків"
              autoFocus
              disabled={nameLookupBusy}
              required
              value={draft.name}
              onChange={(event) => setValue('name', event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void searchByName();
                }
              }}
            />
            <button className="outline-button" disabled={nameLookupBusy || draft.name.trim().length < 3} onClick={() => void searchByName()} type="button">{nameLookupBusy ? 'Шукаємо…' : 'Підтягнути дані'}</button>
          </div>
          <small>Введіть назву й натисніть Enter або «Підтягнути дані».</small>
        </div>
        <Field label="Категорія">
          <input value={draft.category} onChange={(event) => setValue('category', event.target.value)} placeholder="Наприклад, від застуди" />
        </Field>
        <QuantityStepper label="Залишок" value={draft.quantity} unit={draft.quantityUnit} onChange={(quantity) => setValue('quantity', quantity)} onUnitChange={(unit) => setValue('quantityUnit', unit)} hint="Оберіть, що рахуєте: пачки, таблетки, капсули, мл або штуки." />
        <QuantityStepper label="Мінімальний запас" value={draft.minimumQuantity} unit={draft.quantityUnit} onChange={(minimumQuantity) => setValue('minimumQuantity', minimumQuantity)} hint="Коли залишок досягне цього числа, позиція з’явиться в покупках. 0 — вимкнено." />
        <Field label="Де лежить">
          <input value={draft.place} onChange={(event) => setValue('place', event.target.value)} />
        </Field>
        <Field label="Термін придатності">
          <input type="date" value={draft.expiry} onChange={(event) => setValue('expiry', event.target.value)} />
        </Field>
      </div>
      <Field label="Для кого підходить" hint="Це довідкова позначка, а не медична рекомендація.">
        {members.length ? <div className="member-checkboxes">
          {members.map((member) => <label className="member-checkbox" key={member.id}>
            <input checked={draft.memberIds.includes(member.id)} onChange={() => toggleMember(member.id)} type="checkbox" />
            <span>{member.name}</span>
          </label>)}
        </div> : <p className="form-hint">Додайте людей у «Профілі», щоб позначати, кому підходять ліки.</p>}
      </Field>
      <Field label="Нотатка">
        <textarea value={draft.notes} onChange={(event) => setValue('notes', event.target.value)} placeholder="Наприклад, спосіб зберігання або важлива примітка" rows={3} />
      </Field>
      <div className="form-two-columns">
        <Field label="Активна речовина" hint="Необов’язково — перепишіть з упаковки.">
          <input value={draft.activeIngredient} onChange={(event) => setValue('activeIngredient', event.target.value)} placeholder="Наприклад, ібупрофен" />
        </Field>
        <Field label="Дозування" hint="Не замінює призначення лікаря.">
          <input value={draft.dosage} onChange={(event) => setValue('dosage', event.target.value)} placeholder="Наприклад, 200 мг" />
        </Field>
      </div>
      <Field label="Як застосовувати" hint="Збережіть лише перевірену для вашої родини примітку або посилання на інструкцію.">
        <textarea value={draft.instructions} onChange={(event) => setValue('instructions', event.target.value)} placeholder="Наприклад, за призначенням лікаря" rows={2} />
      </Field>
      <Field label="Важливі застереження" hint="Не визначає сумісність автоматично — перевіряйте інструкцію та порадьтеся з лікарем або фармацевтом.">
        <textarea value={draft.warnings} onChange={(event) => setValue('warnings', event.target.value)} placeholder="Алергії, протипоказання, умови зберігання" rows={2} />
      </Field>
      <div className="medicine-media-tools">
        <MedicinePhotoUploader userId={userId} value={draft.photoPath} onChange={(photoPath) => setValue('photoPath', photoPath)} />
        <input
          accept="image/*"
          capture="environment"
          className="visually-hidden"
          onChange={(event) => void scanBarcode(event.target.files?.[0])}
          ref={scanInput}
          type="file"
        />
        <button className="outline-button" onClick={() => scanInput.current?.click()} type="button"><Camera size={16} /> Сканувати штрихкод</button>
        <input
          accept="image/*"
          capture="environment"
          className="visually-hidden"
          onChange={(event) => void scanPackage(event.target.files?.[0])}
          ref={packageScanInput}
          type="file"
        />
        <button className="outline-button" disabled={scanProgress !== null} onClick={() => packageScanInput.current?.click()} type="button"><ImageIcon size={16} /> {scanProgress === null ? 'Розпізнати упаковку' : `Розпізнаємо ${scanProgress}%`}</button>
      </div>
      <Field label="Штрихкод" hint="Необов’язково — заповнюється після сканування або вручну.">
        <input value={draft.barcode ?? ''} onChange={(event) => setValue('barcode', event.target.value || undefined)} />
      </Field>
      {scanMessage && <p className="form-hint" role="status">{scanMessage}</p>}
      {recognizedText && <details className="recognized-text"><summary>Розпізнаний текст з упаковки</summary><p>{recognizedText}</p></details>}
      <button className="primary-button full" disabled={saving} type="submit">{saving ? 'Зберігаємо…' : 'Зберегти ліки'}</button>
    </form>
  </Modal>;
}

function TripEditor({
  value,
  onSave,
  onClose,
}: {
  value: Trip;
  onSave: (trip: Trip) => Promise<boolean>;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const [validation, setValidation] = useState('');
  const setValue = <Key extends keyof Trip>(key: Key, nextValue: Trip[Key]) => setDraft((current) => ({ ...current, [key]: nextValue }));

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (draft.starts_on && draft.ends_on && draft.ends_on < draft.starts_on) {
      setValidation('Дата завершення не може бути раніше за дату початку.');
      return;
    }
    setSaving(true);
    try {
      if (await onSave(draft)) onClose();
    } finally {
      setSaving(false);
    }
  };

  return <Modal onClose={onClose} title={value.title ? 'Редагувати подорож' : 'Нова подорож'}>
    <form className="form-grid" onSubmit={(event) => void submit(event)}>
      <Field label="Назва">
        <input autoFocus required value={draft.title} onChange={(event) => setValue('title', event.target.value)} placeholder="Наприклад, Вікенд у Львові" />
      </Field>
      <Field label="Куди">
        <input value={draft.destination} onChange={(event) => setValue('destination', event.target.value)} placeholder="Місто або країна" />
      </Field>
      <div className="form-two-columns">
        <Field label="Початок">
          <input type="date" value={draft.starts_on ?? ''} onChange={(event) => setValue('starts_on', event.target.value || null)} />
        </Field>
        <Field label="Кінець">
          <input min={draft.starts_on ?? undefined} type="date" value={draft.ends_on ?? ''} onChange={(event) => setValue('ends_on', event.target.value || null)} />
        </Field>
      </div>
      <Field label="Учасники">
        <input value={draft.travellers} onChange={(event) => setValue('travellers', event.target.value)} placeholder="Наприклад, Антон і Марія" />
      </Field>
      <Field label="Нотатка">
        <textarea rows={3} value={draft.notes} onChange={(event) => setValue('notes', event.target.value)} placeholder="Бронювання, важливі справи, нюанси" />
      </Field>
      {!value.title && <Field label="Шаблон чекліста" hint={tripTemplates[draft.template].hint}>
        <select value={draft.template} onChange={(event) => setValue('template', event.target.value as TripTemplate)}>
          {Object.entries(tripTemplates).map(([id, template]) => <option key={id} value={id}>{template.label}</option>)}
        </select>
      </Field>}
      {validation && <p className="form-hint form-error">{validation}</p>}
      <button className="primary-button full" disabled={saving} type="submit">{saving ? 'Зберігаємо…' : 'Зберегти подорож'}</button>
    </form>
  </Modal>;
}

function TripItemEditor({
  value,
  onSave,
  onClose,
}: {
  value: TripItem;
  onSave: (item: TripItem) => Promise<boolean>;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const setValue = <Key extends keyof TripItem>(key: Key, nextValue: TripItem[Key]) => setDraft((current) => ({ ...current, [key]: nextValue }));

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    try {
      if (await onSave(draft)) onClose();
    } finally {
      setSaving(false);
    }
  };

  return <Modal onClose={onClose} title={value.title ? 'Редагувати пункт' : 'Додати до чекліста'}>
    <form className="form-grid" onSubmit={(event) => void submit(event)}>
      <Field label="Що взяти">
        <input autoFocus required value={draft.title} onChange={(event) => setValue('title', event.target.value)} />
      </Field>
      <Field label="Категорія">
        <input value={draft.category} onChange={(event) => setValue('category', event.target.value)} />
      </Field>
      <Field label="Примітка">
        <input value={draft.note} onChange={(event) => setValue('note', event.target.value)} />
      </Field>
      <label className="toggle-line"><input checked={draft.inCabinet} onChange={(event) => setValue('inCabinet', event.target.checked)} type="checkbox" /> Є вдома</label>
      <label className="toggle-line"><input checked={draft.needBuy} onChange={(event) => setValue('needBuy', event.target.checked)} type="checkbox" /> Потрібно купити</label>
      <button className="primary-button full" disabled={saving} type="submit">{saving ? 'Зберігаємо…' : 'Зберегти пункт'}</button>
    </form>
  </Modal>;
}

function ManualShoppingEditor({
  value,
  onSave,
  onClose,
}: {
  value: ManualShoppingItem;
  onSave: (item: ManualShoppingItem) => Promise<boolean>;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    try {
      if (await onSave(draft)) onClose();
    } finally {
      setSaving(false);
    }
  };

  return <Modal onClose={onClose} title="Редагувати покупку">
    <form className="form-grid" onSubmit={(event) => void submit(event)}>
      <Field label="Що купити">
        <input autoFocus required value={draft.title} onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))} />
      </Field>
      <div className="form-two-columns">
        <Field label="Кількість">
          <input value={draft.quantity} onChange={(event) => setDraft((current) => ({ ...current, quantity: event.target.value }))} placeholder="Наприклад, 2 упаковки" />
        </Field>
        <Field label="Статус">
          <select value={draft.done ? 'done' : 'pending'} onChange={(event) => setDraft((current) => ({ ...current, done: event.target.value === 'done' }))}>
            <option value="pending">Потрібно купити</option>
            <option value="done">Куплено</option>
          </select>
        </Field>
      </div>
      <Field label="Нотатка">
        <textarea rows={3} value={draft.note} onChange={(event) => setDraft((current) => ({ ...current, note: event.target.value }))} placeholder="Магазин, бренд, важливі деталі" />
      </Field>
      <button className="primary-button full" disabled={saving} type="submit">{saving ? 'Зберігаємо…' : 'Зберегти покупку'}</button>
    </form>
  </Modal>;
}

function AddMedicineToTrip({
  medicine,
  trips,
  onAdd,
  onClose,
}: {
  medicine: Med;
  trips: Trip[];
  onAdd: (item: TripItem) => Promise<boolean>;
  onClose: () => void;
}) {
  const [tripId, setTripId] = useState(trips[0]?.id ?? '');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!tripId) return;
    setSaving(true);
    const item: TripItem = {
      ...newTripItem(tripId),
      title: medicine.name,
      category: medicine.category || 'Аптечка',
      note: note || ('З аптечки: ' + medicine.place),
      inCabinet: true,
      sourceMedicineId: medicine.id,
    };
    try {
      if (await onAdd(item)) onClose();
    } finally {
      setSaving(false);
    }
  };

  return <Modal onClose={onClose} title={'Взяти в подорож: ' + medicine.name}>
    {trips.length ? <form className="form-grid" onSubmit={(event) => void submit(event)}>
      <Field label="Подорож">
        <select value={tripId} onChange={(event) => setTripId(event.target.value)}>
          {trips.map((trip) => <option key={trip.id} value={trip.id}>{trip.title}</option>)}
        </select>
      </Field>
      <Field label="Нотатка для списку">
        <input value={note} onChange={(event) => setNote(event.target.value)} placeholder={'За замовчуванням: ' + medicine.place} />
      </Field>
      <button className="primary-button full" disabled={saving} type="submit">{saving ? 'Додаємо…' : 'Додати до чекліста'}</button>
    </form> : <div className="empty-modal">
      <p>Спочатку створіть подорож — тоді це можна буде додати до її чекліста одним натисканням.</p>
      <button className="outline-button" onClick={onClose} type="button">Зрозуміло</button>
    </div>}
  </Modal>;
}

function Workspace({ user }: { user: User }) {
  const [tab, setTab] = useState<'meds' | 'trips' | 'profile'>('meds');
  const [medicines, setMedicines] = useState<Med[]>([]);
  const [trips, setTrips] = useState<Trip[]>([]);
  const [tripItems, setTripItems] = useState<TripItem[]>([]);
  const [manualPurchases, setManualPurchases] = useState<ManualShoppingItem[]>([]);
  const [manualPurchaseDraft, setManualPurchaseDraft] = useState(newManualShoppingItem);
  const [members, setMembers] = useState<FamilyMember[]>([]);
  const [profile, setProfile] = useState<Profile>({ user_id: user.id, display_name: '', household_name: 'Моя аптечка' });
  const [activeTripId, setActiveTripId] = useState('');
  const [modal, setModal] = useState<ReactNode>(null);
  const [loading, setLoading] = useState(true);
  const [syncError, setSyncError] = useState('');
  const [householdAccess, setHouseholdAccess] = useState<HouseholdAccessState | null>(null);
  const [sharingAvailable, setSharingAvailable] = useState<boolean | null>(null);
  const [medicineQuery, setMedicineQuery] = useState('');
  const [medicineFilter, setMedicineFilter] = useState<'all' | 'low' | 'expiry' | 'purchases'>('all');

  const reportError = useCallback((message: string) => setSyncError(message), []);
  const dataOwnerId = householdAccess?.owner_user_id ?? user.id;
  const canEdit = householdAccess?.role !== 'viewer';

  const load = useCallback(async ({ background = false }: { background?: boolean } = {}) => {
    if (!background) setLoading(true);
    const client = supabase!;
    try {
      const { data: householdData, error: householdError } = await client.rpc('home_meds_get_household');
      let nextHousehold: HouseholdAccessState | null = null;
      let nextDataOwnerId = user.id;

      if (householdError) {
        if (householdMigrationIsMissing(householdError)) {
          setSharingAvailable(false);
        } else {
          setSharingAvailable(null);
          reportError('Не вдалося перевірити спільний доступ: ' + errorText(householdError, 'спробуйте оновити сторінку.'));
          return;
        }
      } else {
        setSharingAvailable(true);
        nextHousehold = householdAccessFromRpc(householdData);
        nextDataOwnerId = nextHousehold?.owner_user_id ?? user.id;
      }
      setHouseholdAccess(nextHousehold);

      const [itemsResult, tripsResult, profileResult, membersResult] = await Promise.all([
        client.from('home_meds_items').select('id, kind, payload').eq('user_id', nextDataOwnerId).order('created_at', { ascending: false }),
        client.from('home_meds_trips').select('*').eq('user_id', nextDataOwnerId).order('starts_on', { ascending: true, nullsFirst: false }),
        client.from('home_meds_profiles').select('*').eq('user_id', user.id).maybeSingle(),
        client.from('home_meds_members').select('*').eq('user_id', nextDataOwnerId).order('created_at', { ascending: true }),
      ]);

      const firstError = [itemsResult.error, tripsResult.error, profileResult.error, membersResult.error].find(Boolean);
      if (firstError) reportError('Не вдалося завантажити всі дані: ' + errorText(firstError, 'перевірте підключення.'));

      const rows = (itemsResult.data ?? []) as StoredItem[];
      const loadedMedicines = rows
        .filter((item) => item.kind === 'medicine')
        .map((item) => normalizeMedicine(item.payload, item.id));
      const loadedItems = rows
        .filter((item) => item.kind === 'travel')
        .map((item) => normalizeTripItem(item.payload, item.id));
      const loadedManualPurchases = rows
        .filter((item) => item.kind === 'shopping')
        .map((item) => normalizeManualShoppingItem(item.payload, item.id));
      const loadedTrips = ((tripsResult.data ?? []) as Omit<Trip, 'template'>[])
        .map((trip) => ({ ...trip, template: 'custom' as TripTemplate }));
      const loadedMembers = (membersResult.data ?? []) as FamilyMember[];
      const loadedProfile = profileResult.data as Partial<Profile> | null;

      setMedicines(loadedMedicines);
      setTripItems(loadedItems);
      setManualPurchases(loadedManualPurchases);
      setTrips(loadedTrips);
      setMembers(loadedMembers);
      setProfile(loadedProfile
        ? {
            user_id: user.id,
            display_name: stringValue(loadedProfile.display_name),
            household_name: stringValue(
              nextHousehold?.household_name,
              stringValue(loadedProfile.household_name, 'Моя аптечка'),
            ),
          }
        : {
            user_id: user.id,
            display_name: '',
            household_name: stringValue(nextHousehold?.household_name, 'Моя аптечка'),
          });
      setActiveTripId((current) => loadedTrips.some((trip) => trip.id === current) ? current : (loadedTrips[0]?.id ?? ''));
    } catch (error) {
      reportError('Не вдалося завантажити аптечку: ' + errorText(error, 'перевірте підключення та спробуйте ще раз.'));
    } finally {
      if (!background) setLoading(false);
    }
  }, [reportError, user.id]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') void load({ background: true });
    };
    window.addEventListener('focus', refreshWhenVisible);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => {
      window.removeEventListener('focus', refreshWhenVisible);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, [load]);

  const handleHouseholdChange = useCallback((nextHousehold: HouseholdAccessState | null) => {
    setHouseholdAccess(nextHousehold);
    // The panel refreshes itself on mount; keep that silent so opening
    // “Профіль” does not make the whole app jump back to a loading screen.
    void load({ background: true });
  }, [load]);

  const saveMedicine = async (input: Med): Promise<boolean> => {
    const previous = medicines;
    const existing = medicines.find((medicine) => medicine.id === input.id);
    const base: Med = {
      ...input,
      name: input.name.trim(),
      category: input.category.trim() || 'Інше',
      place: input.place.trim() || 'Домашня аптечка',
      notes: input.notes.trim(),
      quantity: numberValue(input.quantity),
      minimumQuantity: numberValue(input.minimumQuantity),
    };
    const lowNow = isLowStock(base);
    const previousStatus = input.shoppingStatus ?? existing?.shoppingStatus;
    const next: Med = lowNow
      ? {
          ...base,
          shoppingStatus: previousStatus === 'done' ? 'done' : 'pending',
          purchaseDoneAt: previousStatus === 'done' ? (input.purchaseDoneAt ?? existing?.purchaseDoneAt) : undefined,
        }
      : { ...base, shoppingStatus: undefined, purchaseDoneAt: undefined };

    if (!next.name) {
      reportError('Вкажіть назву ліків.');
      return false;
    }

    setMedicines((current) => [next, ...current.filter((medicine) => medicine.id !== next.id)]);
    const { error } = await supabase!.from('home_meds_items').upsert({
      id: next.id,
      user_id: dataOwnerId,
      kind: 'medicine',
      payload: next,
    });
    if (error) {
      setMedicines(previous);
      if (next.photoPath && next.photoPath !== existing?.photoPath) {
        void supabase!.storage.from('home-meds-photos').remove([next.photoPath]);
      }
      reportError('Ліки не збережено: ' + errorText(error, 'перевірте підключення та спробуйте ще раз.'));
      return false;
    }
    if (existing?.photoPath && existing.photoPath !== next.photoPath) {
      const { error: oldPhotoError } = await supabase!.storage.from('home-meds-photos').remove([existing.photoPath]);
      if (oldPhotoError) reportError('Ліки збережено, але старе фото не вдалося прибрати зі сховища.');
    }
    return true;
  };

  const deleteMedicine = async (medicine: Med) => {
    if (!window.confirm('Видалити «' + medicine.name + '» з аптечки?')) return;
    const previous = medicines;
    setMedicines((current) => current.filter((item) => item.id !== medicine.id));
    const { error } = await supabase!.from('home_meds_items').delete().eq('id', medicine.id).eq('user_id', dataOwnerId);
    if (error) {
      setMedicines(previous);
      reportError('Не вдалося видалити ліки: ' + errorText(error, 'спробуйте ще раз.'));
      return;
    }
    if (medicine.photoPath) {
      const { error: photoError } = await supabase!.storage.from('home-meds-photos').remove([medicine.photoPath]);
      if (photoError) reportError('Ліки видалено, але фото залишилося у сховищі. Його можна видалити пізніше.');
    }
  };

  const saveTrip = async (input: Trip): Promise<boolean> => {
    const isNewTrip = !trips.some((trip) => trip.id === input.id);
    const next: Trip = {
      ...input,
      title: input.title.trim(),
      destination: input.destination.trim(),
      travellers: input.travellers.trim(),
      notes: input.notes.trim(),
    };
    if (!next.title) {
      reportError('Вкажіть назву подорожі.');
      return false;
    }
    if (next.starts_on && next.ends_on && next.ends_on < next.starts_on) {
      reportError('Дата завершення не може бути раніше за дату початку.');
      return false;
    }
    const previous = trips;
    setTrips((current) => [next, ...current.filter((trip) => trip.id !== next.id)]);
    setActiveTripId(next.id);
    const { template: _template, ...storedTrip } = next;
    const { error } = await supabase!.from('home_meds_trips').upsert({ ...storedTrip, user_id: dataOwnerId });
    if (error) {
      setTrips(previous);
      reportError('Подорож не збережено: ' + errorText(error, 'спробуйте ще раз.'));
      return false;
    }
    const templateItems = isNewTrip ? tripTemplates[next.template].items : [];
    if (templateItems.length) {
      const createdItems = templateItems.map((item) => ({ ...newTripItem(next.id), ...item }));
      const previousItems = tripItems;
      setTripItems((current) => [...createdItems, ...current]);
      const results = await Promise.all(createdItems.map((item) => supabase!.from('home_meds_items').upsert({
        id: item.id,
        user_id: dataOwnerId,
        kind: 'travel',
        payload: item,
      })));
      const itemError = results.find((result) => result.error)?.error;
      if (itemError) {
        setTripItems(previousItems);
        reportError('Подорож створено, але шаблонний чекліст не збережено: ' + errorText(itemError, 'спробуйте ще раз.'));
      }
    }
    return true;
  };

  const deleteTrip = async (trip: Trip) => {
    if (!window.confirm('Видалити подорож «' + trip.title + '» та її чекліст?')) return;
    const previousTrips = trips;
    const previousItems = tripItems;
    const relatedItems = tripItems.filter((item) => item.tripId === trip.id);
    setTrips((current) => current.filter((item) => item.id !== trip.id));
    setTripItems((current) => current.filter((item) => item.tripId !== trip.id));
    setActiveTripId((current) => current === trip.id ? '' : current);

    const results = await Promise.all([
      supabase!.from('home_meds_trips').delete().eq('id', trip.id).eq('user_id', dataOwnerId),
      ...relatedItems.map((item) => supabase!.from('home_meds_items').delete().eq('id', item.id).eq('user_id', dataOwnerId)),
    ]);
    const failure = results.find((result) => result.error)?.error;
    if (failure) {
      setTrips(previousTrips);
      setTripItems(previousItems);
      reportError('Не вдалося повністю видалити подорож: ' + errorText(failure, 'спробуйте ще раз.'));
    }
  };

  const saveTripItem = async (input: TripItem): Promise<boolean> => {
    const next: TripItem = {
      ...input,
      title: input.title.trim(),
      category: input.category.trim() || 'Аптечка',
      note: input.note.trim(),
    };
    if (!next.title) {
      reportError('Вкажіть, що треба взяти.');
      return false;
    }
    const previous = tripItems;
    setTripItems((current) => [next, ...current.filter((item) => item.id !== next.id)]);
    const { error } = await supabase!.from('home_meds_items').upsert({
      id: next.id,
      user_id: dataOwnerId,
      kind: 'travel',
      payload: next,
    });
    if (error) {
      setTripItems(previous);
      reportError('Пункт чекліста не збережено: ' + errorText(error, 'спробуйте ще раз.'));
      return false;
    }
    return true;
  };

  const deleteTripItem = async (item: TripItem) => {
    if (!window.confirm('Видалити «' + item.title + '» зі списку?')) return;
    const previous = tripItems;
    setTripItems((current) => current.filter((currentItem) => currentItem.id !== item.id));
    const { error } = await supabase!.from('home_meds_items').delete().eq('id', item.id).eq('user_id', dataOwnerId);
    if (error) {
      setTripItems(previous);
      reportError('Не вдалося видалити пункт: ' + errorText(error, 'спробуйте ще раз.'));
    }
  };

  const saveManualPurchase = async (input: ManualShoppingItem): Promise<boolean> => {
    const next: ManualShoppingItem = {
      ...input,
      title: input.title.trim(),
      quantity: input.quantity.trim(),
      note: input.note.trim(),
    };
    if (!next.title) {
      reportError('Напишіть, що потрібно купити.');
      return false;
    }
    const previous = manualPurchases;
    setManualPurchases((current) => [next, ...current.filter((item) => item.id !== next.id)]);
    const { error } = await supabase!.from('home_meds_items').upsert({
      id: next.id,
      user_id: dataOwnerId,
      kind: 'shopping',
      payload: next,
    });
    if (error) {
      setManualPurchases(previous);
      reportError('Покупку не збережено: ' + errorText(error, 'спробуйте ще раз.'));
      return false;
    }
    return true;
  };

  const addManualPurchase = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (await saveManualPurchase(manualPurchaseDraft)) setManualPurchaseDraft(newManualShoppingItem());
  };

  const deleteManualPurchase = async (item: ManualShoppingItem) => {
    if (!window.confirm('Видалити «' + item.title + '» зі списку покупок?')) return;
    const previous = manualPurchases;
    setManualPurchases((current) => current.filter((currentItem) => currentItem.id !== item.id));
    const { error } = await supabase!.from('home_meds_items').delete().eq('id', item.id).eq('user_id', dataOwnerId);
    if (error) {
      setManualPurchases(previous);
      reportError('Не вдалося видалити покупку: ' + errorText(error, 'спробуйте ще раз.'));
    }
  };

  const saveProfile = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const next = {
      ...profile,
      user_id: user.id,
      display_name: profile.display_name.trim(),
      household_name: profile.household_name.trim() || 'Моя аптечка',
    };

    const profileRequest = supabase!.from('home_meds_profiles').upsert(next);
    const householdRequest = householdAccess && canEdit
      ? supabase!.rpc('home_meds_update_household_name', { new_name: next.household_name })
      : Promise.resolve({ error: null });
    const [profileResult, householdResult] = await Promise.all([profileRequest, householdRequest]);

    if (profileResult.error || householdResult.error) {
      const error = profileResult.error ?? householdResult.error;
      reportError('Налаштування не збережено: ' + errorText(error, 'спробуйте ще раз.'));
      return;
    }
    setProfile(next);
    if (householdAccess && canEdit) {
      setHouseholdAccess({ ...householdAccess, household_name: next.household_name });
    }
  };

  const activeTrip = trips.find((trip) => trip.id === activeTripId) ?? trips[0] ?? null;
  const activeTripItems = activeTrip ? tripItems.filter((item) => item.tripId === activeTrip.id) : [];
  const sharedCabinet = householdAccess !== null;
  const pendingPurchases = medicines.filter((medicine) => isLowStock(medicine) && medicine.shoppingStatus !== 'done');
  const completedPurchases = medicines.filter((medicine) => isLowStock(medicine) && medicine.shoppingStatus === 'done');
  const pendingManualPurchases = manualPurchases.filter((item) => !item.done);
  const completedManualPurchases = manualPurchases.filter((item) => item.done);
  const purchaseCount = pendingPurchases.length + pendingManualPurchases.length;
  const expiryAttention = medicines.filter((medicine) => {
    const days = daysUntilExpiry(medicine.expiry);
    return days !== null && days <= 30;
  }).length;
  const memberNames = useMemo(() => new Map(members.map((member) => [member.id, member.name])), [members]);
  const cabinetPlaces = useMemo(() => Array.from(new Set(medicines.map((medicine) => medicine.place).filter(Boolean))).sort(), [medicines]);
  const visibleMedicines = useMemo(() => {
    const query = medicineQuery.trim().toLocaleLowerCase('uk');
    return medicines.filter((medicine) => {
      const matchesQuery = !query || [medicine.name, medicine.category, medicine.place, medicine.activeIngredient, medicine.notes]
        .some((value) => value.toLocaleLowerCase('uk').includes(query));
      const expiryDays = daysUntilExpiry(medicine.expiry);
      const matchesFilter = medicineFilter === 'all'
        || (medicineFilter === 'low' && isLowStock(medicine))
        || (medicineFilter === 'expiry' && expiryDays !== null && expiryDays <= 30)
        || (medicineFilter === 'purchases' && medicine.shoppingStatus === 'pending');
      return matchesQuery && matchesFilter;
    });
  }, [medicineFilter, medicineQuery, medicines]);

  const exportCabinet = () => {
    const escapeHtml = (value: string) => value.replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character] ?? character);
    const rows = medicines.map((medicine) => `<tr><td>${escapeHtml(medicine.name)}</td><td>${escapeHtml(medicine.category)}</td><td>${escapeHtml(formatMedicineQuantity(medicine.quantity, medicine.quantityUnit))}</td><td>${escapeHtml(medicine.place)}</td><td>${escapeHtml(medicine.expiry || '—')}</td><td>${escapeHtml(medicine.notes || '—')}</td></tr>`).join('');
    const printWindow = window.open('', '_blank');
    if (!printWindow) {
      reportError('Браузер заблокував вікно експорту. Дозвольте спливні вікна для цього сайту й повторіть.');
      return;
    }
    printWindow.document.write(`<!doctype html><html lang="uk"><head><meta charset="utf-8"><title>${escapeHtml(profile.household_name)}</title><style>body{font-family:system-ui,sans-serif;color:#243b33;padding:32px}h1{margin-bottom:4px}p{color:#60746b}table{width:100%;border-collapse:collapse;margin-top:24px;font-size:12px}th,td{border:1px solid #d8e2dc;padding:9px;text-align:left;vertical-align:top}th{background:#edf5f0}@media print{body{padding:0}}</style></head><body><h1>${escapeHtml(profile.household_name)}</h1><p>Експорт аптечки · ${new Date().toLocaleDateString('uk-UA')}</p><table><thead><tr><th>Ліки</th><th>Категорія</th><th>Залишок</th><th>Де лежить</th><th>Термін</th><th>Нотатка</th></tr></thead><tbody>${rows || '<tr><td colspan="6">Аптечка порожня</td></tr>'}</tbody></table><script>window.onload=()=>window.print()</script></body></html>`);
    printWindow.document.close();
  };

  const openMedicineEditor = (medicine: Med) => setModal(
    <MedicineEditor
      members={members}
      onClose={() => setModal(null)}
      onSave={saveMedicine}
      userId={dataOwnerId}
      value={medicine}
    />,
  );
  const openTripEditor = (trip: Trip) => setModal(<TripEditor onClose={() => setModal(null)} onSave={saveTrip} value={trip} />);
  const openTripItemEditor = (item: TripItem) => setModal(<TripItemEditor onClose={() => setModal(null)} onSave={saveTripItem} value={item} />);
  const openManualShoppingEditor = (item: ManualShoppingItem) => setModal(<ManualShoppingEditor onClose={() => setModal(null)} onSave={saveManualPurchase} value={item} />);

  if (loading) {
    return <main className="loading-screen"><span className="auth-brand-icon">+</span><span>Завантажуємо вашу аптечку…</span></main>;
  }

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><span className="brand-mark">+</span>home <b>meds</b></div>
      <nav aria-label="Основна навігація">
        {navigation.map(({ id, label, Icon }) => <button className={'nav-link ' + (tab === id ? 'active' : '')} key={id} onClick={() => {
          setTab(id);
          void load({ background: true });
        }} type="button">
          <Icon size={18} />{label}
        </button>)}
      </nav>
    </aside>
    <main className="content">
      <header className="topbar">
        <div className="mobile-brand"><span className="brand-mark">+</span>home <b>meds</b></div>
        <strong>{profile.household_name}</strong>
        {sharedCabinet && <span className="shared-cabinet-indicator">Спільна</span>}
        <button aria-label="Вийти з акаунта" className="profile" onClick={() => void supabase!.auth.signOut()} title="Вийти" type="button">
          {(profile.display_name || user.email || 'Я').slice(0, 1).toUpperCase()}
        </button>
      </header>

      {tab === 'meds' && <section className="page">
        <div className="page-head">
          <div>
            <p className="eyebrow">ВАША АПТЕЧКА</p>
            <h1>Ліки вдома</h1>
            <p className="subtext">Залишки, строки придатності та список того, що час докупити.</p>
          </div>
          <div className="page-actions">
            <button className="outline-button" onClick={exportCabinet} type="button"><FileDown size={17} />Експорт PDF</button>
            {canEdit && <button className="primary-button" onClick={() => openMedicineEditor(newMedicine())} type="button"><Plus size={18} />Додати ліки</button>}
          </div>
        </div>

        {!canEdit && <section className="status-banner viewer-banner"><span className="banner-icon"><ShieldAlert size={19} /></span><div><strong>Режим перегляду</strong><p>Власник може змінити вашу роль у розділі «Профіль».</p></div></section>}

        <div className="stats-grid">
          <article className="stat-card"><span className="stat-icon teal"><Pill /></span><div><strong>{medicines.length}</strong><p>позицій в аптечці</p></div></article>
          <article className="stat-card"><span className="stat-icon orange"><ShoppingBasket /></span><div><strong>{purchaseCount}</strong><p>треба купити</p></div></article>
          <article className="stat-card"><span className="stat-icon blue"><CalendarClock /></span><div><strong>{expiryAttention}</strong><p>термінів у найближчі 30 днів</p></div></article>
        </div>

        {purchaseCount > 0 && <section className="status-banner">
          <span className="banner-icon"><AlertTriangle size={19} /></span>
          <div><strong>Автоматичний список покупок</strong><p>Ліки з низьким запасом з’явилися тут самі.</p></div>
        </section>}

        <div className="cabinet-tools">
          <label className="search"><Search size={17} /><input aria-label="Пошук ліків" onChange={(event) => setMedicineQuery(event.target.value)} placeholder="Пошук за назвою, категорією або місцем" value={medicineQuery} /></label>
          <div className="filter-row cabinet-filters">
            {([['all', 'Усі'], ['low', 'Мало'], ['expiry', 'Термін'], ['purchases', 'Купити']] as const).map(([id, label]) => <button className={'filter ' + (medicineFilter === id ? 'active' : '')} key={id} onClick={() => setMedicineFilter(id)} type="button">{label}</button>)}
          </div>
        </div>
        {cabinetPlaces.length > 1 && <p className="location-summary">Локації: {cabinetPlaces.join(' · ')}</p>}
        <div className="cabinet-grid">
          {visibleMedicines.map((medicine) => {
            const suitableFor = medicine.memberIds.map((memberId) => memberNames.get(memberId)).filter(Boolean);
            const low = isLowStock(medicine);
            const expiryDays = daysUntilExpiry(medicine.expiry);
            return <article className={'medicine-card detailed-medicine-card ' + (low ? 'low-stock-card' : '')} key={medicine.id}>
              <div className="medicine-card-top">
                <MedicinePhoto name={medicine.name} path={medicine.photoPath} />
                <div className="medicine-card-actions">
                  {canEdit && <><button aria-label={'Редагувати ' + medicine.name} className="dots" onClick={() => openMedicineEditor(medicine)} type="button"><Edit3 size={16} /></button>
                  <button aria-label={'Видалити ' + medicine.name} className="dots danger-action" onClick={() => void deleteMedicine(medicine)} type="button"><Trash2 size={16} /></button></>}
                </div>
              </div>
              <p className="category">{medicine.category}</p>
              <h3>{medicine.name}</h3>
              <p className="form">{medicine.place}</p>
              <div className="card-divider" />
              <div className="medicine-meta">
                <span><b>{formatMedicineQuantity(medicine.quantity, medicine.quantityUnit)}</b> у запасі</span>
                {medicine.minimumQuantity > 0 && <span className={low ? 'low-count' : ''}>мін. {formatMedicineQuantity(medicine.minimumQuantity, medicine.quantityUnit)}</span>}
              </div>
              <div className="medicine-tags">
                {expiryDays !== null && <span className={'status ' + (expiryDays < 0 ? 'danger' : expiryDays <= 30 ? 'warn' : 'safe')}>{expiryLabel(medicine.expiry)}</span>}
                {suitableFor.length > 0 && <span className="soft-tag">{suitableFor.join(', ')}</span>}
              </div>
                {medicine.notes && <p className="medicine-note">{medicine.notes}</p>}
              {(medicine.activeIngredient || medicine.dosage) && <p className="medicine-note"><b>{medicine.activeIngredient}</b>{medicine.activeIngredient && medicine.dosage ? ' · ' : ''}{medicine.dosage}</p>}
              {medicine.instructions && <p className="medicine-note">Як застосовувати: {medicine.instructions}</p>}
              {medicine.warnings && <p className="medicine-warning"><ShieldAlert size={13} /> {medicine.warnings}</p>}
              <div className="medicine-card-footer">
                {canEdit && <button className="text-button" onClick={() => setModal(<AddMedicineToTrip medicine={medicine} onAdd={saveTripItem} onClose={() => setModal(null)} trips={trips} />)} type="button"><MapPinned size={15} /> Взяти в подорож</button>}
                {canEdit && low && medicine.shoppingStatus !== 'done' && <button className="buy-tag" onClick={() => void saveMedicine({ ...medicine, shoppingStatus: 'done', purchaseDoneAt: new Date().toISOString() })} type="button">Куплено</button>}
                {low && medicine.shoppingStatus === 'done' && <span className="cabinet-tag">Куплено</span>}
              </div>
            </article>;
          })}
        </div>
        {!medicines.length && <section className="empty">
          <Pill size={30} />
          <h2>Аптечка поки порожня</h2>
          <p>Додайте перші ліки, фото упаковки та мінімальний запас.</p>
          {canEdit && <button className="primary-button" onClick={() => openMedicineEditor(newMedicine())} type="button"><Plus size={17} />Додати ліки</button>}
        </section>}
        {!!medicines.length && !visibleMedicines.length && <section className="empty compact-empty"><Search size={26} /><h2>Нічого не знайдено</h2><p>Змініть пошук або фільтр, щоб побачити інші позиції.</p></section>}

        <section className="panel shopping-panel auto-shopping-panel">
          <div className="shopping-heading">
            <div><span className="shopping-number"><ShoppingBasket size={20} /></span><div><h2>Покупки</h2><p>Автоматичні позиції з’являються від малого запасу, а будь-що інше можна додати вручну.</p></div></div>
          </div>
          {canEdit && <form className="manual-shopping-form" onSubmit={(event) => void addManualPurchase(event)}>
            <input aria-label="Що купити додому" onChange={(event) => setManualPurchaseDraft((current) => ({ ...current, title: event.target.value }))} placeholder="Що треба купити додому?" required value={manualPurchaseDraft.title} />
            <input aria-label="Кількість" onChange={(event) => setManualPurchaseDraft((current) => ({ ...current, quantity: event.target.value }))} placeholder="К-сть" value={manualPurchaseDraft.quantity} />
            <input aria-label="Нотатка до покупки" onChange={(event) => setManualPurchaseDraft((current) => ({ ...current, note: event.target.value }))} placeholder="Нотатка" value={manualPurchaseDraft.note} />
            <button className="outline-button" type="submit"><Plus size={16} />Додати</button>
          </form>}
          {pendingPurchases.length ? <div className="shopping-list">
            {pendingPurchases.map((medicine) => <div className="shopping-item" key={medicine.id}>
              <span className="pill-symbol"><Pill size={17} /></span>
              <div><strong>{medicine.name}</strong><small>Залишок: {formatMedicineQuantity(medicine.quantity, medicine.quantityUnit)}; мінімум: {formatMedicineQuantity(medicine.minimumQuantity, medicine.quantityUnit)}</small></div>
              {canEdit && <><button className="buy-tag" onClick={() => void saveMedicine({ ...medicine, shoppingStatus: 'done', purchaseDoneAt: new Date().toISOString() })} type="button">Позначити купленим</button>
              <button aria-label={'Редагувати ' + medicine.name} className="dots" onClick={() => openMedicineEditor(medicine)} type="button"><Edit3 size={16} /></button></>}
            </div>)}
          </div> : !pendingManualPurchases.length && <p className="subtext">Наразі все є в достатній кількості.</p>}
          {pendingManualPurchases.length > 0 && <div className="shopping-list manual-shopping-list">
            {pendingManualPurchases.map((item) => <div className="shopping-item" key={item.id}>
              <span className="pill-symbol"><ShoppingBasket size={17} /></span>
              <div><strong>{item.title}</strong><small>{[item.quantity, item.note].filter(Boolean).join(' · ') || 'Додано вручну'}</small></div>
              {canEdit && <><button className="buy-tag" onClick={() => void saveManualPurchase({ ...item, done: true })} type="button">Куплено</button>
              <button aria-label={'Редагувати ' + item.title} className="dots" onClick={() => openManualShoppingEditor(item)} type="button"><Edit3 size={16} /></button>
              <button aria-label={'Видалити ' + item.title} className="dots danger-action" onClick={() => void deleteManualPurchase(item)} type="button"><Trash2 size={16} /></button></>}
            </div>)}
          </div>}
          {completedPurchases.length > 0 && <p className="completed-shopping-note"><Check size={15} /> Куплено: {completedPurchases.map((medicine) => medicine.name).join(', ')}. Оновіть залишок, коли покладете покупки в аптечку.</p>}
          {completedManualPurchases.length > 0 && <div className="shopping-list completed-manual-shopping-list">
            {completedManualPurchases.map((item) => <div className="shopping-item bought" key={item.id}>
              <span className="pill-symbol"><Check size={17} /></span>
              <div><strong>{item.title}</strong><small>{[item.quantity, item.note].filter(Boolean).join(' · ') || 'Куплено вручну'}</small></div>
              {canEdit && <><button className="text-button" onClick={() => void saveManualPurchase({ ...item, done: false })} type="button">Повернути</button>
              <button aria-label={'Редагувати ' + item.title} className="dots" onClick={() => openManualShoppingEditor(item)} type="button"><Edit3 size={16} /></button>
              <button aria-label={'Видалити ' + item.title} className="dots danger-action" onClick={() => void deleteManualPurchase(item)} type="button"><Trash2 size={16} /></button></>}
            </div>)}
          </div>}
        </section>
      </section>}

      {tab === 'trips' && <section className="page">
        <div className="page-head">
          <div>
            <p className="eyebrow">ПОДОРОЖІ</p>
            <h1>Зібратися без метушні</h1>
            <p className="subtext">Створіть подорож, а потрібні ліки додавайте до чекліста прямо з аптечки.</p>
          </div>
          {canEdit && <button className="primary-button" onClick={() => openTripEditor(newTrip())} type="button"><Plus size={18} />Нова подорож</button>}
        </div>

        {trips.length ? <>
          <div className="filter-row">
            {trips.map((trip) => <button className={'filter ' + (trip.id === activeTrip?.id ? 'active' : '')} key={trip.id} onClick={() => setActiveTripId(trip.id)} type="button">{trip.title}</button>)}
          </div>
          {activeTrip && <>
            <section className="travel-hero">
              <div className="hero-label"><MapPinned size={15} /> {activeTrip.destination || 'Місце ще не вказано'}</div>
              <h2>{activeTrip.title}</h2>
              <p>{activeTrip.notes || 'Додайте нотатку: бронювання, маршрут або інші важливі деталі.'}</p>
              <div className="hero-chips">
                {(activeTrip.starts_on || activeTrip.ends_on) && <span><CalendarClock size={14} />{activeTrip.starts_on || '—'} — {activeTrip.ends_on || '—'}</span>}
                {activeTrip.travellers && <span><UserRound size={14} />{activeTrip.travellers}</span>}
                {canEdit && <><button onClick={() => openTripEditor(activeTrip)} type="button"><Edit3 size={14} />Редагувати</button>
                <button onClick={() => void deleteTrip(activeTrip)} type="button"><Trash2 size={14} />Видалити</button></>}
              </div>
            </section>

            <section className="panel">
              <div className="panel-title">
                <div><p className="eyebrow">ЧЕКЛІСТ</p><h2>Що взяти</h2></div>
                {canEdit && <button className="outline-button" onClick={() => openTripItemEditor(newTripItem(activeTrip.id))} type="button"><Plus size={16} />Додати</button>}
              </div>
              {activeTripItems.length ? <div className="packing-list">
                {activeTripItems.map((item) => <div className={'packing-item ' + (item.packed ? 'packed' : '')} key={item.id}>
                  {canEdit ? <button aria-label={item.packed ? 'Позначити незібраним' : 'Позначити зібраним'} className={'check ' + (item.packed ? 'checked' : '')} onClick={() => void saveTripItem({ ...item, packed: !item.packed })} type="button">{item.packed && <Check size={14} />}</button> : <span className={'check ' + (item.packed ? 'checked' : '')}>{item.packed && <Check size={14} />}</span>}
                  <div><span className="item-category">{item.category}</span><strong>{item.title}</strong>{item.note && <small>{item.note}</small>}</div>
                  {item.inCabinet && <span className="cabinet-tag">Є вдома</span>}
                  {canEdit && item.needBuy && <button className="buy-tag" onClick={() => void saveTripItem({ ...item, bought: !item.bought })} type="button">{item.bought ? 'Куплено' : 'Купити'}</button>}
                  {canEdit && <><button aria-label={'Редагувати ' + item.title} className="dots" onClick={() => openTripItemEditor(item)} type="button"><Edit3 size={16} /></button>
                  <button aria-label={'Видалити ' + item.title} className="dots danger-action" onClick={() => void deleteTripItem(item)} type="button"><Trash2 size={16} /></button></>}
                </div>)}
              </div> : <div className="empty compact-empty"><ClipboardList size={28} /><h2>Чекліст ще порожній</h2><p>Додайте речі вручну або відкрийте «Аптечку» і натисніть «Взяти в подорож».</p></div>}
            </section>
          </>}
        </> : <section className="empty">
          <MapPinned size={30} />
          <h2>Заплануйте першу подорож</h2>
          <p>Після цього ви зможете переносити ліки з аптечки до окремого чекліста.</p>
          {canEdit && <button className="primary-button" onClick={() => openTripEditor(newTrip())} type="button"><Plus size={17} />Створити подорож</button>}
        </section>}
      </section>}

      {tab === 'profile' && <section className="page">
        <div className="page-head">
          <div>
            <p className="eyebrow">НАЛАШТУВАННЯ</p>
            <h1>Профіль і безпека</h1>
            <p className="subtext">Налаштуйте аптечку, родину, терміни та захист цього пристрою.</p>
          </div>
        </div>
        <div className="profile-stack">
          {sharingAvailable === true && <HouseholdSharingPanel onHouseholdChange={handleHouseholdChange} userId={user.id} />}
          {sharingAvailable === false && <section className="panel sharing-setup-note">
            <p className="eyebrow">СПІЛЬНИЙ ДОСТУП</p>
            <h2>Родинна аптечка готова до підключення</h2>
            <p className="subtext">Запустіть останню міграцію Supabase, і тут з’явиться код запрошення для рідних. Особисті дані залишаться приватними.</p>
          </section>}
          <form className="panel profile-form" onSubmit={(event) => void saveProfile(event)}>
            <div className="panel-title"><div><p className="eyebrow">ВАША АПТЕЧКА</p><h2>Основні дані</h2></div></div>
            <Field label="Ім’я для цього акаунта"><input value={profile.display_name} onChange={(event) => setProfile((current) => ({ ...current, display_name: event.target.value }))} /></Field>
            <Field label={sharedCabinet ? 'Назва спільної аптечки' : 'Назва аптечки'} hint={sharedCabinet ? 'Цю назву бачать усі учасники з доступом.' : undefined}><input disabled={!canEdit && sharedCabinet} value={profile.household_name} onChange={(event) => setProfile((current) => ({ ...current, household_name: event.target.value }))} /></Field>
            <button className="primary-button" type="submit">Зберегти профіль</button>
          </form>
          <FamilyPanel onMembersChange={setMembers} readOnly={!canEdit} userId={dataOwnerId} />
          <ActivityPanel currentUserId={user.id} names={new Map([[user.id, profile.display_name || 'Ви']])} ownerUserId={dataOwnerId} />
          <NotificationSettings medicines={medicines} userId={user.id} />
        </div>
      </section>}
      {modal}
      {syncError && <aside className="sync-error" role="alert"><AlertTriangle size={16} /><span>{syncError}</span><button aria-label="Закрити повідомлення" onClick={() => setSyncError('')} type="button"><X size={15} /></button></aside>}
    </main>
  </div>;
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [passwordRecovery, setPasswordRecovery] = useState(false);

  useEffect(() => {
    if (!supabase) return undefined;
    const locationType = new URLSearchParams(window.location.search).get('type')
      || new URLSearchParams(window.location.hash.replace(/^#/, '')).get('type');
    if (locationType === 'recovery') setPasswordRecovery(true);

    void supabase.auth.getSession().then(({ data }) => setUser(data.session?.user ?? null));
    const { data } = supabase.auth.onAuthStateChange((event, session) => {
      setUser(session?.user ?? null);
      if (event === 'PASSWORD_RECOVERY') setPasswordRecovery(true);
    });
    return () => data.subscription.unsubscribe();
  }, []);

  if (!isSupabaseConfigured) {
    return <main className="loading-screen">Home Meds ще не підключено до безпечного сховища.</main>;
  }

  if (passwordRecovery && user) return <AuthScreen recovery onRecoveryComplete={() => setPasswordRecovery(false)} />;

  if (!user) return <AuthScreen />;

  return <Workspace user={user} />;
}
