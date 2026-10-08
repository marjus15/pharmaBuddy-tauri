import { createClient, type SupabaseClient } from "@supabase/supabase-js"

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
}

export type PharmacyAuth =
  | {
      ok: true
      mode: "user" | "legacy"
      userId: string | null
      pharmacyId: string | null
      pharmacyName: string | null
    }
  | {
      ok: false
      status: number
      error: string
      response: Response
    }

function jsonResponse(status: number, payload: Record<string, unknown>): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  })
}

function denied(status: number, error: string, message: string): PharmacyAuth {
  return {
    ok: false,
    status,
    error,
    response: jsonResponse(status, { error, message }),
  }
}

function bearerToken(req: Request): string {
  const header = req.headers.get("Authorization") ?? req.headers.get("authorization") ?? ""
  return header.replace(/^Bearer\s+/i, "").trim()
}

function legacyAnonAllowed(): boolean {
  return (Deno.env.get("ALLOW_LEGACY_ANON") ?? "").trim().toLowerCase() === "true"
}

function adminClient(): SupabaseClient | null {
  const url = Deno.env.get("SUPABASE_URL") ?? ""
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
  if (!url || !serviceKey) return null
  return createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

type PharmacyRow = { id?: string; name?: string | null; active?: boolean | null }

function embeddedPharmacy(value: unknown): PharmacyRow | null {
  const row = Array.isArray(value) ? value[0] : value
  if (!row || typeof row !== "object") return null
  return row as PharmacyRow
}

async function authorizeLegacy(
  admin: SupabaseClient,
  legacyPharmacyId: string | null,
): Promise<PharmacyAuth> {
  if (!legacyPharmacyId) {
    return { ok: true, mode: "legacy", userId: null, pharmacyId: null, pharmacyName: null }
  }

  const { data: pharmacy, error } = await admin
    .from("pharmacies")
    .select("id, name, active")
    .eq("id", legacyPharmacyId)
    .maybeSingle()

  if (error) {
    console.error("[pharmacy-auth] legacy_lookup_failed", error.message)
    return denied(500, "pharmacy_lookup_failed", "Pharmacy lookup failed.")
  }

  if (!pharmacy || pharmacy.active !== true) {
    return denied(403, "license_inactive", "Pharmacy license is not active.")
  }

  return {
    ok: true,
    mode: "legacy",
    userId: null,
    pharmacyId: String(pharmacy.id),
    pharmacyName: pharmacy.name ?? null,
  }
}

/**
 * Requires a Supabase Auth user JWT, resolves pharmacy_members, and rejects
 * inactive pharmacies. Client-supplied pharmacy ids are ignored on this path.
 * ALLOW_LEGACY_ANON=true restores the previous shared anon-key behaviour.
 */
export async function authorizePharmacy(
  req: Request,
  legacyPharmacyId: string | null,
): Promise<PharmacyAuth> {
  const token = bearerToken(req)
  if (!token) {
    return denied(401, "unauthorized", "Authentication required.")
  }

  const admin = adminClient()
  if (!admin) {
    console.error("[pharmacy-auth] missing_supabase_env")
    return denied(500, "server_misconfigured", "Server auth is not configured.")
  }

  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? ""
  const { data, error } = await admin.auth.getUser(token)
  const user = data?.user ?? null

  if (error || !user) {
    if (legacyAnonAllowed() && anonKey && token === anonKey) {
      return authorizeLegacy(admin, legacyPharmacyId)
    }
    return denied(401, "unauthorized", "Authentication required.")
  }

  const { data: member, error: memberError } = await admin
    .from("pharmacy_members")
    .select("pharmacy_id, pharmacies(id, name, active)")
    .eq("user_id", user.id)
    .maybeSingle()

  if (memberError) {
    console.error("[pharmacy-auth] member_lookup_failed", memberError.message)
    return denied(500, "pharmacy_lookup_failed", "Pharmacy lookup failed.")
  }

  if (!member) {
    console.log("[pharmacy-auth] unassigned", JSON.stringify({ user_id: user.id }))
    return denied(403, "pharmacy_unassigned", "No pharmacy is assigned to this account.")
  }

  const pharmacy = embeddedPharmacy(member.pharmacies)
  const pharmacyId = pharmacy?.id ?? member.pharmacy_id
  if (!pharmacyId || pharmacy?.active !== true) {
    console.log(
      "[pharmacy-auth] inactive",
      JSON.stringify({ user_id: user.id, pharmacy_id: pharmacyId ?? null }),
    )
    return denied(403, "pharmacy_inactive", "Pharmacy account is not active.")
  }

  return {
    ok: true,
    mode: "user",
    userId: user.id,
    pharmacyId: String(pharmacyId),
    pharmacyName: pharmacy?.name ?? null,
  }
}
