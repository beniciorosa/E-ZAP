// ===== HubSpot API client =====
// Thin wrapper around the HubSpot v3 REST API used as a fallback when a
// ticket isn't yet in the local `mentorados` table (populated by the
// hubspot-tickets Edge Function webhook).
//
// Traversal per ticket: ticket → owner + contacts + deals → line_items
// and we normalize the result into the same shape `mentorados` uses,
// so downstream code stays identical regardless of source.
//
// Rate-limit: HubSpot Private App tokens get 100 requests / 10s. A single
// ticket fetch does ~4-6 calls (ticket + owner + N contacts + deal + line
// item), which means ~15-20 tickets per resolve call stays comfortably in
// budget.

const HS_BASE = "https://api.hubapi.com";
const DEFAULT_TIMEOUT_MS = 8000;

// Small fetch helper with timeout + auth header + JSON parsing.
// Returns { ok: bool, status, data, errorMessage }.
async function hsFetch(path, hsKey, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const resp = await fetch(HS_BASE + path, {
      method: opts.method || "GET",
      headers: {
        "Authorization": "Bearer " + hsKey,
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      signal: controller.signal,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const text = await resp.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) {}
    if (!resp.ok) {
      return { ok: false, status: resp.status, data, errorMessage: (data && data.message) || ("HTTP " + resp.status) };
    }
    return { ok: true, status: resp.status, data };
  } catch (e) {
    return { ok: false, status: 0, data: null, errorMessage: e.message || "fetch error" };
  } finally {
    clearTimeout(timer);
  }
}

// Map a line-item name to one of the three mentoria tiers by keyword.
// The webhook's canonical products are "Mentoria Meli PRO/Business/Starter";
// we match case-insensitively and in a specific order to avoid accidentally
// matching "PRO" inside other words.
function tierFromLineItemName(name) {
  const s = String(name || "").toLowerCase();
  if (!s) return null;
  if (/\bpro\b/.test(s)) return "pro";
  if (/business/.test(s)) return "business";
  if (/starter/.test(s)) return "starter";
  return null;
}

// The ticket `subject` in HubSpot is historically formatted as
// "Cliente | Mentor". Our normalized ticket_name should only hold the
// client part so the frontend can rebuild "{name} | {mentor}" without
// duplicating. Strip everything after the first " | " (with spaces).
function normalizeTicketName(subject) {
  const s = String(subject || "").trim();
  if (!s) return "";
  const idx = s.indexOf(" | ");
  if (idx === -1) return s;
  return s.slice(0, idx).trim();
}

// Heuristic: pick the real client contact out of the N contacts HubSpot
// returns. Tickets at Escalada typically have an internal "Mentoria
// Escalada G-mail" contact (no phone, @escaladaecom or @grupoescalada
// email) plus the actual client. We prefer contacts with a non-empty
// phone/mobilephone, and within those, contacts whose email domain is
// NOT one of the internal Escalada domains.
const INTERNAL_DOMAINS = /@(grupoescalada|escaladaecom)\./i;
function pickClientContact(contacts) {
  if (!Array.isArray(contacts) || contacts.length === 0) return null;
  // Prefer external contacts with phone
  const withPhone = contacts.filter(c => {
    const p = c && c.properties || {};
    return (p.phone && p.phone.trim()) || (p.mobilephone && p.mobilephone.trim());
  });
  const external = withPhone.filter(c => !INTERNAL_DOMAINS.test(((c.properties || {}).email) || ""));
  if (external.length > 0) return external[0];
  if (withPhone.length > 0) return withPhone[0];
  return contacts[0];
}

// ===== Public entry point =====
// Returns a normalized mentorados-shaped row or null if the ticket doesn't
// exist (404). Throws on auth errors so the caller can surface "key missing
// or invalid" to the user.
async function fetchTicketFromApi(ticketId, hsKey) {
  if (!hsKey) throw new Error("hubspot_api_key ausente em app_settings");
  if (!ticketId) return null;

  // 1. Ticket with associations
  const ticketResp = await hsFetch(
    "/crm/v3/objects/tickets/" + ticketId +
    "?properties=subject,hubspot_owner_id&associations=contacts,deals",
    hsKey
  );
  if (!ticketResp.ok) {
    if (ticketResp.status === 404) return null;
    if (ticketResp.status === 401 || ticketResp.status === 403) {
      throw new Error("HubSpot auth falhou (" + ticketResp.status + "): " + ticketResp.errorMessage);
    }
    throw new Error("HubSpot ticket fetch falhou (" + ticketResp.status + "): " + ticketResp.errorMessage);
  }
  const ticket = ticketResp.data;
  const props = (ticket && ticket.properties) || {};
  const ticketName = normalizeTicketName(props.subject);
  const ownerId = props.hubspot_owner_id;
  const contactIds = (((ticket.associations || {}).contacts || {}).results || []).map(r => r.id).filter(Boolean);
  const dealIds = (((ticket.associations || {}).deals || {}).results || []).map(r => r.id).filter(Boolean);

  // 2. Parallel: owner + contacts + first deal's line items
  const ownerPromise = ownerId
    ? hsFetch("/crm/v3/owners/" + ownerId, hsKey)
    : Promise.resolve({ ok: false, status: 0, data: null });

  const contactsPromises = contactIds.slice(0, 5).map(cid =>
    hsFetch("/crm/v3/objects/contacts/" + cid + "?properties=firstname,lastname,email,phone,mobilephone", hsKey)
  );

  const dealPromises = dealIds.slice(0, 2).map(did =>
    hsFetch("/crm/v3/objects/deals/" + did + "?properties=dealname&associations=line_items", hsKey)
  );

  const [ownerResp, contactsResps, dealResps] = await Promise.all([
    ownerPromise,
    Promise.all(contactsPromises),
    Promise.all(dealPromises),
  ]);

  // 3. Resolve owner → mentor_responsavel
  let mentorResponsavel = null;
  if (ownerResp.ok && ownerResp.data) {
    const o = ownerResp.data;
    const fn = (o.firstName || "").trim();
    const ln = (o.lastName || "").trim();
    mentorResponsavel = (fn || ln) ? (fn + (ln ? " " + ln : "")) : (o.email || null);
  }

  // 4. Resolve contacts → pick client → whatsapp_do_mentorado
  const contacts = contactsResps
    .filter(r => r.ok && r.data)
    .map(r => r.data);
  const clientContact = pickClientContact(contacts);
  let whatsappDoMentorado = null;
  if (clientContact && clientContact.properties) {
    const p = clientContact.properties;
    whatsappDoMentorado = (p.phone && p.phone.trim()) || (p.mobilephone && p.mobilephone.trim()) || null;
  }

  // 5. Resolve line items → tier booleans
  // Pick the first line item from the first deal that has one.
  let tier = null;
  const lineItemIdsToFetch = [];
  for (const dResp of dealResps) {
    if (!dResp.ok || !dResp.data) continue;
    const items = (((dResp.data.associations || {})["line items"] || {}).results || []);
    for (const it of items) {
      if (it && it.id) { lineItemIdsToFetch.push(it.id); break; }
    }
    if (lineItemIdsToFetch.length > 0) break;
  }
  if (lineItemIdsToFetch.length > 0) {
    const liResp = await hsFetch(
      "/crm/v3/objects/line_items/" + lineItemIdsToFetch[0] + "?properties=name",
      hsKey
    );
    if (liResp.ok && liResp.data && liResp.data.properties) {
      tier = tierFromLineItemName(liResp.data.properties.name);
    }
  }

  // 6. Return in mentorados-shaped row
  return {
    ticket_id: Number(ticketId),
    ticket_name: ticketName,
    mentor_responsavel: mentorResponsavel,
    whatsapp_do_mentorado: whatsappDoMentorado,
    mentoria_starter: tier === "starter",
    mentoria_pro: tier === "pro",
    mentoria_business: tier === "business",
    // Extra hint fields (not persisted to mentorados) for the route to use
    _source: "hubspot_api",
    _tier: tier,
  };
}

// Upsert a fetched ticket into `mentorados` so subsequent resolves hit the
// local table instead of the HubSpot API. Uses on_conflict=ticket_id + merge
// to be idempotent with the webhook. Fire-and-forget — failures don't fail
// the resolve call.
async function upsertMentorado(row, supaRest) {
  if (!row || !row.ticket_id) return;
  try {
    await supaRest(
      "/rest/v1/mentorados?on_conflict=ticket_id",
      "POST",
      [{
        ticket_id: row.ticket_id,
        ticket_name: row.ticket_name || "",
        mentor_responsavel: row.mentor_responsavel || null,
        whatsapp_do_mentorado: row.whatsapp_do_mentorado || null,
        mentoria_starter: !!row.mentoria_starter,
        mentoria_pro: !!row.mentoria_pro,
        mentoria_business: !!row.mentoria_business,
      }],
      "resolution=merge-duplicates,return=minimal"
    );
  } catch (e) {
    console.error("[HUBSPOT] upsertMentorado failed for ticket_id=" + row.ticket_id + ":", e.message);
  }
}

module.exports = {
  fetchTicketFromApi,
  upsertMentorado,
  // exported for unit-style smoke tests
  _internal: { tierFromLineItemName, normalizeTicketName, pickClientContact },
};
