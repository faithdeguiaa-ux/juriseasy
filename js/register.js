// /js/register.js
// Notarial Register: list, create, generate filename, advance counters.

import { supabase } from './supabaseClient.js';
import { logAudit } from './audit.js';

/**
 * List register entries for the current user, with optional filters.
 * @param {{search?:string, type?:string, month?:string}} opts
 *        month is 'YYYY-MM' or empty
 */
export async function listEntries(opts = {}) {
  let q = supabase
    .from('register_entries')
    .select('*')
    .order('created_at', { ascending: false });

  if (opts.type) q = q.eq('document_type', opts.type);
  if (opts.month) {
    const [yStr, mStr] = opts.month.split('-');
    const y = Number(yStr), m = Number(mStr);
    const start = `${yStr}-${mStr}-01`;
    const endY = m === 12 ? y + 1 : y;
    const endM = m === 12 ? 1 : m + 1;
    const end = `${endY}-${String(endM).padStart(2, '0')}-01`;
    q = q.gte('notarization_date', start).lt('notarization_date', end);
  }
  // Date-range filter (used by Monthly Report). Inclusive on both ends.
  if (opts.from) q = q.gte('notarization_date', opts.from);
  if (opts.to)   q = q.lte('notarization_date', opts.to);

  const { data, error } = await q;
  if (error) throw error;

  let rows = data || [];
  if (opts.search) {
    const s = opts.search.toLowerCase();
    rows = rows.filter(r =>
      (r.principal || '').toLowerCase().includes(s) ||
      (r.document_type || '').toLowerCase().includes(s) ||
      String(r.doc_no).includes(s)
    );
  }
  return rows;
}

/**
 * Create a register entry. Reads the lawyer's current counters,
 * assigns the next doc_no, generates the filename, then advances counters.
 *
 * @param {object} input
 * @param {string} input.document_type
 * @param {string} input.notarial_act
 * @param {string} input.principal
 * @param {string} input.principal_email
 * @param {string} input.notarization_date  ISO date
 * @param {number} input.fee
 * @param {string} [input.document_id]      optional FK to documents
 */
export async function createEntry(input) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');

  // Read current counters
  const { data: profile, error: pErr } = await supabase
    .from('lawyers')
    .select('current_book_no, current_doc_no, current_page_no, series_year, filename_pattern')
    .eq('id', user.id)
    .single();
  if (pErr) throw pErr;

  const nextDocNo  = (profile.current_doc_no || 0) + 1;
  const nextPageNo = profile.current_page_no  || 1;
  const bookNo     = profile.current_book_no  || 'I';
  const seriesYear = profile.series_year      || new Date().getFullYear();
  const pattern    = profile.filename_pattern ||
    '{date}_{type}_{principal}_Doc-{doc_no}_Page-{page}_Book{book}_{year}.pdf';

  const filename = generateFilename(pattern, {
    date: input.notarization_date,
    type: tokenize(input.document_type),
    principal: tokenize(firstPrincipal(input.principal)),
    doc_no: String(nextDocNo).padStart(3, '0'),
    page: nextPageNo,
    book: bookNo,
    year: seriesYear
  });

  const row = {
    lawyer_id: user.id,
    document_id: input.document_id || null,
    doc_no: nextDocNo,
    page_no: nextPageNo,
    book_no: bookNo,
    series_year: seriesYear,
    document_type: input.document_type,
    notarial_act: input.notarial_act || null,
    principal: input.principal,
    principal_email: input.principal_email || null,
    notarization_date: input.notarization_date,
    fee: input.fee || 0,
    filename,
    status: 'logged',
    // v3 register-grade metadata (all optional; pass through what was extracted)
    summary: input.summary || null,
    principal_address: input.principal_address || null,
    principal_civil_status: input.principal_civil_status || null,
    principal_profession: input.principal_profession || null,
    ibp_roll_number: input.ibp_roll_number || null,
    identity_reference: input.identity_reference || null,
    organization_name: input.organization_name || null,
    organization_address: input.organization_address || null,
    venue_province: input.venue_province || null,
    venue_city: input.venue_city || null,
    execution_date: input.execution_date || null,
    execution_place: input.execution_place || null,
    jurat_date: input.jurat_date || input.notarization_date || null,
    missing_fields: input.missing_fields && input.missing_fields.length ? input.missing_fields : null
  };

  const { data: created, error: insErr } = await supabase
    .from('register_entries')
    .insert(row)
    .select()
    .single();
  if (insErr) throw insErr;

  // Advance counters: a new page every 5 entries (configurable later).
  const newPage = (nextDocNo % 5 === 0) ? nextPageNo + 1 : nextPageNo;
  await supabase.from('lawyers')
    .update({ current_doc_no: nextDocNo, current_page_no: newPage })
    .eq('id', user.id);

  await logAudit(
    'register_entry_created',
    { doc_no: nextDocNo, page_no: nextPageNo, book_no: bookNo, document_type: input.document_type },
    { type: 'register_entry', id: created.id }
  );

  return created;
}

