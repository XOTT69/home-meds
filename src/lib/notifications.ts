/**
 * Small, client-only helpers for expiry notifications.
 *
 * Browser notifications are not a replacement for server-side scheduled work:
 * this module checks medicines while the app is open. Permission is deliberately
 * never requested automatically; call `requestNotificationPermissionFromUserGesture`
 * directly from a click/tap handler.
 */

export type ExpiryInput = string | Date | null | undefined;

/** A permissive shape so the helpers work with the app's Med type and other data models. */
export type MedicationExpiryLike = {
  id?: string | number;
  name?: string;
  title?: string;
  label?: string;
  medicationId?: string | number;
  uuid?: string | number;
  expiry?: ExpiryInput;
  expiryDate?: ExpiryInput;
  expirationDate?: ExpiryInput;
  expiresAt?: ExpiryInput;
};

export type ReminderUrgency = 'expired' | 'today' | 'soon';

export type ExpiryReminder<T> = {
  id: string;
  medication: T;
  medicationName: string;
  expiryDate: Date;
  expiryDateKey: string;
  daysUntilExpiry: number;
  urgency: ReminderUrgency;
};

export type ExpiryReminderOptions<T> = {
  /** Include medicines expiring within this many calendar days. Defaults to 30. */
  daysBeforeExpiry?: number;
  /** Include already expired medicines. Defaults to true. */
  includeExpired?: boolean;
  /** Useful for deterministic tests and historical views. Defaults to now. */
  now?: Date;
  getId?: (medication: T, index: number) => string | number | null | undefined;
  getName?: (medication: T, index: number) => string | null | undefined;
  getExpiry?: (medication: T, index: number) => ExpiryInput;
};

export type BrowserNotificationAvailability = {
  supported: boolean;
  permission: NotificationPermission | 'unsupported';
  online: boolean;
};

export type BrowserNotificationContent = {
  title: string;
  body: string;
  tag?: string;
  data?: unknown;
};

export type BrowserNotificationResult = {
  shown: boolean;
  channel?: 'service-worker' | 'window';
  reason?: 'unsupported' | 'permission-required' | 'permission-denied' | 'failed';
  error?: unknown;
};

export type NotificationDedupeInput = {
  /** A stable account/user id. It scopes all local notification history. */
  userId: string;
  /** A stable reminder id, normally `ExpiryReminder.id`. */
  reminderId: string;
  /** Defaults to the current local calendar day. */
  date?: Date;
  /** Lets another app on the same origin use an isolated notification history. */
  namespace?: string;
};

export type ExpiryReminderCheckOptions<T> = ExpiryReminderOptions<T> & {
  userId: string;
  /** Keeps a single foreground check from overwhelming the user. Defaults to 3. */
  maxNotifications?: number;
  namespace?: string;
  notificationOptions?: Omit<NotificationOptions, 'body' | 'data' | 'tag'>;
  createContent?: (reminder: ExpiryReminder<T>) => BrowserNotificationContent;
};

export type ExpiryReminderCheckResult<T> = {
  availability: BrowserNotificationAvailability;
  reminders: ExpiryReminder<T>[];
  delivered: ExpiryReminder<T>[];
  duplicates: ExpiryReminder<T>[];
  deferred: ExpiryReminder<T>[];
  failed: Array<{ reminder: ExpiryReminder<T>; error?: unknown }>;
};

const DEFAULT_NAMESPACE = 'home-meds:expiry-notification';
const memoryHistory = new Map<string, NotificationHistoryEntry>();
const inFlightKeys = new Set<string>();

type NotificationHistoryEntry = {
  status: 'pending' | 'sent';
  at: number;
};

function hasBrowserNotificationSupport(): boolean {
  return typeof window !== 'undefined' && typeof Notification !== 'undefined';
}

