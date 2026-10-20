import { supabase } from "./supabase";

// UI rollout switch only. The provider's signup/confirmation policy remains authoritative.
export const US_SIGNUP_ENABLED = process.env.NEXT_PUBLIC_US_SIGNUP_ENABLED === "true";

export async function requestUSSignup(email: string, password: string, confirmation: string, origin: string) {
  if (!US_SIGNUP_ENABLED || !supabase) throw new Error("US signup is not available.");
  if (password.length < 12 || password !== confirmation) throw new Error("Use at least 12 characters and matching passwords.");
  const redirect = new URL("/us/login", origin);
  if (!["https:", "http:"].includes(redirect.protocol)) throw new Error("Invalid US confirmation destination.");
  let result;
  try {
    result = await supabase.auth.signUp({ email: email.trim(), password, options: { emailRedirectTo: redirect.href } });
  } catch {
    throw new Error("The signup request could not be confirmed. Retry later or use sign-in/recovery.");
  }
  if (result.error) throw new Error("The signup request could not be confirmed. Retry later or use sign-in/recovery.");
  // Do not silently accept a deployment where signup auto-signs in without an email step.
  if (result.data.session) {
    try {
      const { error } = await supabase.auth.signOut({ scope: "local" });
      if (error) throw error;
    } catch {
      return { state: "cleanup_required" as const };
    }
    return { state: "configuration_review" as const };
  }
  // Same response for new and obfuscated existing-user results. Never enumerate identities.
  return { state: "check_email" as const };
}