/**
 * Compute what the NEXT register entry's identifiers and filename will look
 * like, without inserting anything. Used by the wizard's step-3 preview so
 * the lawyer sees Doc No./Page/Book/filename before clicking "Log to Register".
 */
export async function previewNextEntry(input) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');

  const { data: profile, error: pErr } = await supabase
    .from('lawyers')
    .select('current_book_no, current_doc_no, current_page_no, series_year, filename_pattern')
    .eq('id', user.id)
    .single();
  if (pErr) throw pErr;

  const nextDocNo  = (profile.current_doc_no || 0) + 1;
  const nextPageNo = profile.current_page_no || 1;
  const bookNo     = profile.current_book_no || 'I';
  const seriesYear = profile.series_year     || new Date().getFullYear();
  const pattern    = profile.filename_pattern ||
    '{date}_{type}_{principal}_Doc-{doc_no}_Page-{page}_Book{book}_{year}.pdf';

  const filename = generateFilename(pattern, {
    date: input.notarization_date,
    type: tokenize(input.document_type),
    principal: tokenize(firstPrincipal(input.principal)),
    doc_no: String(nextDocNo).padStart(3, '0'),
    page: nextPageNo,
    book: bookNo,
    year: seriesYear
  });

  return {
    doc_no: nextDocNo,
    page_no: nextPageNo,
    book_no: bookNo,
    series_year: seriesYear,
    filename
  };
}

export async function getEntryStats() {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const today = new Date().toISOString().slice(0, 10);
  const monthStart = today.slice(0, 7) + '-01';

  const [{ count: todayCount }, { count: monthCount }, pending] = await Promise.all([
    supabase.from('register_entries').select('*', { count: 'exact', head: true })
      .eq('lawyer_id', user.id).eq('notarization_date', today),
    supabase.from('register_entries').select('*', { count: 'exact', head: true })
      .eq('lawyer_id', user.id).gte('notarization_date', monthStart),
    supabase.from('email_dispatch_queue').select('*', { count: 'exact', head: true })
      .eq('lawyer_id', user.id).eq('status', 'queued')
  ]);
  return {
    today: todayCount || 0,
    month: monthCount || 0,
    pendingDispatch: pending.count || 0
  };
}

// ---------- helpers ----------
function tokenize(s) {
  return (s || '')
    .replace(/[^A-Za-z0-9\s]/g, '')
    .split(/\s+/)
    .filter(Boolean)
    .map(w => w[0].toUpperCase() + w.slice(1))
    .join('');
}

function firstPrincipal(s) {
  return (s || '').split('/')[0].trim();
}

function generateFilename(pattern, tokens) {
  let out = pattern;
  for (const [k, v] of Object.entries(tokens)) {
    out = out.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
  }
  return out;
}
