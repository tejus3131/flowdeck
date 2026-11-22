// Slack-style user status: emoji + text + expiry, saved presets, DND,
// and work hours. The SERVER owns writes (RLS: own row only); the client
// keeps a cache for gating toasts the instant a status changes.
import { createSignal } from 'solid-js';
import { createSupabaseRequestClient } from '../server/supabase';

export type StatusPreset = { emoji: string | null; label: string | null; dnd: boolean };

export type MyStatus = {
  emoji: string | null;
  label: string | null;
  /** ISO — when the current status clears itself (null = until removed). */
  clearAt: string | null;
  dnd: boolean;
  presets: StatusPreset[];
  workStart: string | null;
  workEnd: string | null;
  workdays: number[];
};

export type PublicStatus = Pick<MyStatus, 'emoji' | 'label' | 'clearAt' | 'dnd'>;

const EMPTY: MyStatus = {
  emoji: null,
  label: null,
  clearAt: null,
  dnd: false,
  presets: [],
  workStart: null,
  workEnd: null,
  workdays: [1, 2, 3, 4, 5],
};

/** True when the saved status is still in effect (expiry respected). */
function isActive(status: { clearAt: string | null }): boolean {
  return status.clearAt === null || new Date(status.clearAt).getTime() > Date.now();
}

// ── the client cache (this device's own status, for toast gating) ─────────

const [myStatus, setMyStatus] = createSignal<MyStatus | null>(null);
export { myStatus };

/** Refresh the cache from the server (call on mount; cheap). */
export async function refreshMyStatus(): Promise<void> {
  try {
    setMyStatus(await getMyStatus());
  } catch {
    // statuses are decoration — never block anything on them
  }
}

/** Is DND silencing notifications right now? */
export function dndActive(): boolean {
  const status = myStatus();
  return Boolean(status?.dnd && isActive({ clearAt: status.clearAt }));
}

/** Work hours (local device time): true when the user is INSIDE them. */
export function insideWorkHours(): boolean {
  const status = myStatus();
  if (!status?.workStart || !status.workEnd) return true; // unset = always
  const now = new Date();
  const day = now.getDay() === 0 ? 7 : now.getDay(); // 1..7 (Mon..Sun)
  if (!status.workdays.includes(day)) return false;
  const minutes = now.getHours() * 60 + now.getMinutes();
  const parse = (value: string): number => {
    const [h, m] = value.split(':').map(Number);
    return (h ?? 0) * 60 + (m ?? 0);
  };
  return minutes >= parse(status.workStart) && minutes < parse(status.workEnd);
}

// ── server functions ───────────────────────────────────────────────────────

export async function getMyStatus(): Promise<MyStatus> {
  'use server';
  const supabase = createSupabaseRequestClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return EMPTY;
  const { data } = await supabase
    .from('user_status')
    .select('emoji, label, clear_at, dnd, presets, work_start, work_end, workdays')
    .eq('user_id', user.id)
    .maybeSingle();
  if (!data) return EMPTY;
  return {
    emoji: data.emoji ?? null,
    label: data.label ?? null,
    clearAt: data.clear_at ?? null,
    dnd: data.dnd ?? false,
    presets: (data.presets ?? []) as StatusPreset[],
    workStart: data.work_start ?? null,
    workEnd: data.work_end ?? null,
    workdays: (data.workdays ?? []) as number[],
  };
}

/** Set (or clear) the status. `minutes` null = until removed. */
export async function setStatus(input: {
  emoji?: string | null;
  label?: string | null;
  /** Minutes until it clears itself; null/undefined = no limit. */
  minutes?: number | null;
  dnd?: boolean;
}): Promise<MyStatus> {
  'use server';
  const supabase = createSupabaseRequestClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Sign in first');
  const row = {
    user_id: user.id,
    emoji: input.emoji ?? null,
    label: input.label?.slice(0, 60) ?? null,
    dnd: Boolean(input.dnd),
    updated_at: new Date().toISOString(),
    clear_at:
      input.minutes && input.minutes > 0
        ? new Date(Date.now() + input.minutes * 60_000).toISOString()
        : null,
  };
  const { error } = await supabase.from('user_status').upsert(row, { onConflict: 'user_id' });
  if (error) throw new Error(error.message);
  const next = await getMyStatus();
  setMyStatus(next);
  return next;
}

/** Save the current status as a one-click preset. */
export async function saveStatusPreset(preset: StatusPreset): Promise<MyStatus> {
  'use server';
  const supabase = createSupabaseRequestClient();
  const current = await getMyStatus();
  const presets = [
    ...current.presets.filter(
      (entry) => !(entry.emoji === preset.emoji && entry.label === preset.label),
    ),
    { emoji: preset.emoji ?? null, label: preset.label?.slice(0, 60) ?? null, dnd: Boolean(preset.dnd) },
  ].slice(0, 8);
  const { error } = await supabase
    .from('user_status')
    .upsert(
      { user_id: (await supabase.auth.getUser()).data.user!.id, presets, updated_at: new Date().toISOString() },
      { onConflict: 'user_id' },
    );
  if (error) throw new Error(error.message);
  const next = await getMyStatus();
  setMyStatus(next);
  return next;
}

export async function deleteStatusPreset(index: number): Promise<MyStatus> {
  'use server';
  const supabase = createSupabaseRequestClient();
  const current = await getMyStatus();
  const presets = current.presets.filter((_, i) => i !== index);
  const { error } = await supabase
    .from('user_status')
    .upsert(
      { user_id: (await supabase.auth.getUser()).data.user!.id, presets, updated_at: new Date().toISOString() },
      { onConflict: 'user_id' },
    );
  if (error) throw new Error(error.message);
  const next = await getMyStatus();
  setMyStatus(next);
  return next;
}

/** Work hours ('09:00'–'17:30', Monday=1..Sunday=7); null clears them. */
export async function setWorkHours(input: {
  start?: string | null;
  end?: string | null;
  workdays?: number[];
}): Promise<MyStatus> {
  'use server';
  const supabase = createSupabaseRequestClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Sign in first');
  const { error } = await supabase
    .from('user_status')
    .upsert(
      {
        user_id: user.id,
        work_start: input.start ?? null,
        work_end: input.end ?? null,
        workdays: input.workdays ?? [1, 2, 3, 4, 5],
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id' },
    );
  if (error) throw new Error(error.message);
  const next = await getMyStatus();
  setMyStatus(next);
  return next;
}

/** Another user's live status (hover cards, profile pages). */
export async function statusOf(userId: string): Promise<PublicStatus | null> {
  'use server';
  const supabase = createSupabaseRequestClient();
  const { data } = await supabase
    .from('user_status')
    .select('emoji, label, clear_at, dnd')
    .eq('user_id', userId)
    .maybeSingle();
  if (!data) return null;
  const status: PublicStatus = {
    emoji: data.emoji ?? null,
    label: data.label ?? null,
    clearAt: data.clear_at ?? null,
    dnd: data.dnd ?? false,
  };
  return isActive({ clearAt: status.clearAt }) ? status : null;
}
