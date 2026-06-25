// Exports a FACTORY `createAdminClient` — but several callers import a singleton
// `supabaseAdmin` that was never created here. The build fails "'supabaseAdmin' is not
// exported from '@/lib/supabase/admin'". Fix needs the module AND its importers together.
import { createClient } from "@supabase/supabase-js";

export function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return createClient(url, key, { auth: { persistSession: false } });
}
