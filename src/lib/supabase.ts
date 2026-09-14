import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

export const isSupabaseConfigured = Boolean(url && key);

// The publishable key is intentionally used in the browser. Row Level Security
// in supabase/schema.sql is what prevents one user from reading another's data.
export const supabase = isSupabaseConfigured
  ? createClient(url, key, { auth: { flowType: 'pkce' } })
  : null;
