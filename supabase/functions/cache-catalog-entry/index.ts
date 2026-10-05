import { createClient } from "@supabase/supabase-js"

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
}

const TABLE_NAME = "global_product_catalog"
const PLACEHOLDERS = new Set(["", "N/A", "Δεν αναφέρεται"])

function cleanText(value: unknown, max = 500): string {
  if (typeof value !== "string") return ""
  const text = value.replace(/\s+/g, " ").trim()
  if (PLACEHOLDERS.has(text)) return ""
  return text.slice(0, max)
}

function isBlank(value: unknown): boolean {
  return cleanText(value).length === 0
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders })
  }

  try {
    const body = await req.json()
    const cleanBarcode = String(body.barcode ?? "").trim()
    const cleanName = cleanText(body.product_name, 400)
    const source = cleanText(body.source, 40) || "galinos"
    const sideEffects = cleanText(body.side_effects)
    const activeIngredient = cleanText(body.active_ingredient, 240)
    const atcCode = cleanText(body.atc_code, 16)

    if (!/^\d+$/.test(cleanBarcode)) {
      return new Response(
        JSON.stringify({ success: false, error: "Invalid barcode" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      )
    }

    const supabaseClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    )

    const { data: existing, error: readError } = await supabaseClient
      .from(TABLE_NAME)
      .select("barcode, metadata")
      .eq("barcode", cleanBarcode)
      .maybeSingle()

    if (readError) {
      console.error("[cache-catalog-entry] read error", readError)
      return new Response(
        JSON.stringify({ success: false, error: readError.message ?? "Read failed" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      )
    }

    if (existing) {
      const meta = (existing.metadata ?? {}) as Record<string, string>
      const next = { ...meta }
      let changed = false

      if (sideEffects && isBlank(meta.side_effects)) {
        next.side_effects = sideEffects
        next.side_effects_source = "galinos_spc"
        changed = true
      }
      if (activeIngredient && isBlank(meta.active_ingredient)) {
        next.active_ingredient = activeIngredient
        changed = true
      }
      if (atcCode && isBlank(meta.atc_code)) {
        next.atc_code = atcCode
        changed = true
      }

      if (!changed) {
        console.log("[cache-catalog-entry] skip existing", cleanBarcode)
        return new Response(
          JSON.stringify({ success: true, cached: false, reason: "already_exists" }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        )
      }

      const { error } = await supabaseClient
        .from(TABLE_NAME)
        .update({ metadata: next })
        .eq("barcode", cleanBarcode)

      if (error) {
        console.error("[cache-catalog-entry] merge error", error)
        return new Response(
          JSON.stringify({ success: false, error: error.message ?? "Update failed" }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        )
      }

      console.log("[cache-catalog-entry] merged metadata", cleanBarcode)
      return new Response(
        JSON.stringify({ success: true, cached: true, reason: "metadata_merged" }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      )
    }

    if (cleanName.length < 2) {
      return new Response(
        JSON.stringify({ success: false, error: "Missing barcode or product_name" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      )
    }

    const record = {
      barcode: cleanBarcode,
      name: cleanName,
      product_type: "medicine",
      metadata: {
        active_ingredient: activeIngredient || "N/A",
        atc_code: atcCode || "N/A",
        source,
        ...(sideEffects
          ? { side_effects: sideEffects, side_effects_source: "galinos_spc" }
          : {}),
      },
    }

    const { error } = await supabaseClient.from(TABLE_NAME).insert(record)

    if (error) {
      console.error("[cache-catalog-entry] insert error", error)
      return new Response(
        JSON.stringify({ success: false, error: error.message ?? "Insert failed" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      )
    }

    console.log("[cache-catalog-entry] cached", cleanBarcode, cleanName)
    return new Response(
      JSON.stringify({ success: true, cached: true }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error"
    console.error("[cache-catalog-entry] unhandled", message)
    return new Response(
      JSON.stringify({ success: false, error: message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    )
  }
})
