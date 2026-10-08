import { createClient } from "@supabase/supabase-js"
import { authorizePharmacy } from "../_shared/pharmacy_auth.ts"

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
}

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
const LOG_MAX = 48_000
const MESSAGE_MAX = 2_000

function jsonResponse(status: number, payload: Record<string, unknown>): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  })
}

function clip(value: unknown, max: number): string {
  const text = typeof value === "string" ? value : ""
  return text.length > max ? text.slice(text.length - max) : text
}

function referenceCode(): string {
  const bytes = new Uint8Array(4)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => ALPHABET[byte % ALPHABET.length]).join("")
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders })
  }
  if (req.method !== "POST") {
    return jsonResponse(405, { error: "method_not_allowed", message: "POST only." })
  }

  let body: Record<string, unknown> = {}
  try {
    const parsed = await req.json()
    if (parsed && typeof parsed === "object") body = parsed as Record<string, unknown>
  } catch {
    body = {}
  }

  // pharmacy_id is taken from the JWT, never from the body.
  const auth = await authorizePharmacy(req, null)
  if (!auth.ok) return auth.response
  if (auth.mode !== "user" || !auth.userId || !auth.pharmacyId) {
    return jsonResponse(403, {
      error: "pharmacy_unassigned",
      message: "No pharmacy is assigned to this account.",
    })
  }

  const messageRaw = typeof body.message === "string" ? body.message.trim() : ""
  const message = messageRaw ? messageRaw.slice(0, MESSAGE_MAX) : null
  const appVersion = clip(body.app_version, 40) || "unknown"
  const profile = clip(body.profile, 16) || "PROD"
  const osInfo = clip(body.os_info, 200) || "unknown"
  const logs = clip(body.logs, LOG_MAX)

  const url = Deno.env.get("SUPABASE_URL") ?? ""
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
  if (!url || !serviceKey) {
    console.error("[problem-report] missing_supabase_env")
    return jsonResponse(500, { error: "server_misconfigured", message: "Server auth is not configured." })
  }
  const admin = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  for (let attempt = 0; attempt < 5; attempt++) {
    const code = referenceCode()
    const { error } = await admin.from("problem_reports").insert({
      reference_code: code,
      pharmacy_id: auth.pharmacyId,
      user_id: auth.userId,
      message,
      app_version: appVersion,
      profile,
      os_info: osInfo,
      logs,
    })
    if (!error) {
      console.log(
        JSON.stringify({
          event: "problem_report",
          reference_code: code,
          pharmacy_id: auth.pharmacyId,
          user_id: auth.userId,
        }),
      )
      return jsonResponse(200, { ok: true, reference_code: code })
    }
    const unique = error.code === "23505" || String(error.message).includes("problem_reports_reference_code")
    if (!unique) {
      console.error("[problem-report] insert_failed", error.code, error.message)
      return jsonResponse(500, { error: "insert_failed", message: "Could not store the report." })
    }
  }

  return jsonResponse(500, {
    error: "reference_exhausted",
    message: "Could not allocate a reference code.",
  })
})
