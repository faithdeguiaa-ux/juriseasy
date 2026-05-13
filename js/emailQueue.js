// /js/emailQueue.js
// Persists outbound emails into email_dispatch_queue and dispatches them
// via the `dispatch-email` Supabase Edge Function (Resend).

import { supabase } from './supabaseClient.js';
import { logAudit } from './audit.js';

export async function queueEmail(input) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');

  const row = {
    lawyer_id: user.id,
    register_entry_id: input.register_entry_id || null,
    recipient: input.recipient,
    cc: input.cc || null,
    subject: input.subject,
    body: input.body,
    attachment_path: input.attachment_path || null,
    scheduled_send_time: input.scheduled_send_time || null,
    status: 'queued'
  };

  const { data, error } = await supabase
    .from('email_dispatch_queue')
    .insert(row)
    .select()
    .single();
  if (error) throw error;

  await logAudit(
    'email_queued',
    { recipient: input.recipient, register_entry_id: input.register_entry_id || null },
    { type: 'email', id: data.id }
  );
  return data;
}

export async function queueEmails(items) {
  return Promise.all(items.map(queueEmail));
}

export async function listQueue() {
  const { data, error } = await supabase
    .from('email_dispatch_queue')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function countQueued() {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return 0;
  const { count, error } = await supabase
    .from('email_dispatch_queue')
    .select('*', { count: 'exact', head: true })
    .eq('lawyer_id', user.id)
    .eq('status', 'queued');
  if (error) return 0;
  return count || 0;
}

/**
 * Update fields on a queued (un-sent) email. Status check happens at the
 * caller — RLS allows updating any row the user owns; we use the status filter
 * to be explicit about intent.
 */
export async function updateQueued(id, fields) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');
  const allowed = { recipient: fields.recipient, cc: fields.cc, subject: fields.subject, body: fields.body };
  // Strip undefineds so we don't overwrite columns with null accidentally
  Object.keys(allowed).forEach(k => { if (allowed[k] === undefined) delete allowed[k]; });
  const { error } = await supabase
    .from('email_dispatch_queue')
    .update(allowed)
    .eq('id', id)
    .eq('lawyer_id', user.id)
    .eq('status', 'queued');
  if (error) throw error;
  await logAudit('email_queued_updated', { id, fields: Object.keys(allowed) }, { type: 'email', id });
}

/**
 * Delete a queued OR sent email from the user's outbox.
 */
export async function deleteEmail(id) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');
  const { error } = await supabase
    .from('email_dispatch_queue')
    .delete()
    .eq('id', id)
    .eq('lawyer_id', user.id);
  if (error) throw error;
  await logAudit('email_deleted', { id }, { type: 'email', id });
}

/**
 * Send a single queued email via the dispatch-email Edge Function.
 * Returns { ok, sent, errored, configured }.
 */
export async function sendOne(id) {
  const { data, error } = await supabase.functions.invoke('dispatch-email', {
    body: { id }
  });
  if (error) return { ok: false, error: error.message, configured: true };
  return data || { ok: false, error: 'No response from dispatch-email' };
}

/**
 * Send all queued emails for the current user.
 */
export async function sendAllQueued() {
  const { data, error } = await supabase.functions.invoke('dispatch-email', {
    body: {}
  });
  if (error) return { ok: false, error: error.message, configured: true };
  return data || { ok: false, error: 'No response from dispatch-email' };
}
