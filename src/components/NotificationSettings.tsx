import { Bell, BellOff, LoaderCircle, RefreshCw, WifiOff } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  deriveExpiryReminders,
  getBrowserNotificationAvailability,
  notifyExpiryReminders,
  requestNotificationPermissionFromUserGesture,
  type BrowserNotificationAvailability,
  type ExpiryInput,
  type ExpiryReminderCheckResult,
  type MedicationExpiryLike,
} from '../lib/notifications';
import styles from './NotificationSettings.module.css';

export type NotificationSettingsProps<T extends MedicationExpiryLike> = {
  /** Stable signed-in account id used to scope the local once-a-day protection. */
  userId: string;
  medicines: readonly T[];
  /** Default: 30 calendar days. */
  daysBeforeExpiry?: number;
  /** Show up to this many notifications per manual/automatic check. Default: 3. */
  maxNotifications?: number;
  /** Check medicines when this component mounts after permission has already been granted. Default: true. */
  autoCheck?: boolean;
  className?: string;
  getId?: (medicine: T, index: number) => string | number | null | undefined;
  getName?: (medicine: T, index: number) => string | null | undefined;
  getExpiry?: (medicine: T, index: number) => ExpiryInput;
  onPermissionChange?: (availability: BrowserNotificationAvailability) => void;
  onCheck?: (result: ExpiryReminderCheckResult<T>) => void;
};

function getPermissionMessage(availability: BrowserNotificationAvailability): string {
  if (!availability.supported) return 'Цей браузер не підтримує системні сповіщення.';
  if (availability.permission === 'denied') return 'Сповіщення заблоковано в налаштуваннях браузера.';
  if (availability.permission === 'default') return 'Дозвольте сповіщення, щоб не пропустити термін придатності.';
  return 'Нагадування про термін придатності увімкнено.';
}

function getResultMessage<T>(result: ExpiryReminderCheckResult<T>): string {
  if (result.availability.permission !== 'granted') return getPermissionMessage(result.availability);
  if (result.delivered.length) {
    return `Надіслано нагадувань: ${result.delivered.length}.`;
  }
  if (result.failed.length) return 'Не вдалося показати нагадування. Спробуйте ще раз або перевірте налаштування браузера.';
  if (result.duplicates.length) return 'Нагадування для цих ліків уже показані сьогодні.';
  if (result.reminders.length) return 'Нагадування відкладено, щоб не надсилати забагато одночасно.';
  return 'Найближчих термінів придатності не знайдено.';
}

/**
 * Drop-in profile/settings panel for expiry notifications.
 * Its permission request is only attached to the "Увімкнути" click handler.
 */
export function NotificationSettings<T extends MedicationExpiryLike>({
  userId,
  medicines,
  daysBeforeExpiry = 30,
  maxNotifications = 3,
  autoCheck = true,
  className,
  getId,
  getName,
  getExpiry,
  onPermissionChange,
  onCheck,
}: NotificationSettingsProps<T>) {
  const [availability, setAvailability] = useState<BrowserNotificationAvailability>(getBrowserNotificationAvailability);
  const [isRequesting, setIsRequesting] = useState(false);
  const [isChecking, setIsChecking] = useState(false);
  const [result, setResult] = useState<ExpiryReminderCheckResult<T> | null>(null);

  const reminders = useMemo(
    () => deriveExpiryReminders(medicines, { daysBeforeExpiry, getId, getName, getExpiry }),
    [daysBeforeExpiry, getExpiry, getId, getName, medicines],
  );

  const refreshAvailability = useCallback(() => {
    setAvailability(getBrowserNotificationAvailability());
  }, []);

  const checkForReminders = useCallback(async () => {
    setIsChecking(true);
    const next = await notifyExpiryReminders(medicines, {
      userId,
      daysBeforeExpiry,
      maxNotifications,
      getId,
      getName,
      getExpiry,
    });
    setAvailability(next.availability);
    setResult(next);
    onCheck?.(next);
    setIsChecking(false);
  }, [daysBeforeExpiry, getExpiry, getId, getName, maxNotifications, medicines, onCheck, userId]);

  const requestPermission = async () => {
    setIsRequesting(true);
    // This invocation happens synchronously from the button's click handler.
    const next = await requestNotificationPermissionFromUserGesture();
    setAvailability(next);
    onPermissionChange?.(next);
    setIsRequesting(false);

    if (next.permission === 'granted') await checkForReminders();
  };

  useEffect(() => {
    refreshAvailability();
    window.addEventListener('online', refreshAvailability);
    window.addEventListener('offline', refreshAvailability);
    return () => {
      window.removeEventListener('online', refreshAvailability);
      window.removeEventListener('offline', refreshAvailability);
    };
  }, [refreshAvailability]);

  useEffect(() => {
    onPermissionChange?.(availability);
  }, [availability, onPermissionChange]);

  useEffect(() => {
    if (autoCheck && availability.permission === 'granted' && medicines.length) {
      void checkForReminders();
    }
  }, [autoCheck, availability.permission, checkForReminders, medicines.length]);

  const classNames = [styles.settings, className].filter(Boolean).join(' ');
  const muted = !availability.supported || availability.permission === 'denied';

  return (
    <section className={classNames} aria-label="Налаштування сповіщень">
      <div className={styles.header}>
        <span className={`${styles.icon} ${muted ? styles.iconMuted : ''}`} aria-hidden="true">
          {muted ? <BellOff size={20} /> : <Bell size={20} />}
        </span>
        <div className={styles.copy}>
          <h2 className={styles.title}>Нагадування про термін придатності</h2>
          <p className={styles.description}>{getPermissionMessage(availability)}</p>
          {!availability.online && <p className={styles.offline}><WifiOff size={14} /> Ви офлайн: локальна перевірка працює, але фонові push-нагадування недоступні.</p>}
        </div>
      </div>

      <div className={styles.actions}>
        {availability.permission === 'default' && (
          <button className={styles.button} type="button" onClick={() => void requestPermission()} disabled={isRequesting}>
            {isRequesting ? <LoaderCircle size={15} className="spin" /> : <Bell size={15} />}
            Увімкнути сповіщення
          </button>
        )}
        {availability.permission === 'granted' && (
          <button className={styles.secondaryButton} type="button" onClick={() => void checkForReminders()} disabled={isChecking}>
            {isChecking ? <LoaderCircle size={15} className="spin" /> : <RefreshCw size={15} />}
            Перевірити терміни
          </button>
        )}
      </div>

      {result && <p className={`${styles.result} ${result.failed.length ? styles.warning : ''}`} role="status">{getResultMessage(result)}</p>}
      {availability.permission === 'granted' && !result && (
        <p className={styles.status}>
          {reminders.length ? `Уваги потребують ліки: ${reminders.length}.` : 'Найближчих термінів придатності не знайдено.'}
        </p>
      )}
      <p className={styles.hint}>Перевірка виконується, коли Home Meds відкрито. Одне нагадування для ліків показується не частіше разу на день.</p>
    </section>
  );
}
