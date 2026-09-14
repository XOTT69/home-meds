import { AlertCircle, Check, ClipboardCopy, Crown, Link2, LoaderCircle, RefreshCw, ShieldCheck, Trash2, UserPlus, UsersRound } from 'lucide-react';
import { type FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabase';
import styles from './HouseholdSharingPanel.module.css';

type UnknownRecord = Record<string, unknown>;

export type HouseholdCollaborator = {
  userId: string;
  name: string;
  email: string;
  role: string;
  joinedAt?: string;
};

export type HouseholdDetails = {
  id: string;
  inviteCode: string;
  ownerUserId: string;
  name: string;
  currentRole: string;
  collaborators: HouseholdCollaborator[];
};

/** Compact access state intended for the parent workspace's shared-data loader. */
export type HouseholdAccessState = {
  household_id: string;
  owner_user_id: string;
  role: 'owner' | 'editor';
  invite_code?: string | null;
};

export type HouseholdSharingPanelProps = {
  /** Authenticated Supabase user id. The RPCs use this identity server-side. */
  userId: string;
  className?: string;
  /**
   * Receives access data after every successful load/create/join/remove action.
   * The parent can use it to reload the shared medicine, trips, and family data.
   */
  onHouseholdChange?: (household: HouseholdAccessState | null) => void;
};

type Message = { text: string; error?: boolean } | null;

const emptyHousehold = (): HouseholdDetails => ({
  id: '',
  inviteCode: '',
  ownerUserId: '',
  name: '',
  currentRole: '',
  collaborators: [],
});

function asRecord(value: unknown): UnknownRecord | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as UnknownRecord : null;
}

function pickString(record: UnknownRecord | null, keys: readonly string[]): string {
  if (!record) return '';
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function pickArray(record: UnknownRecord | null, keys: readonly string[]): unknown[] {
  if (!record) return [];
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

function normalizeRole(value: string): string {
  const role = value.trim().toLowerCase();
  if (role === 'owner' || role === 'admin') return 'owner';
  if (role === 'editor' || role === 'write') return 'editor';
  return 'member';
}

function roleLabel(role: string): string {
  if (role === 'owner') return 'Власник';
  if (role === 'editor') return 'Редактор';
  return 'Учасник';
}

function normalizeCollaborator(value: unknown): HouseholdCollaborator | null {
  const record = asRecord(value);
  if (!record) return null;
  const nestedProfile = asRecord(record.profile) ?? asRecord(record.user) ?? asRecord(record.member);
  const userId = pickString(record, ['user_id', 'member_user_id', 'userId', 'profile_id'])
    || pickString(nestedProfile, ['id', 'user_id']);
  if (!userId) return null;

  const email = pickString(record, ['email', 'user_email']) || pickString(nestedProfile, ['email']);
  const name = pickString(record, ['display_name', 'name', 'full_name'])
    || pickString(nestedProfile, ['display_name', 'name', 'full_name'])
    || email
    || 'Учасник родини';

  return {
    userId,
    name,
    email,
    role: normalizeRole(pickString(record, ['role', 'member_role']) || pickString(nestedProfile, ['role'])),
    joinedAt: pickString(record, ['joined_at', 'created_at', 'joinedAt']) || undefined,
  };
}

/**
 * The SQL RPC can return either a JSON object ({ household, members }) or a
 * single record. Supporting both keeps this UI independent from the exact
 * Postgres return signature and makes migrations easier to evolve.
 */
function normalizeHousehold(value: unknown, userId: string): HouseholdDetails | null {
  const root = Array.isArray(value) ? asRecord(value[0]) : asRecord(value);
  if (!root) return null;

  const embedded = asRecord(root.household) ?? asRecord(root.data) ?? root;
  const id = pickString(embedded, ['id', 'household_id', 'householdId']) || pickString(root, ['household_id', 'householdId']);
  const inviteCode = pickString(embedded, ['invite_code', 'inviteCode', 'join_code', 'joinCode'])
    || pickString(root, ['invite_code', 'inviteCode', 'join_code', 'joinCode']);
  const ownerUserId = pickString(embedded, ['owner_user_id', 'owner_id', 'ownerUserId'])
    || pickString(root, ['owner_user_id', 'owner_id', 'ownerUserId']);

  // A null/empty RPC result means this user has not joined or created a household yet.
  if (!id && !inviteCode && !ownerUserId && !pickArray(root, ['members', 'collaborators', 'household_members']).length) return null;

  const rootMembers = pickArray(root, ['members', 'collaborators', 'household_members']);
  const rawMembers = rootMembers.length
    ? rootMembers
    : pickArray(embedded, ['members', 'collaborators', 'household_members']);
  const collaborators = rawMembers.map(normalizeCollaborator).filter((member): member is HouseholdCollaborator => Boolean(member));
  const currentRole = normalizeRole(
    pickString(root, ['current_role', 'role', 'member_role'])
      || collaborators.find((member) => member.userId === userId)?.role
      || (ownerUserId === userId ? 'owner' : 'member'),
  );

  return {
    id,
    inviteCode,
    ownerUserId,
    name: pickString(embedded, ['name', 'household_name', 'title']) || pickString(root, ['name', 'household_name', 'title']),
    currentRole,
    collaborators,
  };
}

function toAccessState(household: HouseholdDetails): HouseholdAccessState {
  return {
    household_id: household.id,
    owner_user_id: household.ownerUserId,
    role: household.currentRole === 'owner' ? 'owner' : 'editor',
    invite_code: household.inviteCode || null,
  };
}

function getErrorMessage(error: unknown, fallback: string): string {
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') {
    return error.message;
  }
  return fallback;
}

function initials(value: string): string {
  const words = value.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '•';
  return words.slice(0, 2).map((word) => word[0]).join('').toUpperCase();
}

async function copyText(value: string): Promise<boolean> {
  if (!value) return false;
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    // Clipboard is unavailable in some embedded browsers. Keep the code visible
    // so it can still be selected and copied manually.
    return false;
  }
}

