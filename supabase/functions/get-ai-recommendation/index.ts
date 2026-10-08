import { createClient } from "@supabase/supabase-js"
import { authorizePharmacy } from "../_shared/pharmacy_auth.ts"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const PHOENIX_COLLECTOR_URL = Deno.env.get("PHOENIX_COLLECTOR_URL")
const PHOENIX_API_KEY = Deno.env.get("PHOENIX_API_KEY")

type SpanAttrs = Record<string, string | number | boolean>
type SpanStatus = "UNSET" | "OK" | "ERROR"

type LocalSpan = {
  name: string
  startNs: bigint
  attrs: SpanAttrs
  status: SpanStatus
  statusMessage: string
}

function nowNs(): bigint {
  return BigInt(Date.now()) * 1_000_000n
}

function randomBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size)
  crypto.getRandomValues(bytes)
  return bytes
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

function encodeVarint(value: number | bigint): Uint8Array {
  let n = typeof value === "bigint" ? value : BigInt(value)
  const bytes: number[] = []
  while (n >= 0x80n) {
    bytes.push(Number((n & 0x7fn) | 0x80n))
    n >>= 7n
  }
  bytes.push(Number(n))
  return new Uint8Array(bytes)
}

function encodeKey(fieldNumber: number, wireType: number): Uint8Array {
  return encodeVarint((fieldNumber << 3) | wireType)
}

function encodeLenDelimited(fieldNumber: number, payload: Uint8Array): Uint8Array {
  return concatBytes([
    encodeKey(fieldNumber, 2),
    encodeVarint(payload.length),
    payload,
  ])
}

function encodeString(fieldNumber: number, value: string): Uint8Array {
  return encodeLenDelimited(fieldNumber, new TextEncoder().encode(value))
}

function encodeBytes(fieldNumber: number, value: Uint8Array): Uint8Array {
  return encodeLenDelimited(fieldNumber, value)
}

function encodeFixed64(fieldNumber: number, value: bigint): Uint8Array {
  const buf = new Uint8Array(8)
  const view = new DataView(buf.buffer)
  view.setBigUint64(0, value, true)
  return concatBytes([encodeKey(fieldNumber, 1), buf])
}

function encodeVarintField(fieldNumber: number, value: number | bigint): Uint8Array {
  return concatBytes([encodeKey(fieldNumber, 0), encodeVarint(value)])
}

function encodeAnyValue(value: string | number | boolean): Uint8Array {
  if (typeof value === "string") {
    return encodeString(1, value)
  }
  if (typeof value === "boolean") {
    return encodeVarintField(2, value ? 1 : 0)
  }
  if (Number.isInteger(value)) {
    return encodeVarintField(3, BigInt(value))
  }
  // double_value = 4, little-endian
  const buf = new Uint8Array(8)
  new DataView(buf.buffer).setFloat64(0, value, true)
  return concatBytes([encodeKey(4, 1), buf])
}

function encodeKeyValue(key: string, value: string | number | boolean): Uint8Array {
  return concatBytes([
    encodeString(1, key),
    encodeLenDelimited(2, encodeAnyValue(value)),
  ])
}

function buildOtlpProtobuf(span: LocalSpan, endNs: bigint): Uint8Array {
  const attributeMessages = Object.entries(span.attrs).map(([key, value]) =>
    encodeLenDelimited(9, encodeKeyValue(key, value))
  )

  const statusCode = span.status === "OK" ? 1 : span.status === "ERROR" ? 2 : 0
  const statusParts = [encodeVarintField(3, statusCode)]
  if (span.statusMessage) {
    statusParts.unshift(encodeString(2, span.statusMessage))
  }

  const spanMessage = concatBytes([
    encodeBytes(1, randomBytes(16)), // trace_id
    encodeBytes(2, randomBytes(8)), // span_id
    encodeString(5, span.name),
    encodeVarintField(6, 1), // SpanKind.INTERNAL
    encodeFixed64(7, span.startNs),
    encodeFixed64(8, endNs),
    ...attributeMessages,
    encodeLenDelimited(15, concatBytes(statusParts)),
  ])

  const scope = encodeString(1, "pharmabuddy-get-ai-recommendation")
  const scopeSpans = concatBytes([
    encodeLenDelimited(1, scope),
    encodeLenDelimited(2, spanMessage),
  ])

  const resource = concatBytes([
    encodeLenDelimited(1, encodeKeyValue("service.name", "pharmabuddy-get-ai-recommendation")),
    encodeLenDelimited(1, encodeKeyValue("openinference.project.name", "PharmaBuddy")),
  ])
  const resourceSpans = concatBytes([
    encodeLenDelimited(1, resource),
    encodeLenDelimited(2, scopeSpans),
  ])

  return encodeLenDelimited(1, resourceSpans)
}

