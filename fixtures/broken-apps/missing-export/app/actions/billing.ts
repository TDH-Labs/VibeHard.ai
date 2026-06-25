// Imports the singleton that doesn't exist — this is the importer half of the mismatch.
import { supabaseAdmin } from "@/lib/supabase/admin";

export async function listInvoices() {
  return supabaseAdmin.from("invoices").select("*");
}