function getLocalStorage(): Storage | null {
  if (typeof window === 'undefined') return null;

  try {
    const storage = window.localStorage;
    const probe = `${DEFAULT_NAMESPACE}:probe`;
    storage.setItem(probe, '1');
    storage.removeItem(probe);
    return storage;
  } catch {
    return null;
  }
}

function toLocalDate(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function isValidDate(date: Date): boolean {
  return Number.isFinite(date.getTime());
}

/** Parses date-only strings as a local calendar date, avoiding UTC off-by-one errors. */
export function parseExpiryDate(value: ExpiryInput): Date | null {
  if (value instanceof Date) return isValidDate(value) ? toLocalDate(value) : null;
  if (typeof value !== 'string') return null;

  const trimmed = value.trim();
  if (!trimmed) return null;

  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (match) {
    const [, year, month, day] = match;
    const parsed = new Date(Number(year), Number(month) - 1, Number(day));
    return parsed.getFullYear() === Number(year)
      && parsed.getMonth() === Number(month) - 1
      && parsed.getDate() === Number(day)
      ? parsed
      : null;
  }

  const parsed = new Date(trimmed);
  return isValidDate(parsed) ? toLocalDate(parsed) : null;
}

export function toDateKey(date = new Date()): string {
  const local = toLocalDate(date);
  const month = String(local.getMonth() + 1).padStart(2, '0');
  const day = String(local.getDate()).padStart(2, '0');
  return `${local.getFullYear()}-${month}-${day}`;
}

function getDefaultExpiry(medication: MedicationExpiryLike): ExpiryInput {
  return medication.expiry
    ?? medication.expiryDate
    ?? medication.expirationDate
    ?? medication.expiresAt;
}

function getDefaultName(medication: MedicationExpiryLike): string {
  const candidate = medication.name ?? medication.title ?? medication.label;
  return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : 'Ліки без назви';
}

function getDefaultId(
  medication: MedicationExpiryLike,
  index: number,
  medicationName: string,
  rawExpiry: ExpiryInput,
): string {
  const rawId = medication.id ?? medication.medicationId ?? medication.uuid;
  if (typeof rawId === 'string' || typeof rawId === 'number') return String(rawId);

  // A name/date fallback remains stable when a generic source has no explicit id.
  return `${medicationName}:${String(rawExpiry ?? index)}`;
}

function differenceInCalendarDays(target: Date, from: Date): number {
  const millisecondsPerDay = 24 * 60 * 60 * 1000;
  return Math.round((toLocalDate(target).getTime() - toLocalDate(from).getTime()) / millisecondsPerDay);
}

/**
 * Derives expiring and expired medicine reminders from a generic medication list.
 * Empty or invalid expiry values are ignored.
 */
export function deriveExpiryReminders<T extends MedicationExpiryLike>(
  medications: readonly T[],
  options: ExpiryReminderOptions<T> = {},
): ExpiryReminder<T>[] {
  const {
    daysBeforeExpiry = 30,
    includeExpired = true,
    now = new Date(),
    getId,
    getName,
    getExpiry,
  } = options;
  const safeDaysBeforeExpiry = Math.max(0, Math.floor(daysBeforeExpiry));

  return medications.flatMap((medication, index) => {
    const rawExpiry = getExpiry?.(medication, index) ?? getDefaultExpiry(medication);
    const expiryDate = parseExpiryDate(rawExpiry);
    if (!expiryDate) return [];

    const daysUntilExpiry = differenceInCalendarDays(expiryDate, now);
    if (daysUntilExpiry < 0 && !includeExpired) return [];
    if (daysUntilExpiry > safeDaysBeforeExpiry) return [];

    const medicationName = getName?.(medication, index)?.trim()
      || getDefaultName(medication);
    const id = String(getId?.(medication, index)
      ?? getDefaultId(medication, index, medicationName, rawExpiry));

    const reminder: ExpiryReminder<T> = {
      id,
      medication,
      medicationName,
      expiryDate,
      expiryDateKey: toDateKey(expiryDate),
      daysUntilExpiry,
      urgency: daysUntilExpiry < 0 ? 'expired' : daysUntilExpiry === 0 ? 'today' : 'soon',
    };
    return [reminder];
  }).sort((left, right) => left.daysUntilExpiry - right.daysUntilExpiry);
}

export function getBrowserNotificationAvailability(): BrowserNotificationAvailability {
  if (!hasBrowserNotificationSupport()) {
    return { supported: false, permission: 'unsupported', online: typeof navigator === 'undefined' || navigator.onLine !== false };
  }

  return {
    supported: true,
    permission: Notification.permission,
    online: typeof navigator === 'undefined' || navigator.onLine !== false,
  };
}

/** Call this only inside a direct click/tap handler. It never runs on page load. */
export async function requestNotificationPermissionFromUserGesture(): Promise<BrowserNotificationAvailability> {
  const availability = getBrowserNotificationAvailability();
  if (!availability.supported || availability.permission !== 'default') return availability;

  try {
    await Notification.requestPermission();
  } catch {
    // Some browsers reject rather than resolving a denied state. Return the live capability either way.
  }

  return getBrowserNotificationAvailability();
}

function historyKey({ userId, reminderId, date = new Date(), namespace = DEFAULT_NAMESPACE }: NotificationDedupeInput): string {
  return `${namespace}:${encodeURIComponent(userId)}:${toDateKey(date)}:${encodeURIComponent(reminderId)}`;
}

function readHistory(key: string): NotificationHistoryEntry | null {
  const memoryEntry = memoryHistory.get(key);
  if (memoryEntry) return memoryEntry;

  const storage = getLocalStorage();
  if (!storage) return null;

  try {
    const value = storage.getItem(key);
    if (!value) return null;
    if (value === '1') return { status: 'sent', at: 0 }; // Supports a tiny legacy footprint.
    const entry = JSON.parse(value) as Partial<NotificationHistoryEntry>;
    if ((entry.status === 'sent' || entry.status === 'pending') && typeof entry.at === 'number') {
      memoryHistory.set(key, entry as NotificationHistoryEntry);
      return entry as NotificationHistoryEntry;
    }
  } catch {
    // Storage might be unavailable or contain manually edited data. Treat it as no history.
  }

  return null;
}

function writeHistory(key: string, entry: NotificationHistoryEntry): void {
  memoryHistory.set(key, entry);
  const storage = getLocalStorage();
  if (!storage) return;

  try {
    storage.setItem(key, JSON.stringify(entry));
  } catch {
    // The in-memory history still prevents duplicates during this page session.
  }
}

function removeHistory(key: string): void {
  memoryHistory.delete(key);
  const storage = getLocalStorage();
  if (!storage) return;

  try {
    storage.removeItem(key);
  } catch {
    // Nothing else is required for a best-effort local cleanup.
  }
}

/** Returns true only for a notification that was successfully shown today. */
export function hasNotificationBeenSent(input: NotificationDedupeInput): boolean {
  return readHistory(historyKey(input))?.status === 'sent';
}

/** Clears a single local de-duplication record, mainly useful for settings/reset flows. */
export function clearNotificationHistory(input: NotificationDedupeInput): void {
  removeHistory(historyKey(input));
}

function claimNotification(input: NotificationDedupeInput): string | null {
  const key = historyKey(input);
  const existing = readHistory(key);
  const isFreshPending = existing?.status === 'pending' && Date.now() - existing.at < 5 * 60 * 1000;
  if (existing?.status === 'sent' || isFreshPending || inFlightKeys.has(key)) return null;

  inFlightKeys.add(key);
  writeHistory(key, { status: 'pending', at: Date.now() });
  return key;
}

function finishNotificationClaim(key: string, shown: boolean): void {
  inFlightKeys.delete(key);
  if (shown) writeHistory(key, { status: 'sent', at: Date.now() });
  else removeHistory(key);
}

async function getExistingServiceWorkerRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;

  try {
    return (await navigator.serviceWorker.getRegistration()) ?? null;
  } catch {
    return null;
  }
}