async function exportPhoenixSpan(span: LocalSpan): Promise<void> {
  if (!PHOENIX_COLLECTOR_URL) return

  try {
    const body = buildOtlpProtobuf(span, nowNs())
    const headers: Record<string, string> = {
      "Content-Type": "application/x-protobuf",
    }
    if (PHOENIX_API_KEY) {
      headers.authorization = `Bearer ${PHOENIX_API_KEY}`
    }

    const response = await fetch(PHOENIX_COLLECTOR_URL, {
      method: "POST",
      headers,
      body,
    })
    const text = await response.text()
    console.log(
      "[get-ai-recommendation] phoenix_export_status",
      response.status,
      text.slice(0, 200),
    )
  } catch (error) {
    console.error(
      "[get-ai-recommendation] phoenix_export_error",
      error instanceof Error ? error.message : String(error),
    )
  }
}

function sumNullable(...values: Array<number | null | undefined>): number | null {
  let total = 0
  let sawValue = false
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      total += value
      sawValue = true
    }
  }
  return sawValue ? total : null
}

function applyOpenInferenceLlmAttrs(
  span: LocalSpan,
  args: {
    modelName: string
    prompt: string
    completion: string
    promptTokens: number | null
    completionTokens: number | null
    totalTokens: number | null
    costUsd: number | null
  },
) {
  span.attrs["openinference.span.kind"] = "LLM"
  span.attrs["llm.model_name"] = args.modelName
  span.attrs["llm.provider"] = "openrouter"
  span.attrs["llm.system"] = "google"
  span.attrs["input.value"] = args.prompt
  span.attrs["output.value"] = args.completion
  span.attrs["llm.prompt"] = args.prompt
  span.attrs["llm.completion"] = args.completion
  span.attrs["llm.input_messages.0.message.role"] = "user"
  span.attrs["llm.input_messages.0.message.content"] = args.prompt
  span.attrs["llm.output_messages.0.message.role"] = "assistant"
  span.attrs["llm.output_messages.0.message.content"] = args.completion

  if (args.promptTokens != null) {
    span.attrs["llm.token_count.prompt"] = args.promptTokens
  }
  if (args.completionTokens != null) {
    span.attrs["llm.token_count.completion"] = args.completionTokens
  }
  if (args.totalTokens != null) {
    span.attrs["llm.token_count.total"] = args.totalTokens
  } else if (args.promptTokens != null || args.completionTokens != null) {
    span.attrs["llm.token_count.total"] =
      (args.promptTokens ?? 0) + (args.completionTokens ?? 0)
  }

  if (args.costUsd != null) {
    span.attrs["llm.cost.total"] = args.costUsd
    const promptTokens = args.promptTokens
    const completionTokens = args.completionTokens
    const totalForSplit =
      args.totalTokens && args.totalTokens > 0
        ? args.totalTokens
        : (promptTokens ?? 0) + (completionTokens ?? 0)
    if (totalForSplit > 0 && promptTokens != null && completionTokens != null) {
      const promptShare = promptTokens / totalForSplit
      span.attrs["llm.cost.prompt"] = args.costUsd * promptShare
      span.attrs["llm.cost.completion"] = args.costUsd * (1 - promptShare)
    }
  }
}

