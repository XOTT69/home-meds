/**
 * A small, local-only PIN credential for locking an already authenticated
 * Home Meds session on a shared device.  This is deliberately not an account
 * credential: the user's Supabase password remains the source of identity.
 */

export const MIN_PIN_LENGTH = 4;
export const MAX_PIN_LENGTH = 8;

type LegacyStoredPin = {
  version: 1;
  salt: string;
  hash: string;
  createdAt: string;
  updatedAt: string;
};

type Pbkdf2StoredPin = {
  version: 2;
  kdf: 'PBKDF2-SHA-256';
  iterations: number;
  salt: string;
  hash: string;
  createdAt: string;
  updatedAt: string;
};

type StoredPin = LegacyStoredPin | Pbkdf2StoredPin;

type StoredRetryState = {
  version: 1;
  failures: number;
  retryUntil: number;
  lastFailureAt: number;
};

export type PinVerification = 'valid' | 'invalid' | 'not-configured';

export type LocalPinRetryStatus = {
  /** Number of recent failed attempts kept only in this browser. */
  failures: number;
  /** Milliseconds before another verification may be attempted. */
  retryAfterMs: number;
};

const STORAGE_PREFIX = 'home-meds:local-pin:v1:';
const RETRY_STORAGE_PREFIX = 'home-meds:local-pin:retry:v1:';
const PBKDF2_ITERATIONS = 310_000;
const PBKDF2_HASH = 'SHA-256';
const RETRY_FREE_ATTEMPTS = 3;
const RETRY_BASE_BACKOFF_MS = 5_000;
const RETRY_MAX_BACKOFF_MS = 60_000;
const RETRY_FAILURE_WINDOW_MS = 15 * 60_000;
const encoder = new TextEncoder();

export const LOCAL_PIN_CHANGE_EVENT = 'home-meds:local-pin-change';
export type LocalPinChangeDetail = { userId: string; configured: boolean };

function storageKey(userId: string) {
  return `${STORAGE_PREFIX}${userId}`;
}

function retryStorageKey(userId: string) {
  return `${RETRY_STORAGE_PREFIX}${userId}`;
}

function getStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function announcePinChange(detail: LocalPinChangeDetail): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<LocalPinChangeDetail>(LOCAL_PIN_CHANGE_EVENT, { detail }));
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

function isLegacyStoredPin(value: unknown): value is LegacyStoredPin {
  if (!value || typeof value !== 'object') return false;
  const pin = value as Partial<LegacyStoredPin>;
  return pin.version === 1
    && typeof pin.salt === 'string'
    && typeof pin.hash === 'string'
    && typeof pin.createdAt === 'string'
    && typeof pin.updatedAt === 'string';
}

function isPbkdf2StoredPin(value: unknown): value is Pbkdf2StoredPin {
  if (!value || typeof value !== 'object') return false;
  const pin = value as Partial<Pbkdf2StoredPin>;
  return pin.version === 2
    && pin.kdf === 'PBKDF2-SHA-256'
    // Keep a corrupted local record from causing an unexpectedly expensive
    // derivation. New records use the constant above.
    && Number.isInteger(pin.iterations)
    && (pin.iterations as number) >= 100_000
    && (pin.iterations as number) <= 1_000_000
    && typeof pin.salt === 'string'
    && typeof pin.hash === 'string'
    && typeof pin.createdAt === 'string'
    && typeof pin.updatedAt === 'string';
}

function isStoredPin(value: unknown): value is StoredPin {
  return isLegacyStoredPin(value) || isPbkdf2StoredPin(value);
}

function isStoredRetryState(value: unknown): value is StoredRetryState {
  if (!value || typeof value !== 'object') return false;
  const retry = value as Partial<StoredRetryState>;
  return retry.version === 1
    && Number.isInteger(retry.failures)
    && (retry.failures as number) >= 0
    && (retry.failures as number) <= 100
    && Number.isFinite(retry.retryUntil)
    && Number.isFinite(retry.lastFailureAt);
}

function readStoredPin(userId: string): StoredPin | null {
  const storage = getStorage();
  if (!storage) return null;

  try {
    const value = storage.getItem(storageKey(userId));
    if (!value) return null;
    const parsed: unknown = JSON.parse(value);
    if (isStoredPin(parsed)) return parsed;
    storage.removeItem(storageKey(userId));
  } catch {
    // A malformed or inaccessible browser-storage record must never prevent
    // the user from reaching their authenticated account.
  }
  return null;
}