export function HouseholdSharingPanel({ userId, className, onHouseholdChange }: HouseholdSharingPanelProps) {
  const [household, setHousehold] = useState<HouseholdDetails | null>(null);
  const [joinCode, setJoinCode] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isCreating, setIsCreating] = useState(false);
  const [isJoining, setIsJoining] = useState(false);
  const [removingUserId, setRemovingUserId] = useState<string | null>(null);
  const [message, setMessage] = useState<Message>(null);

  const refreshHousehold = useCallback(async (showSuccess = false) => {
    if (!supabase) {
      setIsLoading(false);
      setMessage({ text: 'Підключіть Supabase, щоб увімкнути спільний доступ.', error: true });
      return;
    }

    setIsLoading(true);
    const { data, error } = await supabase.rpc('home_meds_get_household');
    setIsLoading(false);
    if (error) {
      setMessage({ text: getErrorMessage(error, 'Не вдалося завантажити доступ родини.'), error: true });
      return;
    }

    const parsed = normalizeHousehold(data, userId);
    setHousehold(parsed);
    onHouseholdChange?.(parsed ? toAccessState(parsed) : null);
    if (showSuccess) setMessage({ text: 'Дані родини оновлено.' });
  }, [onHouseholdChange, userId]);

  useEffect(() => {
    void refreshHousehold();
  }, [refreshHousehold]);

  const isOwner = Boolean(household && (household.ownerUserId === userId || household.currentRole === 'owner'));
  const members = useMemo(() => {
    if (!household) return [];
    // Some minimal RPCs omit the owner from the members array. Show the current
    // owner once so the UI still accurately explains who controls the invitation.
    if (isOwner && !household.collaborators.some((member) => member.userId === userId)) {
      return [{ userId, name: 'Ви', email: '', role: 'owner' }, ...household.collaborators];
    }
    return household.collaborators;
  }, [household, isOwner, userId]);

  const createHousehold = async () => {
    if (!supabase) return;
    setIsCreating(true);
    setMessage(null);
    const { data, error } = await supabase.rpc('home_meds_create_household');
    setIsCreating(false);
    if (error) {
      setMessage({ text: getErrorMessage(error, 'Не вдалося створити сімейний простір.'), error: true });
      return;
    }

    const parsed = normalizeHousehold(data, userId);
    if (parsed) {
      setHousehold(parsed);
      onHouseholdChange?.(toAccessState(parsed));
    }
    setMessage({ text: 'Сімейний простір створено. Надішліть код тим, кому довіряєте.' });
    await refreshHousehold();
  };

  const joinHousehold = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!supabase) return;
    const inviteCode = joinCode.trim().toUpperCase();
    if (!inviteCode) {
      setMessage({ text: 'Введіть код запрошення.', error: true });
      return;
    }

    setIsJoining(true);
    setMessage(null);
    const { data, error } = await supabase.rpc('home_meds_join_household', { invite_code: inviteCode });
    setIsJoining(false);
    if (error) {
      setMessage({ text: getErrorMessage(error, 'Не вдалося приєднатися. Перевірте код і спробуйте ще раз.'), error: true });
      return;
    }

    const parsed = normalizeHousehold(data, userId);
    if (parsed) {
      setHousehold(parsed);
      onHouseholdChange?.(toAccessState(parsed));
    }
    setJoinCode('');
    setMessage({ text: 'Ви приєдналися до сімейної аптечки.' });
    await refreshHousehold();
  };

  const removeMember = async (member: HouseholdCollaborator) => {
    if (!supabase || !isOwner || member.userId === userId) return;
    if (!window.confirm(`Прибрати ${member.name} зі спільної аптечки? Ця людина більше не бачитиме та не зможе редагувати дані.`)) return;

    setRemovingUserId(member.userId);
    setMessage(null);
    const { error } = await supabase.rpc('home_meds_remove_household_member', { member_user_id: member.userId });
    setRemovingUserId(null);
    if (error) {
      setMessage({ text: getErrorMessage(error, 'Не вдалося прибрати учасника.'), error: true });
      return;
    }

    setHousehold((current) => current
      ? { ...current, collaborators: current.collaborators.filter((item) => item.userId !== member.userId) }
      : current);
    if (household) onHouseholdChange?.(toAccessState(household));
    setMessage({ text: `${member.name} більше не має доступу до аптечки.` });
    await refreshHousehold();
  };

  const copyInviteCode = async () => {
    const copied = await copyText(household?.inviteCode ?? '');
    setMessage(copied
      ? { text: 'Код запрошення скопійовано.' }
      : { text: 'Не вдалося скопіювати автоматично. Виділіть код і скопіюйте його вручну.', error: true });
  };

  const panelClassName = [styles.panel, className].filter(Boolean).join(' ');
  const loading = isLoading || isCreating || isJoining;

  return (
    <section aria-label="Спільний доступ до аптечки" className={panelClassName}>
      <div className={styles.header}>
        <div className={styles.heading}>
          <span aria-hidden="true" className={styles.icon}><UsersRound size={20} /></span>
          <div>
            <h2 className={styles.title}>Спільна аптечка</h2>
            <p className={styles.description}>Родина бачить однакові ліки, списки покупок і подорожі.</p>
          </div>
        </div>
        <button aria-label="Оновити дані родини" className={styles.refreshButton} disabled={loading} onClick={() => void refreshHousehold(true)} type="button">
          {isLoading ? <LoaderCircle className={styles.spin} size={16} /> : <RefreshCw size={16} />}
          <span>Оновити</span>
        </button>
      </div>

      {message && <p className={`${styles.message} ${message.error ? styles.messageError : ''}`} role="status">
        {message.error ? <AlertCircle size={16} /> : <Check size={16} />}
        {message.text}
      </p>}

      <div className={styles.body}>
        {isLoading && !household ? <p className={styles.loading}><LoaderCircle className={styles.spin} size={16} /> Завантажуємо родину…</p> : household ? <>
          <div className={styles.householdInfo}>
            <span className={styles.role}>{isOwner ? <Crown size={13} /> : <ShieldCheck size={13} />}{roleLabel(household.currentRole)}</span>
            {isOwner && <div>
              <span className={styles.label}>КОД ДЛЯ РОДИНИ</span>
              {household.inviteCode ? <div className={styles.inviteRow}>
                <code className={styles.inviteCode}>{household.inviteCode}</code>
                <button className={styles.copyButton} onClick={() => void copyInviteCode()} type="button"><ClipboardCopy size={15} /><span>Копіювати</span></button>
              </div> : <p className={styles.description}>Код запрошення ще не створено. Оновіть дані або створіть сімейний простір заново.</p>}
            </div>}
            {!isOwner && <p className={styles.description}>Власник керує кодом запрошення та доступом учасників. Ви можете додавати й редагувати спільні дані аптечки.</p>}
          </div>

          <div className={styles.memberSection}>
            <h3 className={styles.sectionTitle}>Учасники ({members.length})</h3>
            <div className={styles.members}>
              {members.length ? members.map((member) => {
                const memberIsOwner = member.role === 'owner' || member.userId === household.ownerUserId;
                const canRemove = isOwner && !memberIsOwner && member.userId !== userId;
                const removing = removingUserId === member.userId;
                return <div className={styles.member} key={member.userId}>
                  <span aria-hidden="true" className={styles.avatar}>{initials(member.name)}</span>
                  <div className={styles.memberCopy}>
                    <span className={styles.memberName}>{member.userId === userId ? `${member.name} (ви)` : member.name}</span>
                    {member.email && <span className={styles.memberMeta}>{member.email}</span>}
                  </div>
                  <span className={`${styles.memberRole} ${memberIsOwner ? styles.memberRoleOwner : ''}`}>{roleLabel(memberIsOwner ? 'owner' : member.role)}</span>
                  {canRemove && <button aria-label={`Прибрати ${member.name}`} className={styles.removeButton} disabled={removing} onClick={() => void removeMember(member)} type="button">
                    {removing ? <LoaderCircle className={styles.spin} size={15} /> : <Trash2 size={15} />}
                  </button>}
                </div>;
              }) : <div className={styles.member}><span className={styles.memberMeta}>Учасників поки немає.</span></div>}
            </div>
          </div>
        </> : <>
          <div className={styles.empty}>
            <p>Створіть сімейний простір, щоб дати близьким спільний доступ до аптечки. Вони зможуть додавати, редагувати та позначати куплене.</p>
            <button className={styles.primaryButton} disabled={isCreating} onClick={() => void createHousehold()} type="button">
              {isCreating ? <LoaderCircle className={styles.spin} size={16} /> : <Link2 size={16} />}
              Створити код запрошення
            </button>
          </div>

          <form className={styles.joinForm} onSubmit={joinHousehold}>
            <input
              aria-label="Код запрошення"
              className={styles.codeInput}
              disabled={isJoining}
              maxLength={64}
              onChange={(event) => setJoinCode(event.target.value.replace(/\s/g, '').toUpperCase())}
              placeholder="КОД ЗАПРОШЕННЯ"
              value={joinCode}
            />
            <button className={styles.secondaryButton} disabled={isJoining} type="submit">
              {isJoining ? <LoaderCircle className={styles.spin} size={16} /> : <UserPlus size={16} />}
              Приєднатися
            </button>
          </form>
        </>}
      </div>
    </section>
  );
}