function buildFallbackRecommendation(productName: string, aiContext: string, variationKey: string): string {
  const variantIndex = Array.from(variationKey).reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % 3

  if (aiContext.includes("ATC Code: J01")) {
    const variants = [
      `Για το ${productName}, μπορείτε να προτείνετε κι ένα προβιοτικό για καλύτερη προστασία του εντερικού μικροβιώματος κατά τη διάρκεια της αγωγής. Είναι μια πρακτική προσθήκη που βοηθά στην καλύτερη ανοχή της θεραπείας.`,
      `Μαζί με το ${productName}, μια καλή συμπληρωματική πρόταση είναι ένα προβιοτικό για υποστήριξη του εντέρου κατά την αγωγή. Έτσι ο ασθενής συχνά νιώθει καλύτερη καθημερινή άνεση και συμμόρφωση στη θεραπεία.`,
      `Στο ${productName}, μπορείτε να προσθέσετε πρόταση για προβιοτικό ώστε να ενισχυθεί η ισορροπία του μικροβιώματος. Είναι μια ασφαλής και χρήσιμη συνοδευτική επιλογή για πολλούς ασθενείς.`
    ]
    return variants[variantIndex]
  }

  if (
    aiContext.toLowerCase().includes("cardio") ||
    aiContext.toLowerCase().includes("cholesterol") ||
    aiContext.toLowerCase().includes("atc code: c")
  ) {
    const variants = [
      `Για το ${productName}, μπορείτε να προτείνετε CoQ10 ως συμπληρωματική υποστήριξη στην καθημερινή αγωγή. Είναι μια χρήσιμη επιλογή για ασθενείς που ζητούν επιπλέον υποστήριξη ενέργειας και καρδιαγγειακής ευεξίας.`,
      `Μαζί με το ${productName}, μια ισορροπημένη πρόταση είναι CoQ10 για επιπλέον μεταβολική και καρδιαγγειακή υποστήριξη. Συχνά οι ασθενείς το επιλέγουν ως πρακτικό συμπλήρωμα της βασικής τους αγωγής.`,
      `Στο ${productName}, μπορείτε να προσθέσετε πρόταση για CoQ10 ώστε να ενισχυθεί η συνολική ενεργειακή υποστήριξη. Είναι μια ευγενική και στοχευμένη σύσταση που ταιριάζει σε καρδιομεταβολικό προφίλ.`
    ]
    return variants[variantIndex]
  }

  if (aiContext.toLowerCase().includes("food supplement") || aiContext.toLowerCase().includes("vitamin")) {
    const variants = [
      `Μαζί με το ${productName}, προτείνετε ένα συμπληρωματικό προϊόν που ενισχύει τη συνολική κάλυψη του οργανισμού. Έτσι ο ασθενής λαμβάνει πιο ολοκληρωμένη καθημερινή υποστήριξη.`,
      `Για το ${productName}, μπορείτε να συστήσετε μια φυσική συμπληρωματική επιλογή που ταιριάζει με τον ίδιο στόχο ευεξίας. Με αυτόν τον τρόπο ο ασθενής αποκτά πιο ολοκληρωμένη υποστήριξη στην καθημερινότητα.`,
      `Στο ${productName}, μια καλή πρόταση είναι ένα συμβατό συμπλήρωμα που ενισχύει την ήδη υπάρχουσα αγωγή ή φροντίδα. Είναι μια απλή κίνηση που αυξάνει την αντιλαμβανόμενη αξία για τον ασθενή.`
    ]
    return variants[variantIndex]
  }

  const variants = [
    `Μαζί με το ${productName}, μπορείτε να προτείνετε ένα κατάλληλο συμπλήρωμα για υποστήριξη της θεραπείας. Είναι μια ήπια και πρακτική πρόταση που συχνά βελτιώνει τη συνολική φροντίδα του ασθενούς.`,
    `Για το ${productName}, αξίζει να προτείνετε και μια στοχευμένη συμπληρωματική επιλογή με βάση τις ανάγκες του ασθενούς. Έτσι η φαρμακευτική συμβουλή γίνεται πιο ολοκληρωμένη και εξατομικευμένη.`,
    `Στο ${productName}, μπορείτε να προσθέσετε πρόταση για ένα συμβατό συμπλήρωμα που υποστηρίζει τη γενική πορεία της αγωγής. Πρόκειται για μια πρακτική και φιλική σύσταση με έμφαση στην καθημερινή φροντίδα.`
  ]
  return variants[variantIndex]
}