/** Displays a local browser notification. It uses an already-registered service worker when available. */
export async function showBrowserNotification(
  content: BrowserNotificationContent,
  options: Omit<NotificationOptions, 'body' | 'data' | 'tag'> = {},
): Promise<BrowserNotificationResult> {
  const availability = getBrowserNotificationAvailability();
  if (!availability.supported) return { shown: false, reason: 'unsupported' };
  if (availability.permission === 'default') return { shown: false, reason: 'permission-required' };
  if (availability.permission === 'denied') return { shown: false, reason: 'permission-denied' };

  const notificationOptions: NotificationOptions = {
    ...options,
    body: content.body,
    tag: content.tag,
    data: content.data,
  };

  try {
    const registration = await getExistingServiceWorkerRegistration();
    if (registration) {
      await registration.showNotification(content.title, notificationOptions);
      return { shown: true, channel: 'service-worker' };
    }
  } catch {
    // Fall through to the window API, which covers browsers without a usable registration.
  }

  try {
    new Notification(content.title, notificationOptions);
    return { shown: true, channel: 'window' };
  } catch (error) {
    return { shown: false, reason: 'failed', error };
  }
}

export function createDefaultExpiryNotificationContent<T>(
  reminder: ExpiryReminder<T>,
): BrowserNotificationContent {
  const expirationDate = reminder.expiryDate.toLocaleDateString('uk-UA', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
  const dayText = reminder.daysUntilExpiry < 0
    ? `Термін придатності минув ${Math.abs(reminder.daysUntilExpiry)} дн. тому.`
    : reminder.daysUntilExpiry === 0
      ? 'Термін придатності спливає сьогодні.'
      : `До завершення терміну придатності: ${reminder.daysUntilExpiry} дн.`;

  return {
    title: reminder.urgency === 'expired' ? `Прострочено: ${reminder.medicationName}` : `Термін придатності: ${reminder.medicationName}`,
    body: `${dayText} Дата: ${expirationDate}.`,
    tag: `home-meds-expiry-${reminder.id}`,
    data: { reminderId: reminder.id, expiryDate: reminder.expiryDateKey },
  };
}

/**
 * Derives relevant expiry reminders and displays each at most once per user, medicine and day.
 * It does not ask for permission; use `requestNotificationPermissionFromUserGesture` first.
 */
export async function notifyExpiryReminders<T extends MedicationExpiryLike>(
  medications: readonly T[],
  options: ExpiryReminderCheckOptions<T>,
): Promise<ExpiryReminderCheckResult<T>> {
  const availability = getBrowserNotificationAvailability();
  const reminders = deriveExpiryReminders(medications, options);
  const result: ExpiryReminderCheckResult<T> = {
    availability,
    reminders,
    delivered: [],
    duplicates: [],
    deferred: [],
    failed: [],
  };

  if (availability.permission !== 'granted') return result;

  const maxNotifications = Math.max(1, Math.floor(options.maxNotifications ?? 3));
  for (const reminder of reminders) {
    if (result.delivered.length >= maxNotifications) {
      result.deferred.push(reminder);
      continue;
    }

    const dedupeInput: NotificationDedupeInput = {
      userId: options.userId,
      reminderId: reminder.id,
      date: options.now,
      namespace: options.namespace,
    };
    const claim = claimNotification(dedupeInput);
    if (!claim) {
      result.duplicates.push(reminder);
      continue;
    }

    const content = (options.createContent ?? createDefaultExpiryNotificationContent)(reminder);
    const notification = await showBrowserNotification(content, options.notificationOptions);
    finishNotificationClaim(claim, notification.shown);

    if (notification.shown) result.delivered.push(reminder);
    else result.failed.push({ reminder, error: notification.error ?? notification.reason });
  }

  return result;
}
