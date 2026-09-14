import { createContext, type FormEvent, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import {
  LOCAL_PIN_CHANGE_EVENT,
  clearLocalPin,
  hasLocalPin,
  isLocalPinSupported,
  setLocalPin,
  type LocalPinChangeDetail,
  validatePin,
  verifyLocalPin,
} from '../lib/localPin';
import './PinLockGate.css';

type LockPhase = 'checking' | 'setup' | 'locked' | 'unlocked';

export type PinLockContextValue = {
  hasPin: boolean;
  isLocked: boolean;
  lock: () => void;
};

const PinLockContext = createContext<PinLockContextValue | null>(null);

/** Use inside PinLockGate to add a manual "lock now" action to the UI. */
export function usePinLock(): PinLockContextValue {
  const value = useContext(PinLockContext);
  if (!value) throw new Error('usePinLock must be used inside PinLockGate.');
  return value;
}

export type PinLockGateProps = {
  /** The authenticated Supabase user id. The PIN is scoped to this browser and this user. */
  userId: string;
  children: ReactNode;
  appName?: string;
  /** Minutes of inactivity before the app locks. Set to 0 to disable idle locking. */
  idleTimeoutMs?: number;
  /** Called after a correct PIN is entered or a new PIN is created. */
  onUnlocked?: () => void;
  /**
   * Optional identity-verification flow for "forgot PIN". It must return true
   * only after the account owner has proved their identity (for example after
   * a fresh password sign-in). Returning true clears the local PIN and opens
   * setup; this component never weakens the lock by resetting it on its own.
   */
  onForgotPin?: () => Promise<boolean> | boolean;
};

function PinField({ value, onChange, label, autoFocus = false }: { value: string; onChange: (value: string) => void; label: string; autoFocus?: boolean }) {
  return <label className="pin-lock-field">
    <span>{label}</span>
    <input
      autoComplete="off"
      autoFocus={autoFocus}
      inputMode="numeric"
      maxLength={8}
      pattern="[0-9]*"
      placeholder="••••"
      type="password"
      value={value}
      onChange={(event) => onChange(event.target.value.replace(/\D/g, ''))}
    />
  </label>;
}

function LockScreen({
  appName,
  mode,
  busy,
  error,
  notice,
  pin,
  confirmation,
  onPin,
  onConfirmation,
  onSubmit,
  onForgotPin,
}: {
  appName: string;
  mode: 'setup' | 'locked';
  busy: boolean;
  error: string;
  notice: string;
  pin: string;
  confirmation: string;
  onPin: (value: string) => void;
  onConfirmation: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onForgotPin?: () => void;
}) {
  const setup = mode === 'setup';
  return <main className="pin-lock-shell">
    <section aria-labelledby="pin-lock-title" className="pin-lock-card">
      <span aria-hidden="true" className="pin-lock-icon">⌁</span>
      <p className="pin-lock-eyebrow">ЛОКАЛЬНИЙ ЗАМОК</p>
      <h1 id="pin-lock-title">{setup ? 'Створіть PIN' : 'Аптечку заблоковано'}</h1>
      <p className="pin-lock-copy">{setup
        ? `PIN захищає ${appName} на цьому пристрої після входу в акаунт.`
        : 'Введіть локальний PIN, щоб продовжити.'}</p>
      <form className="pin-lock-form" onSubmit={onSubmit}>
        <PinField autoFocus label={setup ? 'Новий PIN (4–8 цифр)' : 'PIN'} onChange={onPin} value={pin} />
        {setup && <PinField label="Повторіть PIN" onChange={onConfirmation} value={confirmation} />}
        {error && <p aria-live="polite" className="pin-lock-message pin-lock-error">{error}</p>}
        {notice && <p aria-live="polite" className="pin-lock-message pin-lock-notice">{notice}</p>}
        <button className="pin-lock-submit" disabled={busy} type="submit">
          {busy ? 'Зачекайте…' : setup ? 'Увімкнути PIN-замок' : 'Розблокувати'}
        </button>
      </form>
      {!setup && onForgotPin && <button className="pin-lock-link" disabled={busy} onClick={onForgotPin} type="button">Забули PIN?</button>}
      {setup && <p className="pin-lock-footnote">PIN зберігається лише в цьому браузері. Не використовуйте PIN від банківської картки.</p>}
    </section>
  </main>;
}

/**
 * Wrap the authenticated part of the app. A browser-local PIN is requested on
 * first use, then on every page refresh and after inactivity.
 */
export function PinLockGate({
  userId,
  children,
  appName = 'Home Meds',
  idleTimeoutMs = 5 * 60 * 1000,
  onUnlocked,
  onForgotPin,
}: PinLockGateProps) {
  const [phase, setPhase] = useState<LockPhase>('checking');
  const [hasPin, setHasPin] = useState(false);
  const [pin, setPin] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  const resetFields = useCallback(() => {
    setPin('');
    setConfirmation('');
    setError('');
  }, []);

  useEffect(() => {
    resetFields();
    setNotice('');
    if (!isLocalPinSupported()) {
      setHasPin(false);
      setPhase('unlocked');
      return;
    }
    const configured = hasLocalPin(userId);
    setHasPin(configured);
    setPhase(configured ? 'locked' : 'setup');
  }, [resetFields, userId]);

  useEffect(() => {
    const updatePinState = (event: Event) => {
      const detail = (event as CustomEvent<LocalPinChangeDetail>).detail;
      if (!detail || detail.userId !== userId) return;
      setHasPin(detail.configured);
      if (!detail.configured) {
        resetFields();
        setPhase('setup');
      }
    };
    window.addEventListener(LOCAL_PIN_CHANGE_EVENT, updatePinState);
    return () => window.removeEventListener(LOCAL_PIN_CHANGE_EVENT, updatePinState);
  }, [resetFields, userId]);

  const lock = useCallback(() => {
    if (!hasPin) return;
    resetFields();
    setNotice('');
    setPhase('locked');
  }, [hasPin, resetFields]);

  useEffect(() => {
    if (phase !== 'unlocked' || !hasPin || idleTimeoutMs <= 0) return;
    let lastActivityAt = Date.now();
    const noteActivity = () => { lastActivityAt = Date.now(); };
    const checkIdle = () => {
      if (Date.now() - lastActivityAt >= idleTimeoutMs) {
        lock();
      }
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') checkIdle();
    };
    const events: Array<keyof WindowEventMap> = ['pointerdown', 'keydown', 'touchstart', 'wheel'];
    events.forEach((eventName) => window.addEventListener(eventName, noteActivity, { passive: true }));
    document.addEventListener('visibilitychange', onVisibilityChange);
    const interval = window.setInterval(checkIdle, Math.min(idleTimeoutMs, 30_000));
    return () => {
      events.forEach((eventName) => window.removeEventListener(eventName, noteActivity));
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.clearInterval(interval);
    };
  }, [hasPin, idleTimeoutMs, lock, phase]);

  const unlock = useCallback(() => {
    resetFields();
    setNotice('');
    setPhase('unlocked');
    onUnlocked?.();
  }, [onUnlocked, resetFields]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError('');
    setNotice('');
    if (phase === 'setup') {
      const validationError = validatePin(pin);
      if (validationError) return setError(validationError);
      if (pin !== confirmation) return setError('PIN не збігаються. Спробуйте ще раз.');
      setBusy(true);
      try {
        await setLocalPin(userId, pin);
        setHasPin(true);
        unlock();
      } catch (setupError) {
        setError(setupError instanceof Error ? setupError.message : 'PIN не вдалося зберегти.');
      } finally {
        setBusy(false);
      }
      return;
    }

    if (phase !== 'locked') return;
    const validationError = validatePin(pin);
    if (validationError) return setError(validationError);
    setBusy(true);
    try {
      const result = await verifyLocalPin(userId, pin);
      if (result === 'valid') {
        unlock();
      } else if (result === 'not-configured') {
        setHasPin(false);
        setPhase('setup');
        setNotice('Створіть новий PIN для цього браузера.');
      } else {
        setError('Невірний PIN. Спробуйте ще раз.');
      }
    } finally {
      setBusy(false);
    }
  };

  const recover = async () => {
    if (!onForgotPin) return;
    setBusy(true);
    setError('');
    try {
      const verified = await onForgotPin();
      if (!verified) {
        setError('Підтвердження особи не завершено. PIN залишився без змін.');
        return;
      }
      clearLocalPin(userId);
      setHasPin(false);
      resetFields();
      setNotice('Особу підтверджено. Створіть новий локальний PIN.');
      setPhase('setup');
    } catch {
      setError('Не вдалося підтвердити особу. Спробуйте ще раз.');
    } finally {
      setBusy(false);
    }
  };

  const context = useMemo<PinLockContextValue>(() => ({
    hasPin,
    isLocked: phase !== 'unlocked',
    lock,
  }), [hasPin, lock, phase]);

  if (phase === 'checking') {
    return <main className="pin-lock-loading" aria-live="polite">Перевіряємо захист…</main>;
  }

  return <PinLockContext.Provider value={context}>
    {phase === 'unlocked'
      ? children
      : <LockScreen
          appName={appName}
          busy={busy}
          confirmation={confirmation}
          error={error}
          mode={phase}
          notice={notice}
          onConfirmation={setConfirmation}
          onForgotPin={onForgotPin ? () => void recover() : undefined}
          onPin={setPin}
          onSubmit={(event) => void submit(event)}
          pin={pin}
        />}
  </PinLockContext.Provider>;
}

/**
 * A profile/settings panel for changing or removing a local PIN. It can be
 * used independently, but is normally rendered inside PinLockGate.
 */
export function PinLockSettings({ userId, className = '' }: { userId: string; className?: string }) {
  const [configured, setConfigured] = useState(() => hasLocalPin(userId));
  const [mode, setMode] = useState<'idle' | 'change' | 'remove' | 'create'>('idle');
  const [currentPin, setCurrentPin] = useState('');
  const [newPin, setNewPin] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setConfigured(hasLocalPin(userId));
    setMode('idle');
    setCurrentPin('');
    setNewPin('');
    setConfirmation('');
  }, [userId]);

  const cancel = () => {
    setMode('idle');
    setCurrentPin('');
    setNewPin('');
    setConfirmation('');
    setError('');
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError('');
    setMessage('');
    setBusy(true);
    try {
      if (mode === 'remove') {
        const verified = await verifyLocalPin(userId, currentPin);
        if (verified !== 'valid') return setError('Введіть чинний PIN, щоб вимкнути замок.');
        clearLocalPin(userId);
        setConfigured(false);
        cancel();
        setMessage('Локальний PIN-замок вимкнено.');
        return;
      }

      const validationError = validatePin(newPin);
      if (validationError) return setError(validationError);
      if (newPin !== confirmation) return setError('Нові PIN не збігаються.');
      if (mode === 'change') {
        const verified = await verifyLocalPin(userId, currentPin);
        if (verified !== 'valid') return setError('Введіть чинний PIN, щоб його змінити.');
      }
      await setLocalPin(userId, newPin);
      setConfigured(true);
      cancel();
      setMessage(mode === 'create' ? 'Локальний PIN-замок увімкнено.' : 'PIN оновлено.');
    } catch (pinError) {
      setError(pinError instanceof Error ? pinError.message : 'Не вдалося оновити PIN.');
    } finally {
      setBusy(false);
    }
  };

  if (!isLocalPinSupported()) {
    return <section className={`pin-settings ${className}`.trim()}>
      <div><strong>Локальний PIN</strong><p>Цей браузер не підтримує безпечне локальне зберігання PIN.</p></div>
    </section>;
  }

  return <section className={`pin-settings ${className}`.trim()}>
    <div className="pin-settings-heading">
      <div><p className="pin-lock-eyebrow">ЗАХИСТ ПРИСТРОЮ</p><strong>Локальний PIN</strong><p>{configured ? 'Попросить PIN після оновлення сторінки або бездіяльності.' : 'PIN ще не налаштований у цьому браузері.'}</p></div>
      {mode === 'idle' && <div className="pin-settings-actions">
        <button className="pin-settings-button" onClick={() => setMode(configured ? 'change' : 'create')} type="button">{configured ? 'Змінити' : 'Створити'}</button>
        {configured && <button className="pin-settings-link danger" onClick={() => setMode('remove')} type="button">Вимкнути</button>}
      </div>}
    </div>
    {message && <p aria-live="polite" className="pin-lock-message pin-lock-notice">{message}</p>}
    {mode !== 'idle' && <form className="pin-settings-form" onSubmit={(event) => void submit(event)}>
      {mode === 'remove' ? <>
        <p>Після вимкнення PIN цей браузер відкриватиме аптечку одразу після входу в акаунт.</p>
        <PinField autoFocus label="Чинний PIN" onChange={setCurrentPin} value={currentPin} />
      </> : <>
        {mode === 'change' && <PinField autoFocus label="Чинний PIN" onChange={setCurrentPin} value={currentPin} />}
        <PinField autoFocus={mode === 'create'} label="Новий PIN (4–8 цифр)" onChange={setNewPin} value={newPin} />
        <PinField label="Повторіть новий PIN" onChange={setConfirmation} value={confirmation} />
      </>}
      {error && <p aria-live="polite" className="pin-lock-message pin-lock-error">{error}</p>}
      <div className="pin-settings-actions">
        <button className="pin-lock-submit" disabled={busy} type="submit">{busy ? 'Зачекайте…' : mode === 'remove' ? 'Вимкнути PIN' : 'Зберегти PIN'}</button>
        <button className="pin-settings-link" disabled={busy} onClick={cancel} type="button">Скасувати</button>
      </div>
    </form>}
  </section>;
}