function readRetryState(userId: string): StoredRetryState | null {
  const storage = getStorage();
  if (!storage) return null;

  try {
    const value = storage.getItem(retryStorageKey(userId));
    if (!value) return null;
    const parsed: unknown = JSON.parse(value);
    if (!isStoredRetryState(parsed)) {
      storage.removeItem(retryStorageKey(userId));
      return null;
    }
    // A retry record is intentionally short-lived: it slows repeated guesses,
    // but should not punish somebody who returns later to their own device.
    if (Date.now() - parsed.lastFailureAt > RETRY_FAILURE_WINDOW_MS) {
      storage.removeItem(retryStorageKey(userId));
      return null;
    }
    if (parsed.retryUntil - Date.now() > RETRY_MAX_BACKOFF_MS) {
      storage.removeItem(retryStorageKey(userId));
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

async function hashLegacyPin(pin: string, salt: Uint8Array): Promise<string> {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi?.subtle) throw new Error('Web Crypto API is unavailable.');

  const input = encoder.encode(`home-meds/local-pin/v1\u0000${toBase64(salt)}\u0000${pin}`);
  const digest = await cryptoApi.subtle.digest('SHA-256', input);
  return toBase64(new Uint8Array(digest));
}

async function derivePbkdf2Pin(pin: string, salt: Uint8Array, iterations = PBKDF2_ITERATIONS): Promise<string> {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi?.subtle) throw new Error('Web Crypto API is unavailable.');

  const keyMaterial = await cryptoApi.subtle.importKey(
    'raw',
    encoder.encode(`home-meds/local-pin/v2\u0000${pin}`),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const derivedBits = await cryptoApi.subtle.deriveBits({
    name: 'PBKDF2',
    hash: PBKDF2_HASH,
    salt: toArrayBuffer(salt),
    iterations,
  }, keyMaterial, 256);
  return toBase64(new Uint8Array(derivedBits));
}

function constantTimeEqual(left: string, right: string): boolean {
  // JavaScript cannot guarantee constant-time execution, but avoiding an early
  // return keeps this comparison predictable for this local convenience lock.
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

export function isLocalPinSupported(): boolean {
  return typeof window !== 'undefined'
    && typeof window.localStorage !== 'undefined'
    && Boolean(globalThis.crypto?.subtle);
}

export function validatePin(pin: string): string | null {
  if (!new RegExp(`^\\d{${MIN_PIN_LENGTH},${MAX_PIN_LENGTH}}$`).test(pin)) {
    return `PIN має містити від ${MIN_PIN_LENGTH} до ${MAX_PIN_LENGTH} цифр.`;
  }
  return null;
}

export function hasLocalPin(userId: string): boolean {
  return Boolean(readStoredPin(userId));
}

export function getLocalPinRetryStatus(userId: string): LocalPinRetryStatus {
  const retry = readRetryState(userId);
  if (!retry) return { failures: 0, retryAfterMs: 0 };
  return {
    failures: retry.failures,
    retryAfterMs: Math.max(0, retry.retryUntil - Date.now()),
  };
}

/**
 * Record a rejected local PIN attempt. This is only a browser-local brake on
 * casual guessing; clearing site data removes it, so it is not an account
 * authentication rate limiter.
 */
export function recordLocalPinFailure(userId: string): LocalPinRetryStatus {
  const storage = getStorage();
  if (!storage) return { failures: 0, retryAfterMs: 0 };

  try {
    const previous = readRetryState(userId);
    const failures = Math.min((previous?.failures ?? 0) + 1, 100);
    const delayExponent = failures - RETRY_FREE_ATTEMPTS - 1;
    const retryAfterMs = delayExponent < 0
      ? 0
      : Math.min(RETRY_BASE_BACKOFF_MS * (2 ** delayExponent), RETRY_MAX_BACKOFF_MS);
    const now = Date.now();
    const record: StoredRetryState = {
      version: 1,
      failures,
      retryUntil: now + retryAfterMs,
      lastFailureAt: now,
    };
    storage.setItem(retryStorageKey(userId), JSON.stringify(record));
    return { failures, retryAfterMs };
  } catch {
    return { failures: 0, retryAfterMs: 0 };
  }
}

export function clearLocalPinFailures(userId: string): void {
  try {
    getStorage()?.removeItem(retryStorageKey(userId));
  } catch {
    // Best effort only. The PIN itself remains available even if this fails.
  }
}

async function makePbkdf2Record(pin: string, createdAt: string): Promise<Pbkdf2StoredPin> {
  const salt = new Uint8Array(16);
  globalThis.crypto.getRandomValues(salt);
  const now = new Date().toISOString();
  return {
    version: 2,
    kdf: 'PBKDF2-SHA-256',
    iterations: PBKDF2_ITERATIONS,
    salt: toBase64(salt),
    hash: await derivePbkdf2Pin(pin, salt),
    createdAt,
    updatedAt: now,
  };
}

async function upgradeLegacyPin(userId: string, pin: string, legacy: LegacyStoredPin): Promise<void> {
  const storage = getStorage();
  if (!storage || !isLocalPinSupported()) return;
  const upgraded = await makePbkdf2Record(pin, legacy.createdAt);
  // Do not overwrite a PIN that may have been changed while the derivation ran.
  const latest = readStoredPin(userId);
  if (!latest || latest.version !== 1 || latest.hash !== legacy.hash || latest.salt !== legacy.salt) return;
  storage.setItem(storageKey(userId), JSON.stringify(upgraded));
}

export async function setLocalPin(userId: string, pin: string): Promise<void> {
  const error = validatePin(pin);
  if (error) throw new Error(error);
  const storage = getStorage();
  if (!storage || !isLocalPinSupported()) {
    throw new Error('Локальне зберігання PIN недоступне в цьому браузері.');
  }

  const existing = readStoredPin(userId);
  const record = await makePbkdf2Record(pin, existing?.createdAt ?? new Date().toISOString());
  storage.setItem(storageKey(userId), JSON.stringify(record));
  clearLocalPinFailures(userId);
  announcePinChange({ userId, configured: true });
}

export async function verifyLocalPin(userId: string, pin: string): Promise<PinVerification> {
  const record = readStoredPin(userId);
  if (!record) return 'not-configured';
  try {
    const salt = fromBase64(record.salt);
    const hash = record.version === 1
      ? await hashLegacyPin(pin, salt)
      : await derivePbkdf2Pin(pin, salt, record.iterations);
    if (!constantTimeEqual(hash, record.hash)) return 'invalid';
    // Existing SHA-256 records remain usable and are upgraded after their next
    // successful unlock, without asking the owner to choose another PIN.
    if (record.version === 1) await upgradeLegacyPin(userId, pin, record);
    return 'valid';
  } catch {
    return 'invalid';
  }
}

export function clearLocalPin(userId: string): void {
  try {
    getStorage()?.removeItem(storageKey(userId));
    clearLocalPinFailures(userId);
    announcePinChange({ userId, configured: false });
  } catch {
    // Best effort: a local PIN should not make account logout impossible.
  }
}
