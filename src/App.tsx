import {
  AlertTriangle,
  CalendarClock,
  Camera,
  Check,
  ClipboardList,
  Edit3,
  ImageIcon,
  LockKeyhole,
  MapPinned,
  Pill,
  Plus,
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
import { NotificationSettings } from './components/NotificationSettings';
import { PinLockGate, PinLockSettings, usePinLock } from './components/PinLockGate';
import { clearLocalPin } from './lib/localPin';
import { isSupabaseConfigured, supabase } from './lib/supabase';

type MedicineShoppingStatus = 'pending' | 'done';

type Med = {
  id: string;
  name: string;
  category: string;
  quantity: number;
  minimumQuantity: number;
  place: string;
  expiry: string;
  barcode?: string;
  photoPath?: string;
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
};

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
  place: 'Домашня аптечка',
  expiry: '',
  memberIds: [],
  notes: '',
});
const newTrip = (): Trip => ({
  id: createId(),
  title: '',
  destination: '',
  starts_on: null,
  ends_on: null,
  travellers: '',
  notes: '',
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

function normalizeMedicine(payload: unknown, fallbackId: string): Med {
  const data = asRecord(payload);
  const memberIds = Array.isArray(data.memberIds)
    ? data.memberIds.filter((id): id is string => typeof id === 'string')
    : [];
  const shoppingStatus = data.shoppingStatus === 'done' || data.shoppingStatus === 'pending'
    ? data.shoppingStatus
    : undefined;

  return {
    id: stringValue(data.id, fallbackId),
    name: stringValue(data.name),
    category: stringValue(data.category, 'Інше'),
    quantity: numberValue(data.quantity, 1),
    minimumQuantity: numberValue(data.minimumQuantity ?? data.minQuantity),
    place: stringValue(data.place, 'Домашня аптечка'),
    expiry: stringValue(data.expiry),
    barcode: stringValue(data.barcode) || undefined,
    photoPath: stringValue(data.photoPath) || undefined,
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
    role: rawRole === 'owner' ? 'owner' : 'editor',
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
  const scanInput = useRef<HTMLInputElement>(null);

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
          setScanMessage('Штрихкод розпізнано: ' + barcode + '.');
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
        <Field label="Назва">
          <input autoFocus required value={draft.name} onChange={(event) => setValue('name', event.target.value)} />
        </Field>
        <Field label="Категорія">
          <input value={draft.category} onChange={(event) => setValue('category', event.target.value)} placeholder="Наприклад, від застуди" />
        </Field>
        <Field label="Залишок" hint="Упаковки, таблетки чи інша ваша одиниця">
          <input min="0" type="number" value={draft.quantity} onChange={(event) => setValue('quantity', numberValue(event.target.value))} />
        </Field>
        <Field label="Мінімальний запас" hint="0 — не додавати до покупок">
          <input min="0" type="number" value={draft.minimumQuantity} onChange={(event) => setValue('minimumQuantity', numberValue(event.target.value))} />
        </Field>
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
      </div>
      <Field label="Штрихкод" hint="Необов’язково — заповнюється після сканування або вручну.">
        <input value={draft.barcode ?? ''} onChange={(event) => setValue('barcode', event.target.value || undefined)} />
      </Field>
      {scanMessage && <p className="form-hint" role="status">{scanMessage}</p>}
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
  const { lock } = usePinLock();
  const [tab, setTab] = useState<'meds' | 'trips' | 'profile'>('meds');
  const [medicines, setMedicines] = useState<Med[]>([]);
  const [trips, setTrips] = useState<Trip[]>([]);
  const [tripItems, setTripItems] = useState<TripItem[]>([]);
  const [members, setMembers] = useState<FamilyMember[]>([]);
  const [profile, setProfile] = useState<Profile>({ user_id: user.id, display_name: '', household_name: 'Моя аптечка' });
  const [activeTripId, setActiveTripId] = useState('');
  const [modal, setModal] = useState<ReactNode>(null);
  const [loading, setLoading] = useState(true);
  const [syncError, setSyncError] = useState('');
  const [householdAccess, setHouseholdAccess] = useState<HouseholdAccessState | null>(null);
  const [sharingAvailable, setSharingAvailable] = useState<boolean | null>(null);

  const reportError = useCallback((message: string) => setSyncError(message), []);
  const dataOwnerId = householdAccess?.owner_user_id ?? user.id;

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
      const loadedTrips = (tripsResult.data ?? []) as Trip[];
      const loadedMembers = (membersResult.data ?? []) as FamilyMember[];
      const loadedProfile = profileResult.data as Partial<Profile> | null;

      setMedicines(loadedMedicines);
      setTripItems(loadedItems);
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
    const { error } = await supabase!.from('home_meds_trips').upsert({ ...next, user_id: dataOwnerId });
    if (error) {
      setTrips(previous);
      reportError('Подорож не збережено: ' + errorText(error, 'спробуйте ще раз.'));
      return false;
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

  const saveProfile = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const next = {
      ...profile,
      user_id: user.id,
      display_name: profile.display_name.trim(),
      household_name: profile.household_name.trim() || 'Моя аптечка',
    };

    const profileRequest = supabase!.from('home_meds_profiles').upsert(next);
    const householdRequest = householdAccess
      ? supabase!.rpc('home_meds_update_household_name', { new_name: next.household_name })
      : Promise.resolve({ error: null });
    const [profileResult, householdResult] = await Promise.all([profileRequest, householdRequest]);

    if (profileResult.error || householdResult.error) {
      const error = profileResult.error ?? householdResult.error;
      reportError('Налаштування не збережено: ' + errorText(error, 'спробуйте ще раз.'));
      return;
    }
    setProfile(next);
    if (householdAccess) {
      setHouseholdAccess({ ...householdAccess, household_name: next.household_name });
    }
  };

  const activeTrip = trips.find((trip) => trip.id === activeTripId) ?? trips[0] ?? null;
  const activeTripItems = activeTrip ? tripItems.filter((item) => item.tripId === activeTrip.id) : [];
  const sharedCabinet = householdAccess !== null;
  const pendingPurchases = medicines.filter((medicine) => isLowStock(medicine) && medicine.shoppingStatus !== 'done');
  const completedPurchases = medicines.filter((medicine) => isLowStock(medicine) && medicine.shoppingStatus === 'done');
  const expiryAttention = medicines.filter((medicine) => {
    const days = daysUntilExpiry(medicine.expiry);
    return days !== null && days <= 30;
  }).length;
  const memberNames = useMemo(() => new Map(members.map((member) => [member.id, member.name])), [members]);

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
        <button className="topbar-lock" onClick={lock} title="Заблокувати аптечку" type="button"><LockKeyhole size={16} /><span>Заблокувати</span></button>
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
          <button className="primary-button" onClick={() => openMedicineEditor(newMedicine())} type="button"><Plus size={18} />Додати ліки</button>
        </div>

        <div className="stats-grid">
          <article className="stat-card"><span className="stat-icon teal"><Pill /></span><div><strong>{medicines.length}</strong><p>позицій в аптечці</p></div></article>
          <article className="stat-card"><span className="stat-icon orange"><ShoppingBasket /></span><div><strong>{pendingPurchases.length}</strong><p>треба купити</p></div></article>
          <article className="stat-card"><span className="stat-icon blue"><CalendarClock /></span><div><strong>{expiryAttention}</strong><p>термінів у найближчі 30 днів</p></div></article>
        </div>

        {pendingPurchases.length > 0 && <section className="status-banner">
          <span className="banner-icon"><AlertTriangle size={19} /></span>
          <div><strong>Автоматичний список покупок</strong><p>Ліки з низьким запасом з’явилися тут самі.</p></div>
        </section>}

        <div className="cabinet-grid">
          {medicines.map((medicine) => {
            const suitableFor = medicine.memberIds.map((memberId) => memberNames.get(memberId)).filter(Boolean);
            const low = isLowStock(medicine);
            const expiryDays = daysUntilExpiry(medicine.expiry);
            return <article className={'medicine-card detailed-medicine-card ' + (low ? 'low-stock-card' : '')} key={medicine.id}>
              <div className="medicine-card-top">
                <MedicinePhoto name={medicine.name} path={medicine.photoPath} />
                <div className="medicine-card-actions">
                  <button aria-label={'Редагувати ' + medicine.name} className="dots" onClick={() => openMedicineEditor(medicine)} type="button"><Edit3 size={16} /></button>
                  <button aria-label={'Видалити ' + medicine.name} className="dots danger-action" onClick={() => void deleteMedicine(medicine)} type="button"><Trash2 size={16} /></button>
                </div>
              </div>
              <p className="category">{medicine.category}</p>
              <h3>{medicine.name}</h3>
              <p className="form">{medicine.place}</p>
              <div className="card-divider" />
              <div className="medicine-meta">
                <span><b>{medicine.quantity}</b> у запасі</span>
                {medicine.minimumQuantity > 0 && <span className={low ? 'low-count' : ''}>мін. {medicine.minimumQuantity}</span>}
              </div>
              <div className="medicine-tags">
                {expiryDays !== null && <span className={'status ' + (expiryDays < 0 ? 'danger' : expiryDays <= 30 ? 'warn' : 'safe')}>{expiryLabel(medicine.expiry)}</span>}
                {suitableFor.length > 0 && <span className="soft-tag">{suitableFor.join(', ')}</span>}
              </div>
              {medicine.notes && <p className="medicine-note">{medicine.notes}</p>}
              <div className="medicine-card-footer">
                <button className="text-button" onClick={() => setModal(<AddMedicineToTrip medicine={medicine} onAdd={saveTripItem} onClose={() => setModal(null)} trips={trips} />)} type="button"><MapPinned size={15} /> Взяти в подорож</button>
                {low && medicine.shoppingStatus !== 'done' && <button className="buy-tag" onClick={() => void saveMedicine({ ...medicine, shoppingStatus: 'done', purchaseDoneAt: new Date().toISOString() })} type="button">Куплено</button>}
                {low && medicine.shoppingStatus === 'done' && <span className="cabinet-tag">Куплено</span>}
              </div>
            </article>;
          })}
        </div>
        {!medicines.length && <section className="empty">
          <Pill size={30} />
          <h2>Аптечка поки порожня</h2>
          <p>Додайте перші ліки, фото упаковки та мінімальний запас.</p>
          <button className="primary-button" onClick={() => openMedicineEditor(newMedicine())} type="button"><Plus size={17} />Додати ліки</button>
        </section>}

        <section className="panel shopping-panel auto-shopping-panel">
          <div className="shopping-heading">
            <div><span className="shopping-number"><ShoppingBasket size={20} /></span><div><h2>Покупки</h2><p>Створюються автоматично, коли залишок досягає вашого мінімуму.</p></div></div>
          </div>
          {pendingPurchases.length ? <div className="shopping-list">
            {pendingPurchases.map((medicine) => <div className="shopping-item" key={medicine.id}>
              <span className="pill-symbol"><Pill size={17} /></span>
              <div><strong>{medicine.name}</strong><small>Залишок: {medicine.quantity}; мінімум: {medicine.minimumQuantity}</small></div>
              <button className="buy-tag" onClick={() => void saveMedicine({ ...medicine, shoppingStatus: 'done', purchaseDoneAt: new Date().toISOString() })} type="button">Позначити купленим</button>
              <button aria-label={'Редагувати ' + medicine.name} className="dots" onClick={() => openMedicineEditor(medicine)} type="button"><Edit3 size={16} /></button>
            </div>)}
          </div> : <p className="subtext">Наразі все є в достатній кількості.</p>}
          {completedPurchases.length > 0 && <p className="completed-shopping-note"><Check size={15} /> Куплено: {completedPurchases.map((medicine) => medicine.name).join(', ')}. Оновіть залишок, коли покладете покупки в аптечку.</p>}
        </section>
      </section>}

      {tab === 'trips' && <section className="page">
        <div className="page-head">
          <div>
            <p className="eyebrow">ПОДОРОЖІ</p>
            <h1>Зібратися без метушні</h1>
            <p className="subtext">Створіть подорож, а потрібні ліки додавайте до чекліста прямо з аптечки.</p>
          </div>
          <button className="primary-button" onClick={() => openTripEditor(newTrip())} type="button"><Plus size={18} />Нова подорож</button>
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
                <button onClick={() => openTripEditor(activeTrip)} type="button"><Edit3 size={14} />Редагувати</button>
                <button onClick={() => void deleteTrip(activeTrip)} type="button"><Trash2 size={14} />Видалити</button>
              </div>
            </section>

            <section className="panel">
              <div className="panel-title">
                <div><p className="eyebrow">ЧЕКЛІСТ</p><h2>Що взяти</h2></div>
                <button className="outline-button" onClick={() => openTripItemEditor(newTripItem(activeTrip.id))} type="button"><Plus size={16} />Додати</button>
              </div>
              {activeTripItems.length ? <div className="packing-list">
                {activeTripItems.map((item) => <div className={'packing-item ' + (item.packed ? 'packed' : '')} key={item.id}>
                  <button aria-label={item.packed ? 'Позначити незібраним' : 'Позначити зібраним'} className={'check ' + (item.packed ? 'checked' : '')} onClick={() => void saveTripItem({ ...item, packed: !item.packed })} type="button">{item.packed && <Check size={14} />}</button>
                  <div><span className="item-category">{item.category}</span><strong>{item.title}</strong>{item.note && <small>{item.note}</small>}</div>
                  {item.inCabinet && <span className="cabinet-tag">Є вдома</span>}
                  {item.needBuy && <button className="buy-tag" onClick={() => void saveTripItem({ ...item, bought: !item.bought })} type="button">{item.bought ? 'Куплено' : 'Купити'}</button>}
                  <button aria-label={'Редагувати ' + item.title} className="dots" onClick={() => openTripItemEditor(item)} type="button"><Edit3 size={16} /></button>
                  <button aria-label={'Видалити ' + item.title} className="dots danger-action" onClick={() => void deleteTripItem(item)} type="button"><Trash2 size={16} /></button>
                </div>)}
              </div> : <div className="empty compact-empty"><ClipboardList size={28} /><h2>Чекліст ще порожній</h2><p>Додайте речі вручну або відкрийте «Аптечку» і натисніть «Взяти в подорож».</p></div>}
            </section>
          </>}
        </> : <section className="empty">
          <MapPinned size={30} />
          <h2>Заплануйте першу подорож</h2>
          <p>Після цього ви зможете переносити ліки з аптечки до окремого чекліста.</p>
          <button className="primary-button" onClick={() => openTripEditor(newTrip())} type="button"><Plus size={17} />Створити подорож</button>
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
            <Field label={sharedCabinet ? 'Назва спільної аптечки' : 'Назва аптечки'} hint={sharedCabinet ? 'Цю назву бачать усі учасники з доступом.' : undefined}><input value={profile.household_name} onChange={(event) => setProfile((current) => ({ ...current, household_name: event.target.value }))} /></Field>
            <button className="primary-button" type="submit">Зберегти профіль</button>
          </form>
          <FamilyPanel onMembersChange={setMembers} userId={dataOwnerId} />
          <NotificationSettings medicines={medicines} userId={user.id} />
          <PinLockSettings userId={user.id} />
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

  if (passwordRecovery && user) {
    return <AuthScreen recovery onRecoveryComplete={() => {
      clearLocalPin(user.id);
      setPasswordRecovery(false);
    }} />;
  }

  if (!user) return <AuthScreen />;

  return <PinLockGate
    onForgotPin={async () => {
      await supabase!.auth.signOut();
      return false;
    }}
    userId={user.id}
  >
    <Workspace user={user} />
  </PinLockGate>;
}
