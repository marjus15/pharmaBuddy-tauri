#!/usr/bin/env node
/**
 * Create or deactivate a pharmacy login. Accounts are not created by the widget.
 *
 * Required environment (never commit the service-role key):
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *
 * Create:
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *     node scripts/create-pharmacy-user.mjs \
 *     --name "Φαρμακείο Παπαδόπουλος" \
 *     --email pilot@example.com \
 *     --password "a-long-secret"
 *
 * Deactivate (kill switch):
 *   node scripts/create-pharmacy-user.mjs --deactivate --pharmacy-id <uuid>
 *   node scripts/create-pharmacy-user.mjs --deactivate --email pilot@example.com
 *
 * Re-activate:
 *   node scripts/create-pharmacy-user.mjs --activate --pharmacy-id <uuid>
 */

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function parseArgs(argv) {
  const out = { deactivate: false, activate: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      out.help = true;
      continue;
    }
    if (arg === "--deactivate") {
      out.deactivate = true;
      continue;
    }
    if (arg === "--activate") {
      out.activate = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      throw new Error(`Unknown argument: ${arg}`);
    }
    const key = arg.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${arg}`);
    }
    out[key] = value;
    i += 1;
  }
  return out;
}

export function validateArgs(args) {
  if (args.help) return;
  if (args.deactivate && args.activate) {
    throw new Error("Use either --deactivate or --activate, not both.");
  }
  if (args.deactivate || args.activate) {
    if (!args.pharmacyId && !args.email) {
      throw new Error("Pass --pharmacy-id or --email.");
    }
    return;
  }
  if (!args.name || !args.email || !args.password) {
    throw new Error("Create requires --name, --email, and --password.");
  }
  if (String(args.password).length < 8) {
    throw new Error("Password must be at least 8 characters.");
  }
  if (!String(args.email).includes("@")) {
    throw new Error("Email must contain @. Supabase Auth uses email + password.");
  }
}

function loadEnvFile(path) {
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const idx = trimmed.indexOf("=");
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

function supabaseConfig(args) {
  if (args.envFile) loadEnvFile(args.envFile);
  loadEnvFile(".env");
  const url = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!url || !serviceKey) {
    throw new Error(
      "Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment. Do not commit the service-role key.",
    );
  }
  if (process.env.SUPABASE_ANON_KEY && serviceKey === process.env.SUPABASE_ANON_KEY) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY must not be the anon key.");
  }
  return { url, serviceKey };
}

function headers(serviceKey, prefer) {
  return {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    "Content-Type": "application/json",
    ...(prefer ? { Prefer: prefer } : {}),
  };
}

async function api(url, serviceKey, path, options = {}) {
  const response = await fetch(`${url}${path}`, {
    ...options,
    headers: {
      ...headers(serviceKey, options.prefer),
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!response.ok) {
    const detail = typeof body === "string" ? body : JSON.stringify(body);
    throw new Error(`${options.method || "GET"} ${path} failed (${response.status}): ${detail.slice(0, 400)}`);
  }
  return body;
}

async function findUserIdByEmail(url, serviceKey, email) {
  const wanted = email.trim().toLowerCase();
  for (let page = 1; page <= 10; page += 1) {
    const body = await api(url, serviceKey, `/auth/v1/admin/users?page=${page}&per_page=200`);
    const users = body?.users || [];
    const match = users.find((user) => String(user.email || "").toLowerCase() === wanted);
    if (match) return match.id;
    if (users.length < 200) break;
  }
  return null;
}

async function pharmacyIdForEmail(url, serviceKey, email) {
  const userId = await findUserIdByEmail(url, serviceKey, email);
  if (!userId) throw new Error(`No auth user found for ${email}`);
  const rows = await api(
    url,
    serviceKey,
    `/rest/v1/pharmacy_members?user_id=eq.${userId}&select=pharmacy_id`,
  );
  const pharmacyId = rows?.[0]?.pharmacy_id;
  if (!pharmacyId) throw new Error(`User ${email} is not linked to a pharmacy.`);
  return pharmacyId;
}

async function setActive(url, serviceKey, pharmacyId, active) {
  const rows = await api(url, serviceKey, `/rest/v1/pharmacies?id=eq.${pharmacyId}`, {
    method: "PATCH",
    prefer: "return=representation",
    body: JSON.stringify({ active }),
  });
  const row = Array.isArray(rows) ? rows[0] : rows;
  if (!row) throw new Error(`Pharmacy ${pharmacyId} was not updated.`);
  console.log(`${active ? "Activated" : "Deactivated"} pharmacy ${row.id} (${row.name}), active=${row.active}`);
}

async function createPharmacyUser(url, serviceKey, args) {
  const created = await api(url, serviceKey, "/auth/v1/admin/users", {
    method: "POST",
    body: JSON.stringify({
      email: args.email.trim(),
      password: args.password,
      email_confirm: true,
      user_metadata: { pharmacy_name: args.name },
    }),
  });
  const userId = created?.id || created?.user?.id;
  if (!userId) throw new Error("Auth user was created without an id.");

  let pharmacy = null;
  try {
    const rows = await api(url, serviceKey, "/rest/v1/pharmacies", {
      method: "POST",
      prefer: "return=representation",
      body: JSON.stringify({ name: args.name, active: true }),
    });
    pharmacy = Array.isArray(rows) ? rows[0] : rows;
    if (!pharmacy?.id) throw new Error("Pharmacy insert did not return an id.");
    await api(url, serviceKey, "/rest/v1/pharmacy_members", {
      method: "POST",
      prefer: "return=minimal",
      body: JSON.stringify({ user_id: userId, pharmacy_id: pharmacy.id }),
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    console.error(`Auth user ${userId} was created. Pharmacy link did not finish. Remove the user in the Supabase dashboard if you retry.`);
    process.exitCode = 1;
    return;
  }

  console.log("Pharmacy login created");
  console.log(`  name:  ${pharmacy.name}`);
  console.log(`  id:    ${pharmacy.id}`);
  console.log(`  email: ${args.email.trim()}`);
  console.log("  active: true");
  console.log("Hand the email and password to the pharmacy. The password is not stored in this output.");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("See the comment at the top of scripts/create-pharmacy-user.mjs");
    return;
  }
  validateArgs(args);
  const { url, serviceKey } = supabaseConfig(args);
  if (args.deactivate || args.activate) {
    const pharmacyId = args.pharmacyId || (await pharmacyIdForEmail(url, serviceKey, args.email));
    await setActive(url, serviceKey, pharmacyId, args.activate === true && args.deactivate !== true);
    return;
  }
  await createPharmacyUser(url, serviceKey, args);
}

function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(entry).href;
}

if (isDirectRun()) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
