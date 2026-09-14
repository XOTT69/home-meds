/**
 * A small, local-only PIN credential for locking an already authenticated
 * Home Meds session on a shared device.  This is deliberately not an account
 * credential: the user's Supabase password remains the source of identity.
 */

export const MIN_PIN_LENGTH = 4;
export const MAX_PIN_LENGTH = 8;

type StoredPin = {
  version: 1;
  salt: string;
  hash: string;
  createdAt: string;
  updatedAt: string;
};

export type PinVerification = 'valid' | 'invalid' | 'not-configured';

const STORAGE_PREFIX = 'home-meds:local-pin:v1:';
const encoder = new TextEncoder();

export const LOCAL_PIN_CHANGE_EVENT = 'home-meds:local-pin-change';
export type LocalPinChangeDetail = { userId: string; configured: boolean };

function storageKey(userId: string) {
  return `${STORAGE_PREFIX}${userId}`;
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

function isStoredPin(value: unknown): value is StoredPin {
  if (!value || typeof value !== 'object') return false;
  const pin = value as Partial<StoredPin>;
  return pin.version === 1
    && typeof pin.salt === 'string'
    && typeof pin.hash === 'string'
    && typeof pin.createdAt === 'string'
    && typeof pin.updatedAt === 'string';
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

async function hashPin(pin: string, salt: Uint8Array): Promise<string> {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi?.subtle) throw new Error('Web Crypto API is unavailable.');

  const input = encoder.encode(`home-meds/local-pin/v1\u0000${toBase64(salt)}\u0000${pin}`);
  const digest = await cryptoApi.subtle.digest('SHA-256', input);
  return toBase64(new Uint8Array(digest));
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

export async function setLocalPin(userId: string, pin: string): Promise<void> {
  const error = validatePin(pin);
  if (error) throw new Error(error);
  const storage = getStorage();
  if (!storage || !isLocalPinSupported()) {
    throw new Error('Локальне зберігання PIN недоступне в цьому браузері.');
  }

  const salt = new Uint8Array(16);
  globalThis.crypto.getRandomValues(salt);
  const now = new Date().toISOString();
  const existing = readStoredPin(userId);
  const record: StoredPin = {
    version: 1,
    salt: toBase64(salt),
    hash: await hashPin(pin, salt),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  storage.setItem(storageKey(userId), JSON.stringify(record));
  announcePinChange({ userId, configured: true });
}

export async function verifyLocalPin(userId: string, pin: string): Promise<PinVerification> {
  const record = readStoredPin(userId);
  if (!record) return 'not-configured';
  try {
    const hash = await hashPin(pin, fromBase64(record.salt));
    return constantTimeEqual(hash, record.hash) ? 'valid' : 'invalid';
  } catch {
    return 'invalid';
  }
}

export function clearLocalPin(userId: string): void {
  try {
    getStorage()?.removeItem(storageKey(userId));
    announcePinChange({ userId, configured: false });
  } catch {
    // Best effort: a local PIN should not make account logout impossible.
  }
}
