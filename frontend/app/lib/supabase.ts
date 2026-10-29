import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''

// Standalone US product: never send passwords/recovery requests to an inherited project.
// Custom authentication domains require an explicit target review before support is added.
const dedicatedUSOrigin = /^https:\/\/apidhmrlawbjvisnadht\.supabase\.co(?::443)?\/?$/i.test(supabaseUrl)

export const supabase = dedicatedUSOrigin && supabaseAnonKey.trim()
  ? createClient(supabaseUrl, supabaseAnonKey)
  : null

// Subscribe at client creation so URL recovery events are not lost before React mounts.
// This is navigation state only; Supabase verifies password-update authorization.
let recoveryUserId: string | null = null;
supabase?.auth.onAuthStateChange((event, session) => {
  if (!session || event === "SIGNED_OUT" || event === "SIGNED_IN" || session.user?.id !== recoveryUserId) recoveryUserId = null;
  if (event === "PASSWORD_RECOVERY" && session?.user?.id && !session.user.is_anonymous) recoveryUserId = session.user.id;
});
export const isRecoverySession = () => recoveryUserId !== null;