function hasCompleteTwoSentences(text: string): boolean {
  const normalized = text.replace(/\s+/g, " ").trim()
  if (normalized.length < 60) {
    return false
  }

  const sentenceCount = normalized
    .split(/[.!;;]+/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0).length

  const endsWithPunctuation = /[.!;;]$/.test(normalized)
  return sentenceCount >= 2 && endsWithPunctuation
}

const BLANK_FACTS = new Set(["", "N/A", "Δεν αναφέρεται"])

function cleanFact(value: unknown, max = 500): string {
  if (typeof value !== "string") return ""
  const text = value.replace(/\s+/g, " ").trim()
  if (BLANK_FACTS.has(text)) return ""
  return text.slice(0, max)
}

function preferFact(current: string, incoming: unknown, max = 240): string {
  if (!BLANK_FACTS.has(current)) return current
  return cleanFact(incoming, max) || current
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  const span: LocalSpan = {
    name: "gemini-cross-selling-request",
    startNs: nowNs(),
    attrs: {},
    status: "UNSET",
    statusMessage: "",
  }

  try {
    const {
      barcode,
      pharmacy_id,
      include_debug,
      product_name: clientProductName,
      lookup_only,
      side_effects: clientSideEffects,
      active_ingredient: clientActiveIngredient,
      atc_code: clientAtcCode,
    } = await req.json()

    if (!barcode) {
      span.status = "OK"
      return new Response(JSON.stringify({ error: "Missing barcode parameter" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" }
      })
    }

    span.attrs["pharmabuddy.barcode"] = String(barcode)

    const legacyPharmacyId = typeof pharmacy_id === "string" && pharmacy_id.trim()
      ? pharmacy_id.trim()
      : null
    const auth = await authorizePharmacy(req, legacyPharmacyId)
    if (!auth.ok) {
      span.status = auth.status >= 500 ? "ERROR" : "OK"
      span.statusMessage = auth.error
      return auth.response
    }

    const resolvedPharmacyId = auth.pharmacyId
    if (auth.userId) span.attrs["pharmabuddy.user_id"] = auth.userId
    if (resolvedPharmacyId) span.attrs["pharmabuddy.pharmacy_id"] = resolvedPharmacyId
    console.log(
      lookup_only === true
        ? "[get-ai-recommendation] lookup_call"
        : "[get-ai-recommendation] recommendation_call",
      JSON.stringify({
        pharmacy_id: resolvedPharmacyId,
        user_id: auth.userId,
        barcode: String(barcode),
      }),
    )

    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    let productName = "Unknown Product"
    let aiContext = ""
    let activeIngredient = "Δεν αναφέρεται"
    let atcCode = "Δεν αναφέρεται"
    let sideEffects = ""

    if (resolvedPharmacyId) {
      const { data: customItem } = await supabaseClient
        .from('pharmacy_custom_mappings')
        .select('custom_name, supplement_category')
        .eq('pharmacy_id', resolvedPharmacyId)
        .eq('barcode', barcode)
        .single()

      if (customItem) {
        productName = String(customItem.custom_name ?? "")
        aiContext = `Type: Food Supplement/Vitamin. Category: ${customItem.supplement_category}.`
      }
    }

    if (!aiContext) {
      const { data: globalItem } = await supabaseClient
        .from('global_product_catalog')
        .select('name, product_type, metadata')
        .eq('barcode', barcode)
        .single()

      if (globalItem) {
        productName = String(globalItem.name ?? "")
        const meta = (globalItem.metadata ?? {}) as Record<string, string>
        activeIngredient = meta.active_ingredient || "Δεν αναφέρεται"
        atcCode = meta.atc_code || "Δεν αναφέρεται"
        sideEffects = cleanFact(meta.side_effects)
        aiContext = `Type: ${globalItem.product_type}. Active Ingredient: ${activeIngredient}. ATC Code: ${atcCode}.`
        console.log("[get-ai-recommendation] catalog_hit", JSON.stringify({ barcode, product_name: productName }))
      } else if (clientProductName) {
        productName = String(clientProductName).trim()
        aiContext = `Type: Unknown (manual entry). Active Ingredient: Δεν αναφέρεται. ATC Code: Δεν αναφέρεται.`
        console.log("[get-ai-recommendation] manual_name", JSON.stringify({ barcode, product_name: productName }))
      } else if (lookup_only) {
        span.status = "OK"
        return new Response(JSON.stringify({
          found: false, product_name: null, active_ingredient: null, atc_code: null, side_effects: null
        }), {
          status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" }
        })
      } else {
        span.status = "OK"
        return new Response(JSON.stringify({
          success: false,
          message: "Barcode not found in catalog."
        }), {
          status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" }
        })
      }
    }

    activeIngredient = preferFact(activeIngredient, clientActiveIngredient)
    atcCode = preferFact(atcCode, clientAtcCode, 16)
    if (!sideEffects) sideEffects = cleanFact(clientSideEffects)
    if (sideEffects) {
      aiContext = `${aiContext} Side effects excerpt: ${sideEffects}`
    }

    span.attrs["pharmabuddy.product_name"] = productName

    if (lookup_only) {
      span.status = "OK"
      return new Response(JSON.stringify({
        found: true,
        product_name: productName,
        active_ingredient: activeIngredient,
        atc_code: atcCode,
        side_effects: sideEffects || null,
      }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" }
      })
    }

    const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY")
    if (!OPENROUTER_API_KEY) {
      throw new Error("Missing OPENROUTER_API_KEY cloud environment secret key.")
    }

    const primaryModel = "google/gemini-3.5-flash"
    const fallbackModel = "google/gemini-2.0-flash-001"

    const callOpenRouter = async (
      modelId: string,
      messages: Array<{ role: "system" | "user"; content: string }>,
      localTemperature: number
    ) => {
      const response = await fetch(
        "https://openrouter.ai/api/v1/chat/completions",
        {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
            "Content-Type": "application/json",
            "HTTP-Referer": "https://pharmabuddy.gr",
            "X-Title": "PharmaBuddy Assistant"
          },
          body: JSON.stringify({
            model: modelId,
            messages,
            temperature: localTemperature,
            usage: { include: true },
          })
        }
      )

      const data = await response.json()
      const choices = Array.isArray(data?.choices) ? data.choices : []
      const finishReason = data?.choices?.[0]?.finish_reason ?? "UNKNOWN"
      const messageContent = data?.choices?.[0]?.message?.content
      const text = typeof messageContent === "string"
        ? messageContent.trim()
        : ""

      const usage = data?.usage ?? null
      const openRouterResponseId = typeof data?.id === "string" ? data.id : null
      let costUsd =
        typeof usage?.cost === "number" ? usage.cost
        : typeof usage?.total_cost === "number" ? usage.total_cost
        : typeof data?.total_cost === "number" ? data.total_cost
        : null

      // Chat response sometimes omits cost; generation stats usually has total_cost.
      if (costUsd == null && openRouterResponseId) {
        try {
          await new Promise((resolve) => setTimeout(resolve, 350))
          const genRes = await fetch(
            `https://openrouter.ai/api/v1/generation?id=${encodeURIComponent(openRouterResponseId)}`,
            { headers: { Authorization: `Bearer ${OPENROUTER_API_KEY}` } },
          )
          if (genRes.ok) {
            const genJson = await genRes.json()
            const gen = genJson?.data ?? genJson
            const genCost = gen?.total_cost ?? gen?.usage ?? gen?.native_cost
            if (typeof genCost === "number" && Number.isFinite(genCost)) {
              costUsd = genCost
            }
          }
        } catch (error) {
          console.error(
            "[get-ai-recommendation] openrouter_generation_cost_error",
            error instanceof Error ? error.message : String(error),
          )
        }
      }

      console.log(
        "[get-ai-recommendation] openrouter_usage",
        JSON.stringify({
          model: modelId,
          prompt_tokens: usage?.prompt_tokens ?? null,
          completion_tokens: usage?.completion_tokens ?? null,
          cost: costUsd,
          generation_id: openRouterResponseId,
        }),
      )

      return {
        text,
        finishReason,
        httpStatus: response.status,
        httpOk: response.ok,
        candidateCount: choices.length,
        rawError: data?.error ?? null,
        promptFeedback: null,
        usageMetadata: usage,
        modelUsed: modelId,
        openRouterResponseId,
        providerName: data?.provider_name ?? data?.provider ?? null,
        promptTokens: typeof usage?.prompt_tokens === "number" ? usage.prompt_tokens : null,
        completionTokens: typeof usage?.completion_tokens === "number" ? usage.completion_tokens : null,
        totalTokens: typeof usage?.total_tokens === "number" ? usage.total_tokens : null,
        costUsd,
      }
    }

    const systemInstruction = `Είσαι ένας κορυφαίος, έμπειρος φαρμακοποιός στην Ελλάδα με τεράστια εξειδίκευση στο cross-selling (συμπληρωματική πώληση) στον πάγκο του φαρμακείου.
    Σκοπός σου είναι να γράψεις ΜΙΑ ΠΕΙΣΤΙΚΗ, ΦΥΣΙΚΗ ΚΑΙ ΣΥΝΤΟΜΗ ΠΡΟΤΑΣΗ (1-2 προτάσεις το πολύ) σε ζωντανό, προφορικό ελληνικό λόγο, την οποία θα διαβάσει ο φαρμακοποιός στον πελάτη μόλις σκανάρει το φάρμακο. Μπες κατευθείαν στο ψητό, χωρίς γενικόλογους χαιρετισμούς.

    Ανάκρινε τα στοιχεία του φαρμάκου (Δραστική Ουσία, Κωδικός ATC, απόσπασμα ανεπιθύμητων ενεργειών) και εφάρμοσε ΑΥΣΤΗΡΑ τους εξΗΣ κανόνες:
    1. ΑΝΤΙΒΙΩΣΗ (Ο Κωδικός ATC ξεκινάει από "J01" Ή η Δραστική Ουσία / Όνομα περιέχει: CIPROFLOXACIN, HEXAQUIN, AMOXICILLIN, CEFACLOR, CLARITHROMYCIN, ZINADOL, AUGMENTIN): Πρότεινε ΑΥΣΤΗΡΑ και ΜΟΝΟ ένα ποιοτικό ΠΡΟΒΙΟΤΙΚΟ για την προστασία του στομάχου και της εντερικής χλωρίδας από την αντιβίωση.
    2. ΧΟΛΗΣΤΕΡΙΝΗ / ΣΤΑΤΙΝΗ (Ο Κωδικός ATC ξεκινάει από "C10" Ή η Δραστική Ουσία περιέχει STATIN / ATORVASTATIN / ROSUVASTATIN): Πρότεινε ΑΥΣΤΗΡΑ και ΜΟΝΟ ΣΥΝΕΝΖΥΜΟ Q10 (CoQ10), εξηγώντας ότι προλαμβάνει τις μυαλγίες, τους πόνους στους μύες και την κόπωση που προκαλεί η θεραπεία.
    3. ΓΑΣΤΡΟΠΡΟΣΤΑΣΙΑ / ΑΝΤΙΟΞΙΝΑ (Ο Κωδικός ATC ξεκινάει από "A02", π.χ. Omeprazole, Pantoprazole): Πρότεινε Βιταμίνη B12 ή Μαγνήσιο, καθώς η μακροχρόνια χρήση μειώνει την απορρόφησή τους.
    4. ΑΝΤΙΔΙΑΒΗΤΙΚΑ (Ο Κωδικός ATC ξεκινάει από "A10", π.χ. Metformin): Πρότεινε Σύμπλεγμα Βιταμινών Β (ειδικά Β12) ή Άλφα Λιποϊκό Οξύ.

    ΓΕΝΙΚΟΣ ΚΑΝΟΝΑΣ (Αν το φάρμακο δεν ανήκει στα παραπάνω):
    Βρες ένα συγκεκριμένο συμπλήρωμα που ταιριάζει ιατρικά (π.χ. Μαγνήσιο για αντιυπερτασικά/άγχος, Βιταμίνη D3 για οστεοπόρωση). ΑΠΑΓΟΡΕΥΕΤΑΙ να πεις τη φράση "ένα κατάλληλο συμπλήρωμα". Ονόμασε το προϊόν ξεκάθαρα!

    ΠΑΡΕΝΕΡΓΕΙΕΣ:
    Αν υπάρχει απόσπασμα ανεπιθύμητων ενεργειών, μπορείς να αναφέρεις ΜΙΑ σχετική παρενέργεια μόνο όταν στηρίζει τη συμπληρωματική πρόταση. Μην εφευρίσκεις παρενέργειες και μην αντιγράφεις ολόκληρη τη λίστα. Αν το απόσπασμα λείπει ή δεν σχετίζεται, μην τις αναφέρεις.

    Στυλ απάντησης:
    - Ξεκίνα ΠΑΝΤΑ κάπως έτσι: "Επειδή ξεκινάτε/παίρνετε το [Όνομα Φαρμάκου]..." ή "Με το [Όνομα Φαρμάκου] καλό είναι να συνδυάσουμε..."
    - Ο λόγος να είναι σύντομος, προφορικός και απόλυτα πωλησιακός.
    - Επίστρεψε ΜΟΝΟ το λεκτικό της πρότασης στα Ελληνικά, τίποτα άλλο.`;

    const variationKey = crypto.randomUUID()
    const sideEffectsLine = sideEffects || "Δεν αναφέρονται"

    const prompt = `Στοιχεία σκαναρισμένου φαρμάκου:
    Όνομα Προϊόντος: ${productName}
    Δραστική Ουσία: ${activeIngredient}
    Κωδικός ATC: ${atcCode}
    Ανεπιθύμητες ενέργειες (απόσπασμα ΠΧΠ, μπορεί να είναι ελλιπές): ${sideEffectsLine}

    Γράψε την προφορική ατάκα φαρμακείου βάσει των οδηγιών σου.
    Variation key: ${variationKey}`;

    span.attrs["llm.prompt"] = prompt

    const generateRecommendation = async (localPrompt: string, localTemperature: number) => {
      const messages = [
        { role: "system" as const, content: systemInstruction },
        { role: "user" as const, content: localPrompt }
      ]

      const firstModelAttempt = await callOpenRouter(primaryModel, messages, localTemperature)
      const shouldTryFallback = !firstModelAttempt.httpOk

      if (shouldTryFallback) {
        return await callOpenRouter(fallbackModel, messages, localTemperature)
      }

      return firstModelAttempt
    }

    const llmStarted = Date.now()
    const firstAttempt = await generateRecommendation(prompt, 0.7)
    let secondAttempt: {
      text: string;
      finishReason: string;
      modelUsed: string;
      httpStatus: number;
      httpOk: boolean;
      candidateCount: number;
      rawError: unknown;
      promptFeedback: unknown;
      usageMetadata: unknown;
      openRouterResponseId: string | null;
      providerName: string | null;
      promptTokens: number | null;
      completionTokens: number | null;
      totalTokens: number | null;
      costUsd: number | null;
    } | null = null
    let recommendationSource = "openrouter_first_attempt"

    let finalRecommendation = firstAttempt.text
    if (finalRecommendation.trim().length < 30 || firstAttempt.finishReason.toLowerCase() !== "stop") {
      const retryPrompt = `${prompt}. Important: return exactly 2 complete Greek sentences that both end with punctuation.`
      secondAttempt = await generateRecommendation(retryPrompt, 0.6)

      if ((secondAttempt.text ?? "").trim().length > 0) {
        finalRecommendation = secondAttempt.text
        recommendationSource = "openrouter_retry_attempt"
        span.attrs["llm.prompt"] = retryPrompt
      }
    }

    span.attrs["llm.latency_ms"] = Date.now() - llmStarted

    const winningAttempt = secondAttempt && recommendationSource === "openrouter_retry_attempt"
      ? secondAttempt
      : firstAttempt
    const promptTokens = sumNullable(firstAttempt.promptTokens, secondAttempt?.promptTokens)
    const completionTokens = sumNullable(firstAttempt.completionTokens, secondAttempt?.completionTokens)
    const totalTokens = sumNullable(firstAttempt.totalTokens, secondAttempt?.totalTokens)
      ?? ((promptTokens != null || completionTokens != null)
        ? (promptTokens ?? 0) + (completionTokens ?? 0)
        : null)
    const costUsd = sumNullable(firstAttempt.costUsd, secondAttempt?.costUsd)
    const promptForTrace = String(span.attrs["llm.prompt"] ?? prompt)

    if ((finalRecommendation ?? "").trim().length === 0) {
      applyOpenInferenceLlmAttrs(span, {
        modelName: winningAttempt.modelUsed,
        prompt: promptForTrace,
        completion: "",
        promptTokens,
        completionTokens,
        totalTokens,
        costUsd,
      })
      span.status = "ERROR"
      span.statusMessage = "No text returned by model after retry."
      return new Response(JSON.stringify({
        success: false,
        error: "No text returned by model after retry.",
        debug: include_debug === true
          ? {
              source: "no_model_output",
              variation_key: variationKey,
              first_attempt: {
                model_used: firstAttempt.modelUsed,
                http_status: firstAttempt.httpStatus,
                http_ok: firstAttempt.httpOk,
                finish_reason: firstAttempt.finishReason,
                raw_error: firstAttempt.rawError
              },
              second_attempt: secondAttempt
                ? {
                    model_used: secondAttempt.modelUsed,
                    http_status: secondAttempt.httpStatus,
                    http_ok: secondAttempt.httpOk,
                    finish_reason: secondAttempt.finishReason,
                    raw_error: secondAttempt.rawError
                  }
                : null
            }
          : undefined
      }), {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      })
    }

    applyOpenInferenceLlmAttrs(span, {
      modelName: winningAttempt.modelUsed,
      prompt: promptForTrace,
      completion: finalRecommendation,
      promptTokens,
      completionTokens,
      totalTokens,
      costUsd,
    })
    span.status = "OK"

    const responsePayload: Record<string, unknown> = {
      success: true,
      product_name: productName,
      recommendation: finalRecommendation,
      side_effects: sideEffects || null,
    }

    if (include_debug === true) {
      responsePayload.debug = {
        source: recommendationSource,
        variation_key: variationKey,
        first_attempt: {
          model_used: firstAttempt.modelUsed,
          openrouter_response_id: firstAttempt.openRouterResponseId,
          provider_name: firstAttempt.providerName,
          http_status: firstAttempt.httpStatus,
          http_ok: firstAttempt.httpOk,
          candidate_count: firstAttempt.candidateCount,
          prompt_tokens: firstAttempt.promptTokens,
          completion_tokens: firstAttempt.completionTokens,
          total_tokens: firstAttempt.totalTokens,
          cost_usd: firstAttempt.costUsd,
          finish_reason: firstAttempt.finishReason,
          length: firstAttempt.text.length,
          complete_two_sentences: hasCompleteTwoSentences(firstAttempt.text),
          raw_error: firstAttempt.rawError,
          prompt_feedback: firstAttempt.promptFeedback,
          usage_metadata: firstAttempt.usageMetadata
        },
        second_attempt: secondAttempt
          ? {
              model_used: secondAttempt.modelUsed,
              openrouter_response_id: secondAttempt.openRouterResponseId,
              provider_name: secondAttempt.providerName,
              http_status: secondAttempt.httpStatus,
              http_ok: secondAttempt.httpOk,
              candidate_count: secondAttempt.candidateCount,
              prompt_tokens: secondAttempt.promptTokens,
              completion_tokens: secondAttempt.completionTokens,
              total_tokens: secondAttempt.totalTokens,
              cost_usd: secondAttempt.costUsd,
              finish_reason: secondAttempt.finishReason,
              length: secondAttempt.text.length,
              complete_two_sentences: hasCompleteTwoSentences(secondAttempt.text),
              raw_error: secondAttempt.rawError,
              prompt_feedback: secondAttempt.promptFeedback,
              usage_metadata: secondAttempt.usageMetadata
            }
          : null,
        final_complete_two_sentences: hasCompleteTwoSentences(finalRecommendation)
      }
    }

    return new Response(JSON.stringify(responsePayload), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" }
    })

  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error"
    span.status = "ERROR"
    span.statusMessage = message
    return new Response(JSON.stringify({ success: false, error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    })
  } finally {
    await exportPhoenixSpan(span)
  }
})
