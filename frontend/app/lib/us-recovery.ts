import { supabase } from "./supabase";

export async function requestUSRecovery(email: string, origin: string) {
  if (!supabase) throw new Error("US authentication is not configured.");
  const redirect = new URL("/us/recover", origin);
  if (!["https:", "http:"].includes(redirect.protocol)) throw new Error("Invalid recovery destination.");
  try {
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo: redirect.href });
    if (error) throw error;
  } catch {
    throw new Error("The recovery request could not be completed. Please retry later.");
  }
}

export async function updateUSRecoveredPassword(password: string, confirmation: string, recoverySession: boolean) {
  if (!supabase || !recoverySession) throw new Error("Open a valid recovery link before updating your password.");
  if (password.length < 12 || password !== confirmation) throw new Error("Use at least 12 characters and matching passwords.");
  try {
    const { error } = await supabase.auth.updateUser({ password });
    if (error) throw error;
  } catch {
    throw new Error("The password update was not confirmed. Request a fresh link or check the password policy.");
  }
}
