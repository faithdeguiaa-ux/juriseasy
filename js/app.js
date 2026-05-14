// /js/app.js
// Wires the JurisEasy UI to Supabase. Keeps DOM structure stable —
// drives view routing, forms, wizard, and live data rendering.

import {
  signIn, signUp, signOut, onAuthStateChange,
  getCurrentUser, getCurrentProfile, updateProfile
} from './auth.js';
import { uploadPdf, getSignedUrl } from './storage.js';
import { listEntries, createEntry, getEntryStats, previewNextEntry, deleteEntry } from './register.js';
import { queueEmail, queueEmails, listQueue, countQueued, sendOne, sendAllQueued, updateQueued, deleteEmail } from './emailQueue.js';
import { extractDocumentMetadata } from './ocr.js';
import { logAudit, listAuditLogs } from './audit.js';
import { generateMonthlyReport } from './reports.js';
import { supabase } from './supabaseClient.js';

// ----------------- App-level state -----------------
const state = {
  profile: null,
  wizard: {
    file: null,
    document: null,
    extracted: null,
    createdEntry: null,
    signedUrl: null
  },
  cache: {
    auditLogs: []
  }
};

// =============================================================
// 1. AUTH BOOTSTRAP
// =============================================================
window.addEventListener('DOMContentLoaded', async () => {
  bindStaticHandlers();

  const user = await getCurrentUser();
  if (user) {
    await afterLogin();
  } else {
    showScreen('login');
  }

  onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT') showScreen('login');
  });
});

function bindStaticHandlers() {
  // Login form
  on('btn-login', 'click', handleLogin);
  on('btn-show-signup', 'click', () => toggleAuthMode('signup'));
  on('btn-show-login', 'click', () => toggleAuthMode('login'));
  on('btn-signup', 'click', handleSignup);

  // Sidebar nav (and any data-view button anywhere)
  document.querySelectorAll('[data-view]').forEach(btn => {
    btn.addEventListener('click', () => setView(btn.dataset.view));
  });

  // Sign out
  on('btn-signout', 'click', handleSignout);

  // File input + samples
  on('file-input', 'change', onFileSelected);
  document.querySelectorAll('[data-sample]').forEach(btn => {
    btn.addEventListener('click', () => onSampleClicked(btn.dataset.sample));
  });

  // Wizard
  document.querySelectorAll('[data-wiz-back]').forEach(btn => {
    btn.addEventListener('click', () => goToStep(Number(btn.dataset.wizBack)));
  });
  document.querySelectorAll('[data-wiz-next]').forEach(btn => {
    btn.addEventListener('click', () => goToStep(Number(btn.dataset.wizNext)));
  });
  on('btn-commit-register', 'click', handleCommitRegister);
  on('btn-send-now', 'click', () => handleDispatch('send'));
  on('btn-queue-batch', 'click', () => handleDispatch('queue'));
  on('btn-new-another', 'click', () => { resetWizard(); setView('new'); });

  // Register filters / sort / page size
  ['reg-search', 'reg-sort', 'reg-page-size'].forEach(id => {
    on(id, 'input', () => renderRegister());
    on(id, 'change', () => renderRegister());
  });
  on('btn-export-csv', 'click', handleExportCsv);

  // Avatar upload
  on('btn-avatar-upload', 'click', () => document.getElementById('avatar-file-input')?.click());
  on('avatar-file-input', 'change', handleAvatarUpload);
  on('btn-monthly-report', 'click', handleMonthlyReport);

  // Outbox
  on('btn-send-all-queued', 'click', handleSendAllQueued);
  document.querySelectorAll('[data-outbox-tab]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.outboxTab = btn.dataset.outboxTab;
      renderOutbox();
    });
  });

  // Audit
  on('audit-filter', 'input', () => renderAuditList());

  // Settings
  on('btn-save-settings', 'click', handleSaveSettings);

  // MFA
  on('btn-mfa-enroll', 'click', handleMfaEnroll);
  on('btn-mfa-verify', 'click', handleMfaVerify);
  on('btn-mfa-cancel', 'click', () => showMfaPanel('not-enrolled'));
  on('btn-mfa-disable', 'click', handleMfaDisable);

  // Verification gate
  on('btn-open-verification', 'click', openVerificationView);
  on('btn-submit-verification', 'click', handleSubmitVerification);

  // DPA / data
  on('btn-data-export', 'click', handleDataExport);
  on('btn-account-delete', 'click', handleAccountDeleteRequest);

  // Email edit modal
  on('btn-email-edit-close', 'click', closeEmailEditModal);
  on('btn-email-edit-cancel', 'click', closeEmailEditModal);
  on('btn-email-edit-save', 'click', handleEmailEditSave);

  // Viewport switcher (bottom-left)
  document.querySelectorAll('[data-viewport]').forEach(btn => {
    btn.addEventListener('click', () => setViewport(btn.dataset.viewport));
  });
  // Restore previously chosen viewport from localStorage
  const saved = localStorage.getItem('notaripro:viewport') || 'app';
  setViewport(saved);
}

function on(id, evt, fn) {
  const el = document.getElementById(id);
  if (el) el.addEventListener(evt, fn);
}

// =============================================================
// 2. AUTH HANDLERS
// =============================================================
function toggleAuthMode(mode) {
  document.getElementById('auth-login').classList.toggle('hidden', mode !== 'login');
  document.getElementById('auth-signup').classList.toggle('hidden', mode !== 'signup');
}

async function handleLogin() {
  const email = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  const errEl = document.getElementById('login-error');
  errEl.textContent = '';
  const btn = document.getElementById('btn-login');
  btn.disabled = true; btn.textContent = 'Signing in…';
  try {
    await signIn(email, password);
    await afterLogin();
  } catch (e) {
    errEl.textContent = e.message || 'Sign-in failed.';
  } finally {
    btn.disabled = false; btn.textContent = 'Sign in';
  }
}

// Strip any honorific the user typed ("Atty.", "Attorney", "Hon.") so the
// stored full_name is just the name. Display code re-adds "Atty." consistently.
function stripHonorific(name) {
  return (name || '').replace(/^\s*(Atty\.?|Attorney|Hon\.?)\s+/i, '').trim();
}

// Canonical display name: always "Atty. <name>".
function attyName(profile) {
  const n = stripHonorific(profile?.full_name || '');
  return n ? `Atty. ${n}` : (profile?.email || '');
}

async function handleSignup() {
  const fullName = stripHonorific(document.getElementById('signup-name').value.trim());
  const email = document.getElementById('signup-email').value.trim();
  const password = document.getElementById('signup-password').value;
  const dpaConsent = document.getElementById('signup-dpa-consent')?.checked || false;
  const errEl = document.getElementById('signup-error');
  errEl.textContent = '';
  if (!dpaConsent) {
    errEl.textContent = 'Please agree to the Privacy Notice and Terms of Service to continue.';
    return;
  }
  const btn = document.getElementById('btn-signup');
  btn.disabled = true; btn.textContent = 'Creating account…';
  try {
    const { user, session } = await signUp(email, password, fullName, dpaConsent);
    if (session) {
      await afterLogin();
    } else {
      errEl.textContent = 'Check your email to confirm your account, then sign in.';
      toggleAuthMode('login');
    }
  } catch (e) {
    errEl.textContent = e.message || 'Sign-up failed.';
  } finally {
    btn.disabled = false; btn.textContent = 'Create account';
  }
}

async function handleSignout() {
  await signOut();
  showScreen('login');
}

async function afterLogin() {
  showScreen('app');
  state.profile = await getCurrentProfile();
  renderProfileChrome();
  renderAlertBanner();
  setView('dashboard');
}

// =============================================================
// 3. NAVIGATION + PROFILE CHROME
// =============================================================
function showScreen(s) {
  document.getElementById('screen-login').classList.toggle('hidden', s !== 'login');
  document.getElementById('screen-app').classList.toggle('hidden', s !== 'app');
}

function setView(view) {
  // BETA: verification gate is OFF — direct wizard access for all signed-in users.
  // The gate logic and verification flow remain in code (and DB) for re-enable
  // at production launch alongside paid tiers + admin review queue.

  document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
  const target = document.getElementById('view-' + view);
  if (target) target.classList.remove('hidden');
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const btn = document.querySelector(`aside [data-view="${view}"]`);
  if (btn) btn.classList.add('active');

  if (view === 'dashboard') renderDashboard();
  if (view === 'register') renderRegister();
  if (view === 'outbox') renderOutbox();
  if (view === 'new') resetWizard();
  if (view === 'audit') renderAudit();
  if (view === 'settings') renderSettings();
  if (view === 'verification') openVerificationView();
  window.scrollTo({ top: 0, behavior: 'instant' });
}

function renderProfileChrome() {
  const p = state.profile || {};
  const initials = (stripHonorific(p.full_name) || p.email || '?').split(' ').filter(Boolean).map(s => s[0]).slice(0,2).join('').toUpperCase();
  setText('profile-initials', initials || '—');
  setText('profile-name', attyName(p));
  setText('profile-meta', 'Notary Public');

  // Dashboard avatar — the big circle next to the greeting
  const avatarEl = document.getElementById('avatar-image');
  if (avatarEl) {
    if (p.avatar_path) {
      const url = avatarUrl(p.avatar_path);
      avatarEl.innerHTML = `<img src="${url}" alt="" class="w-full h-full object-cover">`;
    } else {
      avatarEl.textContent = initials || '—';
    }
  }
}

function avatarUrl(path) {
  // Public bucket — direct CDN URL works
  const cfg = window.SUPABASE_CONFIG || {};
  const base = (cfg.url || '').replace(/\/$/, '');
  return `${base}/storage/v1/object/public/avatars/${path}`;
}

// =============================================================
// 4. DASHBOARD
// =============================================================
async function renderDashboard() {
  setText('today-date', new Date().toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
  }));

  const fullName = state.profile?.full_name || '';
  // Pull a friendly first name. If they used "Atty. Juan dela Cruz" → "Juan".
  const cleaned = fullName.replace(/^(Atty\.?|Attorney|Hon\.?)\s+/i, '').trim();
  const greetingName = cleaned ? cleaned.split(' ')[0] : 'Counsel';
  setText('greeting-name', `Atty. ${greetingName}`);

  try {
    const stats = await getEntryStats();
    setText('kpi-today', stats?.today ?? 0);
    setText('kpi-month', stats?.month ?? 0);
    setText('kpi-pending', stats?.pendingDispatch ?? 0);
    state.cache.pendingDispatch = stats?.pendingDispatch ?? 0;
    renderAlertBanner();

    const auditLogs = await listAuditLogs({ limit: 200 }).catch(() => []);
    state.cache.auditLogs = auditLogs;
    setText('kpi-audit', auditLogs.length);

    const recent = await listEntries();
    const top5 = recent.slice(0, 5);
    const ra = document.getElementById('recent-activity');
    if (ra) {
      if (top5.length === 0) {
        ra.innerHTML = `<div class="px-5 py-10 text-center">
          <div class="text-sm text-ink-500">No notarizations yet.</div>
          <button data-view="new" class="mt-3 text-sm text-violet-600 hover:text-violet-700 font-medium">Notarize your first document →</button>
        </div>`;
        // re-bind data-view click for the inserted button
        ra.querySelector('[data-view]')?.addEventListener('click', e => setView(e.currentTarget.dataset.view));
      } else {
        ra.innerHTML = top5.map(r => `
          <div class="px-5 py-3 flex items-center gap-4 hover:bg-violet-50 transition">
            <div class="w-10 h-10 rounded-lg bg-violet-100 text-violet-700 flex items-center justify-center mono text-xs font-medium">${pad3(r.doc_no)}</div>
            <div class="flex-1 min-w-0">
              <div class="text-sm font-medium truncate">${escapeHtml(r.document_type)}</div>
              <div class="text-xs text-ink-500 truncate">${escapeHtml(r.principal)} · ₱${Number(r.fee).toFixed(2)}</div>
            </div>
            <div class="text-xs text-ink-500">${r.notarization_date}</div>
            ${pillForStatus(r.status)}
          </div>
        `).join('');
      }
    }

    updateOutboxBadge(stats?.pendingDispatch || 0);
  } catch (e) {
    console.error(e);
    toast('Could not load dashboard. Check Supabase connection.');
  }
}

function pillForStatus(status) {
  if (status === 'dispatched' || status === 'sent') return '<span class="text-[10px] bg-emerald-50 text-emerald-700 px-2 py-1 rounded-full font-medium uppercase tracking-wide">Sent</span>';
  if (status === 'queued')    return '<span class="text-[10px] bg-amber-100 text-amber-800 px-2 py-1 rounded-full font-medium uppercase tracking-wide">Queued</span>';
  return '<span class="text-[10px] bg-emerald-100 text-emerald-800 px-2 py-1 rounded-full font-medium uppercase tracking-wide">Logged</span>';
}

// =============================================================
// 5. NEW NOTARIZATION WIZARD
// =============================================================
function resetWizard() {
  // Free any active blob URL so the browser doesn't leak memory across uploads
  if (state.wizard?.blobUrl) { try { URL.revokeObjectURL(state.wizard.blobUrl); } catch {} }
  state.wizard = { file: null, document: null, extracted: null, createdEntry: null, signedUrl: null, blobUrl: null };
  [1, 2, 3, 4, 5].forEach(n => document.getElementById('wiz-step-' + n)?.classList.add('hidden'));
  document.getElementById('wiz-step-1')?.classList.remove('hidden');
  setStepperState(1);
  const fi = document.getElementById('file-input');
  if (fi) fi.value = '';
  // Reset PDF preview UI: hide viewer, show scanning overlay for next upload
  const viewer = document.getElementById('pdf-viewer');
  if (viewer) { viewer.src = 'about:blank'; viewer.classList.add('hidden'); }
  document.getElementById('pdf-scanning')?.classList.remove('hidden');
  document.getElementById('pdf-open-tab')?.classList.add('hidden');
}

function setStepperState(active) {
  [1, 2, 3, 4].forEach(n => {
    const dot = document.getElementById('step-dot-' + n);
    const line = document.getElementById('step-line-' + n);
    if (!dot) return;
    dot.classList.remove('active', 'done');
    if (line) line.classList.remove('done');
    if (n < active) { dot.classList.add('done'); dot.innerHTML = '✓'; if (line) line.classList.add('done'); }
    else if (n === active) { dot.classList.add('active'); dot.innerHTML = n; }
    else { dot.innerHTML = n; }
  });
}

async function onFileSelected(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  if (file.type && file.type !== 'application/pdf') {
    toast('Only PDF or PDF/A files are accepted.');
    return;
  }
  await runUploadAndExtract(file);
}

async function onSampleClicked(idx) {
  const fakeName = ['affidavit_of_loss.pdf', 'deed_of_sale.pdf', 'spa.pdf'][idx] || 'sample.pdf';
  const blob = new Blob([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2D])], { type: 'application/pdf' });
  const file = new File([blob], fakeName, { type: 'application/pdf' });
  await runUploadAndExtract(file);
}

async function runUploadAndExtract(file) {
  document.getElementById('wiz-step-1').classList.add('hidden');
  document.getElementById('wiz-step-2').classList.remove('hidden');
  setStepperState(2);
  document.getElementById('pdf-scanning')?.classList.remove('hidden');

  state.wizard.file = file;

  // Display the actual PDF in the viewer IMMEDIATELY from a blob URL
  // (no network round-trip, no iframe X-Frame-Options issue).
  // The user sees their document the moment they hit step 2.
  try {
    const blobUrl = URL.createObjectURL(file);
    state.wizard.blobUrl = blobUrl;
    showRealPdfPreview(blobUrl);
  } catch (e) {
    console.warn('Local PDF preview failed:', e?.message || e);
  }

  try {
    // Upload to storage in the background; THEN run OCR against the stored file.
    const uploadResult = await uploadPdf(file);
    state.wizard.document = uploadResult.document;
    state.wizard.signedUrl = uploadResult.signedUrl;

    const extracted = await extractDocumentMetadata(file, uploadResult.path);
    state.wizard.extracted = extracted;
    populateExtractedFields(extracted);
    if (extracted._stub) {
      if (extracted._ocrError) {
        toast('OCR error — using sample data. Detail: ' + extracted._ocrError);
      } else {
        toast('OCR running in demo mode — add ANTHROPIC_API_KEY in Supabase to enable real extraction.');
      }
    }
  } catch (e) {
    console.error(e);
    toast('Upload or extraction failed: ' + (e.message || e));
    resetWizard();
  }
}

function populateExtractedFields(ex) {
  // Identification
  setVal('ext-type', ex.document_type);
  setVal('ext-act', ex.notarial_act);
  setVal('ext-fee', Number(ex.fee || 0).toFixed(2));
  setVal('ext-summary', ex.summary || '');

  // Affiant — auto-detect single vs multiple based on presence of " / "
  const pBox = document.getElementById('ext-principals');
  if (pBox) {
    const principals = (ex.principal || '').split('/').map(p => p.trim()).filter(Boolean);
    const visible = principals.length > 0 ? principals : [''];
    pBox.innerHTML = visible.map((name, i) => `
      <div class="bg-ink-50 rounded-lg p-3 border border-ink-100">
        <div class="grid grid-cols-2 gap-2">
          <input data-affiant-name="${i}" class="px-3 py-1.5 bg-white border border-ink-200 rounded-lg text-sm" placeholder="Full name" value="${escapeAttr(name)}">
          <input data-affiant-email="${i}" class="px-3 py-1.5 bg-white border border-ink-200 rounded-lg text-sm" placeholder="Email (optional)" value="${escapeAttr(i === 0 ? (ex.principal_email || '') : (ex.cc_emails?.[i-1] || ''))}">
        </div>
      </div>
    `).join('');
  }
  setVal('ext-principal-address', ex.principal_address || '');
  setVal('ext-civil-status', ex.principal_civil_status || '');
  setVal('ext-profession', ex.principal_profession || '');
  // IBP Roll No. is no longer an editable field — the OCR-extracted value
  // (ex.ibp_roll_number) flows straight through to the register entry + audit log.
  setVal('ext-identity', ex.identity_reference || '');

  // Organization (auto-expand if any data present)
  setVal('ext-org-name', ex.organization_name || '');
  setVal('ext-org-address', ex.organization_address || '');
  const orgSection = document.getElementById('ext-org-section');
  const orgIndicator = document.getElementById('ext-org-indicator');
  if (orgSection) {
    const hasOrg = !!(ex.organization_name || ex.organization_address);
    orgSection.open = hasOrg;
    if (orgIndicator) orgIndicator.textContent = hasOrg
      ? '— detected'
      : '— click to expand if applicable';
  }

  // Venue & dates
  setVal('ext-province', ex.venue_province || '');
  setVal('ext-city', ex.venue_city || '');
  setVal('ext-exec-date', ex.execution_date || '');
  setVal('ext-exec-place', ex.execution_place || '');
  setVal('ext-date', ex.jurat_date || ex.notarization_date || '');

  // Source badge
  const badge = document.getElementById('ext-source-badge');
  const ocrMode = document.getElementById('ext-ocr-mode');
  if (badge) {
    badge.classList.remove('hidden');
    if (ex._stub) {
      badge.textContent = 'Demo OCR';
      badge.className = 'text-[10px] uppercase tracking-wider font-semibold px-2.5 py-1 rounded shrink-0 bg-amber-100 text-amber-800';
    } else {
      badge.textContent = 'Live OCR';
      badge.className = 'text-[10px] uppercase tracking-wider font-semibold px-2.5 py-1 rounded shrink-0 bg-emerald-100 text-emerald-800';
    }
  }
  if (ocrMode) ocrMode.textContent = ex._stub ? 'demo OCR' : 'Claude Vision';

  // Missing fields warning
  const missingBanner = document.getElementById('ext-missing-banner');
  const missingList = document.getElementById('ext-missing-list');
  if (missingBanner && missingList) {
    const missing = (ex.missing_fields || []).filter(Boolean);
    if (missing.length > 0) {
      missingList.textContent = missing.join(' · ');
      missingBanner.classList.remove('hidden');
    } else {
      missingBanner.classList.add('hidden');
    }
  }

  // Detected emails badge strip
  const eBox = document.getElementById('ext-emails');
  const eEmpty = document.getElementById('ext-emails-empty');
  const detected = [ex.principal_email, ...(ex.cc_emails || [])].filter(Boolean);
  if (eBox) {
    if (detected.length > 0) {
      eEmpty?.classList.add('hidden');
      eBox.innerHTML = detected.map(e => `<span class="text-xs bg-violet-50 text-violet-700 px-2 py-1 rounded-full font-medium">${escapeHtml(e)}</span>`).join('');
    } else {
      eBox.innerHTML = '';
      eEmpty?.classList.remove('hidden');
    }
  }
}

function showRealPdfPreview(url) {
  const scanning = document.getElementById('pdf-scanning');
  const viewer = document.getElementById('pdf-viewer');
  const openTab = document.getElementById('pdf-open-tab');
  if (!url || !viewer) return;
  // Use the URL directly (blob: URLs bypass CORS/X-Frame-Options entirely;
  // signed Supabase URLs also work for cross-origin embeds in modern browsers).
  // PDF hash fragment requests a fit-width view with toolbar visible.
  viewer.src = url + (url.includes('#') ? '' : '#view=FitH&toolbar=1');
  viewer.classList.remove('hidden');
  scanning?.classList.add('hidden');
  if (openTab) {
    openTab.href = url;
    openTab.classList.remove('hidden');
  }
}

async function handleCommitRegister() {
  const ex = state.wizard.extracted;
  if (!ex) return;

  // Pull edited principal name + email from the dynamic affiant rows
  const affNames = Array.from(document.querySelectorAll('[data-affiant-name]'))
    .map(el => el.value.trim()).filter(Boolean);
  const affEmails = Array.from(document.querySelectorAll('[data-affiant-email]'))
    .map(el => el.value.trim());
  if (affNames.length > 0) {
    ex.principal = affNames.join(' / ');
    ex.principal_email = affEmails[0] || '';
    ex.cc_emails = affEmails.slice(1).filter(Boolean);
  }

  // Step 3 editable inputs win over step 2 for the fields the user can override there.
  ex.document_type = readVal('reg-type-input', readVal('ext-type', ex.document_type));
  ex.notarial_act = readVal('reg-act-input', readVal('ext-act', ex.notarial_act));
  ex.summary = readVal('ext-summary', ex.summary || '');
  ex.fee = Number(readVal('reg-fee-input', readVal('ext-fee', ex.fee)));
  // Date + principal may have been edited in step 3 — take those if non-empty
  const step3Date = readVal('reg-date-input', '');
  const step3Principal = readVal('reg-principal-input', '');
  if (step3Date) { ex.jurat_date = step3Date; ex.notarization_date = step3Date; }
  if (step3Principal) ex.principal = step3Principal;
  ex.principal_address = readVal('ext-principal-address', ex.principal_address || '');
  ex.principal_civil_status = readVal('ext-civil-status', ex.principal_civil_status || '');
  ex.principal_profession = readVal('ext-profession', ex.principal_profession || '');
  // ex.ibp_roll_number keeps whatever OCR extracted — no editable field for it.
  ex.identity_reference = readVal('ext-identity', ex.identity_reference || '');
  ex.organization_name = readVal('ext-org-name', ex.organization_name || '');
  ex.organization_address = readVal('ext-org-address', ex.organization_address || '');
  ex.venue_province = readVal('ext-province', ex.venue_province || '');
  ex.venue_city = readVal('ext-city', ex.venue_city || '');
  ex.execution_date = readVal('ext-exec-date', ex.execution_date || '') || null;
  ex.execution_place = readVal('ext-exec-place', ex.execution_place || '');
  ex.jurat_date = readVal('ext-date', ex.jurat_date || ex.notarization_date);
  ex.notarization_date = ex.jurat_date || ex.notarization_date;

  try {
    const created = await createEntry({
      document_type: ex.document_type,
      notarial_act: ex.notarial_act,
      principal: ex.principal,
      principal_email: ex.principal_email,
      notarization_date: ex.notarization_date,
      fee: ex.fee,
      document_id: state.wizard.document?.id || null,
      // Optional manual overrides from step 3 editable inputs
      override_doc_no: readVal('reg-doc-input', '').trim() || null,
      override_page_no: readVal('reg-page-input', '').trim() || null,
      override_book_no: readVal('reg-book-input', '').trim() || null,
      override_series_year: readVal('reg-series-input', '').trim() || null,
      // rich metadata
      summary: ex.summary,
      principal_address: ex.principal_address,
      principal_civil_status: ex.principal_civil_status,
      principal_profession: ex.principal_profession,
      ibp_roll_number: ex.ibp_roll_number,
      identity_reference: ex.identity_reference,
      organization_name: ex.organization_name,
      organization_address: ex.organization_address,
      venue_province: ex.venue_province,
      venue_city: ex.venue_city,
      execution_date: ex.execution_date,
      execution_place: ex.execution_place,
      jurat_date: ex.jurat_date,
      missing_fields: ex.missing_fields || []
    });
    state.wizard.createdEntry = created;
    paintRegisterPreview(created);
    paintDispatchEmails(created, ex);
    goToStep(4);
    toast(`Logged · Doc. No. ${pad3(created.doc_no)}`);
  } catch (e) {
    console.error(e);
    toast('Register insert failed: ' + (e.message || e));
  }
}

function paintRegisterPreview(entry) {
  setText('reg-doc', pad3(entry.doc_no));
  setText('reg-page', entry.page_no);
  setText('reg-book', entry.book_no);
  setText('reg-series', entry.series_year);
  setText('reg-date', entry.notarization_date);
  setText('reg-principal', entry.principal);
  setText('reg-type', entry.document_type);
  setText('reg-fee-display', '₱' + Number(entry.fee).toFixed(2));
  setText('filename-preview', entry.filename);
}

function paintDispatchEmails(entry, ex) {
  const docNo = pad3(entry.doc_no);
  const principals = entry.principal.split('/').map(p => p.trim()).filter(Boolean);
  const recipientEmails = [ex.principal_email, ...(ex.cc_emails || [])].filter(Boolean);

  // Per-document emails go ONLY to the principal(s). OCS submissions are now
  // batched monthly — see composeMonthlyOcsSubmission() on the Outbox OCS tab.
  const emails = principals.map((name, i) => ({
    to: recipientEmails[i] || ex.principal_email,
    who: name,
    subject: `Notarized: ${entry.document_type} (Doc No. ${docNo}, Book ${entry.book_no})`,
    body: `Dear ${name.split(' ')[0]},\n\nThank you for your visit today. Please find attached the duly notarized ${entry.document_type}.\n\nRegister entry: Doc. No. ${docNo}, Page No. ${entry.page_no}, Book No. ${entry.book_no}, Series of ${entry.series_year}.\n\nA copy of this document will be included in my monthly notarial report to the Office of the Clerk of Court — ${state.profile?.jurisdiction || '[OCS]'}, in compliance with the 2004 Rules on Notarial Practice (as amended by A.M. No. 02-8-13-SC).\n\nVery truly yours,\n${attyName(state.profile) || 'Atty. ___'}\nNotary Public${state.profile?.roll_number ? ' · Roll No. ' + state.profile.roll_number : ''}`
  }));

  state.wizard.dispatchPlan = emails;

  const wrap = document.getElementById('dispatch-emails');
  if (!wrap) return;
  wrap.innerHTML = emails.map((e, i) => `
    <details class="border border-ink-100 rounded-lg" ${i === 0 ? 'open' : ''}>
      <summary class="p-4 flex items-center gap-3">
        <div class="w-8 h-8 rounded-full bg-violet-100 flex items-center justify-center text-xs font-medium text-violet-700">${initialsOf(e.who)}</div>
        <div class="flex-1 min-w-0">
          <div class="text-sm font-medium truncate">${escapeHtml(e.subject)}</div>
          <div class="text-xs text-ink-500 truncate">To: ${escapeHtml(e.to)}</div>
        </div>
        <span class="text-xs bg-violet-100 text-violet-700 px-2 py-1 rounded-full font-medium">Auto-drafted</span>
      </summary>
      <div class="px-4 pb-4 border-t border-ink-100 pt-3 text-sm">
        <textarea data-email-body="${i}" class="w-full p-3 border border-ink-200 rounded-lg text-sm font-sans" rows="9">${escapeHtml(e.body)}</textarea>
        <div class="flex items-center gap-2 mt-2 text-xs text-ink-500">Attached: <code class="mono">${escapeHtml(entry.filename)}</code></div>
      </div>
    </details>
  `).join('');
}

async function handleDispatch(mode) {
  const entry = state.wizard.createdEntry;
  const plan = state.wizard.dispatchPlan;
  if (!entry || !plan) return;

  document.querySelectorAll('[data-email-body]').forEach(t => {
    const i = Number(t.dataset.emailBody);
    if (plan[i]) plan[i].body = t.value;
  });

  const scheduled = mode === 'queue' ? batchTimeToday(state.profile?.daily_dispatch_time || '17:00') : null;

  try {
    await queueEmails(plan.map(p => ({
      recipient: p.to,
      subject: p.subject,
      body: p.body,
      attachment_path: state.wizard.document?.storage_path || null,
      register_entry_id: entry.id,
      scheduled_send_time: scheduled
    })));

    setText('done-doc-no',
      `Doc. No. ${pad3(entry.doc_no)}, Page ${entry.page_no}, Book ${entry.book_no}, Series of ${entry.series_year}.`);
    setText('done-summary', mode === 'send'
      ? `${plan.length} email(s) queued for immediate dispatch.`
      : `${plan.length} email(s) queued for batch dispatch at ${state.profile?.daily_dispatch_time || '17:00'} today.`);
    goToStep(5);
    updateOutboxBadge(await countQueued());
    toast(mode === 'send' ? 'Dispatch queued for send.' : 'Queued for batch dispatch.');
  } catch (e) {
    console.error(e);
    toast('Email queue insert failed: ' + (e.message || e));
  }
}

function goToStep(n) {
  [1, 2, 3, 4, 5].forEach(i => document.getElementById('wiz-step-' + i)?.classList.add('hidden'));
  document.getElementById('wiz-step-' + n)?.classList.remove('hidden');
  setStepperState(n);
  if (n === 3) populateStep3Preview();
}

async function populateStep3Preview() {
  const ex = state.wizard.extracted;
  if (!ex) return;
  // Pull the most-recently-edited values from step 2 so the preview reflects
  // any corrections the user just made.
  const docType = readVal('ext-type', ex.document_type || '');
  const notarialAct = readVal('ext-act', ex.notarial_act || ex.notarial_act || 'Jurat');
  const noteDate = readVal('ext-date', ex.jurat_date || ex.notarization_date || '');
  const fee = Number(readVal('ext-fee', ex.fee || 0));
  const affNames = Array.from(document.querySelectorAll('[data-affiant-name]'))
    .map(el => el.value.trim()).filter(Boolean);
  const principal = affNames.length > 0 ? affNames.join(' / ') : (ex.principal || '');

  // Pre-populate the editable inputs with what we already know.
  setVal('reg-date-input', noteDate);
  setVal('reg-principal-input', principal);
  setVal('reg-type-input', docType);
  setVal('reg-act-input', notarialAct);
  setVal('reg-fee-input', Number.isFinite(fee) ? fee.toFixed(2) : '0.00');

  try {
    const preview = await previewNextEntry({
      document_type: docType,
      notarization_date: noteDate,
      principal
    });
    state.wizard.previewedCounters = preview;
    setVal('reg-doc-input', String(preview.doc_no).padStart(3, '0'));
    setVal('reg-page-input', preview.page_no);
    setVal('reg-book-input', preview.book_no);
    setVal('reg-series-input', preview.series_year);
    setText('filename-preview', preview.filename);
  } catch (e) {
    console.warn('[wizard] step 3 preview failed:', e?.message || e);
    setVal('reg-doc-input', '');
    setVal('reg-page-input', '');
    setVal('reg-book-input', '');
    setVal('reg-series-input', '');
    setText('filename-preview', '(preview unavailable — Log to Register will still work)');
  }

  // Wire live filename regeneration: re-run as user edits any contributing field.
  wireStep3LiveFilename();
}

function wireStep3LiveFilename() {
  const ids = ['reg-doc-input','reg-page-input','reg-book-input','reg-series-input',
               'reg-date-input','reg-principal-input','reg-type-input'];
  ids.forEach(id => {
    const el = document.getElementById(id);
    if (!el || el._filenameWired) return;
    el._filenameWired = true;
    el.addEventListener('input', regenStep3Filename);
  });
}

function regenStep3Filename() {
  const profile = state.profile || {};
  const pattern = profile.filename_pattern ||
    '{date}_{type}_{principal}_Doc-{doc_no}_Page-{page}_Book{book}_{year}.pdf';
  const tokens = {
    date: readVal('reg-date-input', ''),
    type: tokenize(readVal('reg-type-input', '')),
    principal: tokenize(firstPrincipalName(readVal('reg-principal-input', ''))),
    doc_no: String(readVal('reg-doc-input', '')).padStart(3, '0'),
    page: readVal('reg-page-input', ''),
    book: readVal('reg-book-input', ''),
    year: readVal('reg-series-input', '')
  };
  let out = pattern;
  for (const [k, v] of Object.entries(tokens)) {
    out = out.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
  }
  setText('filename-preview', out);
}

function tokenize(s) {
  return (s || '').replace(/[^A-Za-z0-9\s]/g, '').split(/\s+/).filter(Boolean)
    .map(w => w[0].toUpperCase() + w.slice(1)).join('');
}
function firstPrincipalName(s) { return (s || '').split('/')[0].trim(); }

// =============================================================
// 6. REGISTER VIEW
// =============================================================
async function renderRegister() {
  const search = document.getElementById('reg-search')?.value || '';
  const sort = document.getElementById('reg-sort')?.value || 'date-desc';
  const pageSize = Number(document.getElementById('reg-page-size')?.value || 50);
  const tbody = document.getElementById('register-tbody');
  const empty = document.getElementById('register-empty');
  const tableEl = tbody?.closest('table');
  const countEl = document.getElementById('register-count');
  if (!tbody) return;
  try {
    let rows = await listEntries({ search });

    // Sort client-side per chosen order
    rows = [...rows].sort((a, b) => {
      switch (sort) {
        case 'date-asc':
          return String(a.notarization_date).localeCompare(String(b.notarization_date)) ||
                 (a.doc_no - b.doc_no);
        case 'title-asc':
          return String(a.document_type || '').localeCompare(String(b.document_type || ''));
        case 'seq-asc':
          return (a.doc_no - b.doc_no);
        case 'seq-desc':
          return (b.doc_no - a.doc_no);
        case 'date-desc':
        default:
          return String(b.notarization_date).localeCompare(String(a.notarization_date)) ||
                 (b.doc_no - a.doc_no);
      }
    });

    state.cache.registerRowsAll = rows;
    const visible = rows.slice(0, pageSize);
    state.cache.registerRows = visible;

    if (rows.length === 0) {
      tbody.innerHTML = '';
      tableEl?.classList.add('hidden');
      empty?.classList.remove('hidden');
      if (countEl) countEl.textContent = 'No entries.';
    } else {
      tableEl?.classList.remove('hidden');
      empty?.classList.add('hidden');
      tbody.innerHTML = visible.map(r => `
        <tr class="hover:bg-violet-50 transition group">
          <td class="px-4 py-3 mono text-xs text-violet-700 font-semibold">${r.series_year}-${pad3(r.doc_no)}</td>
          <td class="px-4 py-3 text-ink-600">${formatShort(r.notarization_date)}</td>
          <td class="px-4 py-3">${escapeHtml(r.document_type || '')}</td>
          <td class="px-4 py-3 text-ink-600">${escapeHtml(r.notarial_act || '—')}</td>
          <td class="px-4 py-3 text-ink-700">${escapeHtml(r.principal)}</td>
          <td class="px-4 py-3 text-ink-500">${r.page_no}</td>
          <td class="px-4 py-3">${pillForStatus(r.status)}</td>
          <td class="px-4 py-3 text-right">
            <div class="inline-flex items-center gap-2">
              <span class="text-xs text-ink-500">${escapeHtml(r.book_no)} · ${r.series_year}</span>
              <button data-delete-entry="${r.id}" data-entry-label="${escapeAttr(`${r.series_year}-${pad3(r.doc_no)} · ${r.document_type || ''}`)}" class="opacity-0 group-hover:opacity-100 transition text-rose-600 hover:text-rose-700 p-1" title="Delete entry">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/></svg>
              </button>
            </div>
          </td>
        </tr>
      `).join('');

      // Wire delete buttons
      tbody.querySelectorAll('[data-delete-entry]').forEach(btn => {
        btn.addEventListener('click', () => handleDeleteEntry(btn.dataset.deleteEntry, btn.dataset.entryLabel));
      });
      if (countEl) {
        const total = rows.length;
        countEl.textContent = visible.length < total
          ? `Showing ${visible.length} of ${total} entries`
          : `Showing all ${total} ${total === 1 ? 'entry' : 'entries'}`;
      }
    }
  } catch (e) {
    console.error(e);
    tbody.innerHTML = `<tr><td colspan="8" class="text-center py-8 text-rose-600 text-sm">Failed to load: ${escapeHtml(e.message || '')}</td></tr>`;
  }
}

function handleExportCsv() {
  // Always export ALL filtered rows, not just the current page-size slice.
  const rows = state.cache.registerRowsAll || state.cache.registerRows || [];
  if (!rows.length) {
    toast('Nothing to export — register is empty.');
    return;
  }
  // NOTE: Fee column intentionally excluded from CSV export to limit BIR exposure.
  // The notary still sees fees inside the app for their own bookkeeping.
  const headers = ['Doc No.','Page','Book','Series','Date','Document Title','Notarial Act','Principal','Principal Email','Status','Filename'];
  const escapeCsv = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [headers.join(',')].concat(rows.map(r => [
    `${r.series_year}-${pad3(r.doc_no)}`, r.page_no, r.book_no, r.series_year,
    r.notarization_date, r.document_type, r.notarial_act, r.principal,
    r.principal_email, r.status, r.filename
  ].map(escapeCsv).join(',')));
  const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `NotariPro-NotarialRegister-${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast(`Exported ${rows.length} entries (fees excluded).`);
}

// =============================================================
// 7. OUTBOX
// =============================================================
async function renderOutbox() {
  const wrap = document.getElementById('outbox-list');
  const empty = document.getElementById('outbox-empty');
  const sendAll = document.getElementById('btn-send-all-queued');
  const queuedPill = document.getElementById('outbox-queued-pill');
  const helper = document.getElementById('outbox-tab-help');
  if (!wrap) return;

  // Tab state — default to client
  if (!state.outboxTab) state.outboxTab = 'client';
  document.querySelectorAll('[data-outbox-tab]').forEach(btn => {
    const active = btn.dataset.outboxTab === state.outboxTab;
    btn.className = 'outbox-tab flex-1 px-4 py-2 text-sm font-medium rounded-lg transition ' +
      (active ? 'bg-white text-violet-700 shadow-sm' : 'text-ink-500 hover:text-ink-900');
  });
  if (helper) {
    helper.textContent = state.outboxTab === 'client'
      ? 'Per-entry emails to principals and parties. Sent immediately or queued for batch.'
      : 'Monthly batched submissions to the Office of the Clerk of Court. The Smart-Batch engine (Tier 3) auto-splits attachments under the 25 MB limit.';
  }

  // OCS compose bar — only visible on the OCS tab
  const ocsBar = document.getElementById('ocs-compose-bar');
  if (ocsBar) {
    ocsBar.classList.toggle('hidden', state.outboxTab !== 'ocs');
    if (state.outboxTab === 'ocs') {
      const monthInput = document.getElementById('ocs-compose-month');
      if (monthInput && !monthInput.value) {
        monthInput.value = new Date().toISOString().slice(0, 7);
      }
      const btn = document.getElementById('btn-ocs-compose');
      if (btn && !btn.dataset.bound) {
        btn.dataset.bound = '1';
        btn.addEventListener('click', () => handleComposeOcsSubmission());
      }
    }
  }

  try {
    const allRows = await listQueue();
    // Filter client vs OCS by recipient match against profile.ocs_email
    const ocsEmail = (state.profile?.ocs_email || '').toLowerCase();
    const rows = allRows.filter(r => {
      const isOcs = ocsEmail && r.recipient && r.recipient.toLowerCase() === ocsEmail;
      return state.outboxTab === 'ocs' ? isOcs : !isOcs;
    });
    state.cache.outboxRows = rows;

    if (rows.length === 0) {
      wrap.innerHTML = '';
      empty?.classList.remove('hidden');
      sendAll?.classList.add('hidden');
      queuedPill?.classList.add('hidden');
      return;
    }
    empty?.classList.add('hidden');

    const queuedCount = rows.filter(r => r.status === 'queued').length;
    if (queuedCount > 0) {
      sendAll?.classList.remove('hidden');
      if (queuedPill) {
        queuedPill.textContent = `${queuedCount} queued`;
        queuedPill.classList.remove('hidden');
      }
    } else {
      sendAll?.classList.add('hidden');
      queuedPill?.classList.add('hidden');
    }

    wrap.innerHTML = rows.map(e => {
      const isQueued = e.status === 'queued';
      const isSent = e.status === 'sent' || e.status === 'dispatched';
      const dotClass = isSent ? 'bg-emerald-500' : isQueued ? 'bg-violet-500' : 'bg-ink-300';
      const statusBadge = isSent
        ? '<span class="text-[10px] bg-emerald-50 text-emerald-700 px-2 py-0.5 rounded font-semibold uppercase tracking-wide">Sent</span>'
        : isQueued
        ? '<span class="text-[10px] bg-amber-100 text-amber-800 px-2 py-0.5 rounded font-semibold uppercase tracking-wide">Queued</span>'
        : `<span class="text-[10px] bg-ink-100 text-ink-700 px-2 py-0.5 rounded font-semibold uppercase tracking-wide">${escapeHtml(e.status)}</span>`;

      return `
        <div class="bg-white border border-ink-100 rounded-xl p-5 flex items-start gap-4">
          <div class="w-2.5 h-2.5 rounded-full ${dotClass} mt-2 shrink-0"></div>
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2 flex-wrap">
              <div class="text-sm font-medium">${escapeHtml(e.subject)}</div>
              ${statusBadge}
            </div>
            <div class="text-xs text-ink-500 mt-0.5 truncate">To: ${escapeHtml(e.recipient)}${e.cc ? ' · BCC: ' + escapeHtml(e.cc) : ''}</div>
            <div class="text-xs text-ink-400 mt-0.5">${new Date(e.created_at).toLocaleString()}${e.scheduled_send_time ? ' · scheduled ' + new Date(e.scheduled_send_time).toLocaleString() : ''}</div>
            <details class="mt-3"><summary class="text-xs text-ink-600 hover:text-ink-900 cursor-pointer">View body</summary><pre class="text-xs text-ink-700 mt-2 bg-ink-50 p-3 rounded-lg whitespace-pre-wrap font-sans">${escapeHtml(e.body)}</pre></details>
          </div>
          <div class="flex flex-col items-end gap-1 shrink-0">
            ${isQueued ? `<button data-send-now="${e.id}" class="border border-ink-200 hover:border-violet-400 hover:bg-violet-50 text-xs px-3 py-1.5 rounded-lg font-medium">Send now</button>` : ''}
            ${isQueued ? `<button data-edit-email="${e.id}" class="text-xs text-ink-600 hover:text-violet-700 px-3 py-1 rounded-lg font-medium">Edit</button>` : ''}
            <button data-delete-email="${e.id}" data-email-subject="${escapeAttr(e.subject)}" class="text-xs text-rose-600 hover:text-rose-700 px-3 py-1 rounded-lg font-medium">Delete</button>
          </div>
        </div>
      `;
    }).join('');

    wrap.querySelectorAll('[data-send-now]').forEach(b => {
      b.addEventListener('click', () => handleSendOne(b.dataset.sendNow));
    });
    wrap.querySelectorAll('[data-edit-email]').forEach(b => {
      b.addEventListener('click', () => openEmailEditModal(b.dataset.editEmail));
    });
    wrap.querySelectorAll('[data-delete-email]').forEach(b => {
      b.addEventListener('click', () => handleDeleteEmail(b.dataset.deleteEmail, b.dataset.emailSubject));
    });
  } catch (e) {
    wrap.innerHTML = `<div class="text-rose-600 p-4">Failed to load outbox: ${escapeHtml(e.message || '')}</div>`;
  }
}

async function handleSendOne(id) {
  toast('Sending…');
  try {
    const res = await sendOne(id);
    if (res?.configured === false) {
      toast('Email sender not configured. Add RESEND_API_KEY in Supabase secrets.');
      return;
    }
    if (!res?.ok) {
      toast('Send failed: ' + (res?.error || 'unknown error'));
      return;
    }
    if (res.errored > 0) {
      toast('Send failed — see error in the queue.');
    } else {
      toast('Email sent.');
    }
    await renderOutbox();
    updateOutboxBadge(await countQueued());
  } catch (e) {
    toast('Send failed: ' + (e.message || e));
  }
}

/**
 * Compose the monthly Notary Report email to OCS, matching the format used by
 * Atty. Artillero and other Philippine notary publics:
 *
 *   NOTARY REPORT OF ATTY. <NAME> FOR <MONTH YEAR> OF BOOK <N> BATCH <K>
 *   ----
 *   Notary public: Atty. <NAME>
 *   Compliance period: <FROM> to <TO>
 *   Submission of notarial report:
 *           Doc. No. <FIRST>-<LAST>
 *           Page No. <FIRST>-<LAST>
 *           Book No. <BOOK>
 *           Series of <YEAR>
 *   Mode of Transmittal: Electronic Mail
 *   Number of documents or instruments: <COUNT>
 */
async function handleComposeOcsSubmission() {
  const monthInput = document.getElementById('ocs-compose-month');
  const batchInput = document.getElementById('ocs-compose-batch');
  const monthStr = (monthInput?.value || '').trim();           // 'YYYY-MM'
  const batchNo = Number(batchInput?.value || '1') || 1;

  if (!/^\d{4}-\d{2}$/.test(monthStr)) {
    toast('Pick a compliance month first.');
    return;
  }
  if (!state.profile?.ocs_email) {
    toast('Set your OCS email in Settings before composing a submission.');
    return;
  }

  toast('Building monthly submission…');
  try {
    // Pull all register entries for the month
    const entries = await listEntries({ month: monthStr });
    if (entries.length === 0) {
      toast('No notarial entries in that month — nothing to submit.');
      return;
    }

    // Sort by doc_no so range math is straightforward
    entries.sort((a, b) => (a.doc_no || 0) - (b.doc_no || 0));

    const firstDoc = entries[0].doc_no;
    const lastDoc  = entries[entries.length - 1].doc_no;
    const pages    = entries.map(e => Number(e.page_no)).filter(Number.isFinite);
    const firstPage = pages.length ? Math.min(...pages) : entries[0].page_no;
    const lastPage  = pages.length ? Math.max(...pages) : entries[0].page_no;
    const books     = [...new Set(entries.map(e => e.book_no).filter(Boolean))];
    const bookLabel = books.length === 1 ? books[0] : books.join(' & ');
    const seriesYears = [...new Set(entries.map(e => e.series_year).filter(Boolean))];
    const seriesYear  = seriesYears.length === 1 ? seriesYears[0] : (seriesYears[0] || new Date(monthStr + '-01').getFullYear());

    // Date range: first to last notarization_date in the month
    const dates = entries.map(e => e.notarization_date).filter(Boolean).sort();
    const periodFrom = dates[0] || `${monthStr}-01`;
    const periodTo   = dates[dates.length - 1] || `${monthStr}-01`;

    const monthName = new Date(monthStr + '-15').toLocaleString('en-US', { month: 'long', year: 'numeric' });
    const periodFromHuman = new Date(periodFrom).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    const periodToHuman   = new Date(periodTo).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

    const notaryProper = attyName(state.profile) || 'Atty. ___';
    const notaryName  = notaryProper.toUpperCase();

    const docRange  = firstDoc === lastDoc ? String(firstDoc) : `${firstDoc}-${lastDoc}`;
    const pageRange = firstPage === lastPage ? String(firstPage) : `${String(firstPage).padStart(2, '0')}-${String(lastPage).padStart(2, '0')}`;

    const subject = `NOTARY REPORT OF ${notaryName} FOR ${monthName.toUpperCase()} OF BOOK ${bookLabel} BATCH ${batchNo}`;
    const body =
`Notary public: ${notaryProper}
Compliance period: ${periodFromHuman} to ${periodToHuman}
Submission of notarial report:
        Doc. No. ${docRange}
        Page No. ${pageRange}
        Book No. ${bookLabel}
        Series of ${seriesYear}
Mode of Transmittal: Electronic Mail
Number of documents or instruments: ${entries.length}

The summary report is attached. The notarized documents covered by this submission have been individually transmitted to the principals on file and remain available for inspection upon request, in compliance with the 2004 Rules on Notarial Practice (as amended by A.M. No. 02-8-13-SC).

Very respectfully,
${notaryProper}
Notary Public${state.profile?.roll_number ? ' · Roll No. ' + state.profile.roll_number : ''}${state.profile?.jurisdiction ? '\n' + state.profile.jurisdiction : ''}`;

    // Generate the monthly report PDF and upload it to storage so it can be
    // attached. The path is namespaced by user id so RLS keeps it private.
    let attachmentPath = null;
    try {
      const report = await generateMonthlyReport({
        lawyer: state.profile,
        periodStart: periodFrom,
        periodEnd: periodTo,
        entries,
        returnBlob: true
      });
      if (report?.blob) {
        const user = await getCurrentUser();
        attachmentPath = `${user.id}/reports/${monthStr}_batch-${batchNo}.pdf`;
        const { error: upErr } = await supabase.storage
          .from('notarial-documents')
          .upload(attachmentPath, report.blob, {
            contentType: 'application/pdf',
            upsert: true
          });
        if (upErr) {
          console.warn('Report upload failed, sending email without attachment:', upErr);
          attachmentPath = null;
        }
      }
    } catch (e) {
      console.warn('Report generation failed:', e);
    }

    await queueEmail({
      recipient: state.profile.ocs_email,
      subject,
      body,
      attachment_path: attachmentPath,
      register_entry_id: null
    });

    toast(`OCS submission queued: ${entries.length} docs, ${monthName}.`);
    await renderOutbox();
    updateOutboxBadge(await countQueued());
  } catch (e) {
    console.error(e);
    toast('Failed to compose OCS submission: ' + (e.message || e));
  }
}

async function handleSendAllQueued() {
  const queued = (state.cache.outboxRows || []).filter(r => r.status === 'queued');
  if (queued.length === 0) return;
  if (!confirm(`Send all ${queued.length} queued email(s) now?`)) return;
  toast('Sending…');
  try {
    const res = await sendAllQueued();
    if (res?.configured === false) {
      toast('Email sender not configured. Add RESEND_API_KEY in Supabase secrets.');
      return;
    }
    if (!res?.ok) {
      toast('Bulk send failed: ' + (res?.error || 'unknown error'));
      return;
    }
    const sent = res.sent || 0;
    const errored = res.errored || 0;
    toast(`${sent} sent${errored ? `, ${errored} errored` : ''}.`);
    await renderOutbox();
    updateOutboxBadge(await countQueued());
  } catch (e) {
    toast('Bulk send failed: ' + (e.message || e));
  }
}

function updateOutboxBadge(n) {
  const badge = document.getElementById('outbox-badge');
  if (!badge) return;
  if (n > 0) { badge.textContent = n; badge.classList.remove('hidden'); }
  else badge.classList.add('hidden');
}

// =============================================================
// 8. AUDIT LOG
// =============================================================
async function renderAudit() {
  try {
    state.cache.auditLogs = await listAuditLogs({ limit: 200 });
    renderAuditList();
  } catch (e) {
    document.getElementById('audit-list').innerHTML =
      `<div class="p-8 text-center text-rose-600 text-sm">Failed to load audit log: ${escapeHtml(e.message || '')}</div>`;
  }
}

function renderAuditList() {
  const filter = (document.getElementById('audit-filter')?.value || '').toLowerCase();
  const list = document.getElementById('audit-list');
  const empty = document.getElementById('audit-empty');
  if (!list) return;
  let rows = state.cache.auditLogs || [];
  if (filter) {
    rows = rows.filter(r => {
      const blob = `${r.action} ${JSON.stringify(r.metadata || {})} ${r.resource_type || ''}`.toLowerCase();
      return blob.includes(filter);
    });
  }
  if (rows.length === 0) {
    list.innerHTML = '';
    empty?.classList.remove('hidden');
    return;
  }
  empty?.classList.add('hidden');
  list.innerHTML = rows.map(r => {
    const cls = badgeClassForAction(r.action);
    const label = labelForAction(r.action);
    const detail = formatAuditDetail(r);
    return `
      <div class="p-4 flex items-start gap-4 hover:bg-violet-50 transition">
        <span class="evt-badge ${cls} shrink-0">${escapeHtml(label)}</span>
        <div class="flex-1 min-w-0 mono text-[11px] text-ink-700 leading-relaxed">${detail}</div>
        <div class="text-[11px] text-ink-500 shrink-0 whitespace-nowrap">${formatAuditTime(r.created_at)}</div>
      </div>
    `;
  }).join('');
}

function badgeClassForAction(a) {
  if (a === 'register_entry_created' || a === 'notarize') return 'evt-notarize';
  if (a === 'file_upload' || a === 'upload') return 'evt-upload';
  if (a === 'signup') return 'evt-signup';
  if (a === 'email_queued' || a === 'email_sent') return 'evt-email';
  if (a === 'login') return 'evt-login';
  if (a === 'logout') return 'evt-logout';
  return 'evt-default';
}

function labelForAction(a) {
  const map = {
    register_entry_created: 'Notarize',
    file_upload: 'Upload',
    email_queued: 'Email Queued',
    email_sent: 'Email Sent',
    profile_update: 'Settings',
    login: 'Login',
    logout: 'Logout',
    signup: 'Signup'
  };
  return map[a] || a;
}

function formatAuditDetail(r) {
  const meta = r.metadata || {};
  const parts = [];
  if (meta.doc_no) parts.push(`doc: "${pad3(meta.doc_no)}"`);
  if (meta.document_type) parts.push(`"${meta.document_type}"`);
  if (meta.principal) parts.push(`${meta.principal}`);
  if (meta.filename) parts.push(`file: "${meta.filename}"`);
  if (meta.recipient) parts.push(`to: ${meta.recipient}`);
  if (meta.email && r.action === 'signup') parts.push(`email: "${meta.email}"`);
  return escapeHtml(parts.join(' · ') || (r.resource_type ? `${r.resource_type}` : '—'));
}

function formatAuditTime(iso) {
  const d = new Date(iso);
  const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return `${date} · ${time}`;
}

// =============================================================
// 9. SETTINGS
// =============================================================
function renderSettings() {
  const p = state.profile || {};
  setVal('s-full-name', p.full_name);
  setVal('s-roll', p.roll_number);
  setVal('s-commission-no', p.notarial_commission_number);
  setVal('s-ibp', p.ibp_number);
  setVal('s-ptr', p.ptr_number);
  setVal('s-mcle', p.mcle_number);
  setVal('s-comm-from', p.notarial_commission_validity_from);
  setVal('s-expiry', p.commission_expiry || p.notarial_commission_validity_to);
  setVal('s-jurisdiction', p.jurisdiction);
  setVal('s-ocs', p.ocs_email);
  setVal('s-archive', p.archive_email);
  setVal('s-pattern', p.filename_pattern);
  refreshMfaStatus();
  renderVerificationStatusCard();
  renderSubscriptionCard();
}

function renderVerificationStatusCard() {
  // BETA: verification card hidden completely. Function kept for future re-enable.
  const card = document.getElementById('verification-status-card');
  if (card) card.classList.add('hidden');
  return;
  /* eslint-disable */
  const p = state.profile || {};
  const status = p.verification_status || 'unverified';
  const icon = document.getElementById('verif-icon');
  const title = document.getElementById('verif-title');
  const detail = document.getElementById('verif-detail');
  const btn = document.getElementById('btn-open-verification');
  card.classList.remove('hidden');
  if (status === 'verified') {
    if (icon) { icon.className = 'w-10 h-10 rounded-lg flex items-center justify-center shrink-0 bg-emerald-100 text-emerald-700'; icon.innerHTML = '<svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path d="M5 13l4 4L19 7"/></svg>'; }
    setText('verif-title', 'Notarial commission verified');
    setText('verif-detail', `Reviewed ${p.verification_reviewed_at ? new Date(p.verification_reviewed_at).toLocaleDateString() : ''}. Roll No. ${p.roll_number || '—'} · ${p.jurisdiction || ''}`);
    btn?.classList.add('hidden');
  } else if (status === 'pending') {
    if (icon) { icon.className = 'w-10 h-10 rounded-lg flex items-center justify-center shrink-0 bg-amber-100 text-amber-700'; icon.innerHTML = '<svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>'; }
    setText('verif-title', 'Verification pending review');
    setText('verif-detail', `Submitted ${p.verification_submitted_at ? new Date(p.verification_submitted_at).toLocaleDateString() : ''}. We'll email you within 1 business day.`);
    btn?.classList.add('hidden');
  } else if (status === 'rejected') {
    if (icon) { icon.className = 'w-10 h-10 rounded-lg flex items-center justify-center shrink-0 bg-rose-100 text-rose-700'; icon.innerHTML = '<svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/></svg>'; }
    setText('verif-title', 'Verification not approved');
    setText('verif-detail', p.verification_rejection_reason || 'Please resubmit with corrected documents.');
    btn?.classList.remove('hidden');
    btn?.classList.add('inline-flex');
    btn.textContent = 'Resubmit';
  } else {
    // unverified
    if (icon) { icon.className = 'w-10 h-10 rounded-lg flex items-center justify-center shrink-0 bg-violet-100 text-violet-700'; icon.innerHTML = '<svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M9 12l2 2 4-4"/><circle cx="12" cy="12" r="9"/></svg>'; }
    setText('verif-title', 'Verify your notarial commission');
    setText('verif-detail', 'Upload your IBP/SC ID and Notarial Commission Order to unlock notarial actions. Manual review by our team within 1 business day.');
    btn?.classList.remove('hidden');
    btn.textContent = 'Submit for verification';
  }
}

const VERIFICATION_BLOCKS_ACTIONS = true;

function renderSubscriptionCard() {
  const p = state.profile || {};
  // Trial = 60 days from account creation. Real subscriptions table comes when pricing is set.
  const created = p.created_at ? new Date(p.created_at) : new Date();
  const trialEnd = new Date(created); trialEnd.setDate(trialEnd.getDate() + 60);
  const today = new Date();
  const remaining = Math.max(0, Math.ceil((trialEnd - today) / (1000 * 60 * 60 * 24)));
  setText('sub-days-remaining', remaining);
  setText('sub-trial-end', `Trial ends ${trialEnd.toLocaleDateString('en-PH', { dateStyle: 'medium' })}`);
  setText('sub-plan-name', 'Free Beta');
  setText('sub-plan-detail', '60 days · all features');
  // Storage usage placeholder (real tracking comes with billing)
  setText('sub-storage-used', `— / 1 GB`);
  const bar = document.getElementById('sub-storage-bar');
  if (bar) bar.style.width = '0%';
}

// =============================================================
// 13. AVATAR UPLOAD
// =============================================================
async function handleAvatarUpload(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  if (!file.type.startsWith('image/')) { toast('Avatar must be an image.'); return; }
  if (file.size > 2 * 1024 * 1024) { toast('Avatar must be under 2 MB.'); return; }
  toast('Uploading avatar…');
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    const ext = (file.name.split('.').pop() || 'png').toLowerCase().replace(/[^a-z0-9]/g, '');
    const path = `${user.id}/avatar-${Date.now()}.${ext}`;
    const { error: upErr } = await supabase.storage.from('avatars').upload(path, file, { upsert: true });
    if (upErr) throw upErr;
    state.profile = await updateProfile({ avatar_path: path });
    renderProfileChrome();
    toast('Avatar updated.');
  } catch (e) {
    toast('Upload failed: ' + (e.message || e));
  }
}

// =============================================================
// 14. VERIFICATION FLOW (manual review)
// =============================================================
async function openVerificationView() {
  const p = state.profile || {};
  setVal('v-roll', p.roll_number || '');
  setVal('v-commission-no', p.notarial_commission_number || '');
  setVal('v-jurisdiction', p.jurisdiction || '');
  setVal('v-valid-from', p.notarial_commission_validity_from || '');
  setVal('v-valid-to', p.notarial_commission_validity_to || p.commission_expiry || '');
  setView('verification');

  // Hook the file inputs to show selected name
  const ibpFile = document.getElementById('v-ibp-file');
  const ibpName = document.getElementById('v-ibp-name');
  const commFile = document.getElementById('v-commission-file');
  const commName = document.getElementById('v-commission-name');
  if (ibpFile && !ibpFile._wired) {
    ibpFile._wired = true;
    ibpFile.parentElement.addEventListener('click', () => ibpFile.click());
    ibpFile.addEventListener('change', () => { if (ibpFile.files[0]) ibpName.textContent = ibpFile.files[0].name; });
  }
  if (commFile && !commFile._wired) {
    commFile._wired = true;
    commFile.parentElement.addEventListener('click', () => commFile.click());
    commFile.addEventListener('change', () => { if (commFile.files[0]) commName.textContent = commFile.files[0].name; });
  }
}

async function handleSubmitVerification() {
  const errEl = document.getElementById('v-error');
  if (errEl) errEl.textContent = '';
  const roll = readVal('v-roll', '').trim();
  const commNo = readVal('v-commission-no', '').trim();
  const juris = readVal('v-jurisdiction', '').trim();
  const validFrom = readVal('v-valid-from', '').trim() || null;
  const validTo = readVal('v-valid-to', '').trim() || null;
  const ibpFile = document.getElementById('v-ibp-file')?.files?.[0];
  const commFile = document.getElementById('v-commission-file')?.files?.[0];

  if (!roll || !commNo || !juris || !validTo) {
    if (errEl) errEl.textContent = 'Roll No., Commission No., Jurisdiction, and Validity To are required.';
    return;
  }
  const btn = document.getElementById('btn-submit-verification');
  btn.disabled = true; btn.textContent = 'Submitting…';
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) throw new Error('Not authenticated');

    const updates = {
      roll_number: roll,
      notarial_commission_number: commNo,
      jurisdiction: juris,
      notarial_commission_validity_from: validFrom,
      notarial_commission_validity_to: validTo,
      commission_expiry: validTo,
      verification_status: 'pending',
      verification_submitted_at: new Date().toISOString()
    };

    // Upload supporting documents if provided
    if (ibpFile) {
      const path = `${user.id}/ibp-${Date.now()}.${(ibpFile.name.split('.').pop() || 'jpg').toLowerCase()}`;
      const { error } = await supabase.storage.from('verification-documents').upload(path, ibpFile, { upsert: true });
      if (error) throw new Error('IBP upload failed: ' + error.message);
      updates.ibp_id_doc_path = path;
    }
    if (commFile) {
      const path = `${user.id}/commission-${Date.now()}.${(commFile.name.split('.').pop() || 'pdf').toLowerCase()}`;
      const { error } = await supabase.storage.from('verification-documents').upload(path, commFile, { upsert: true });
      if (error) throw new Error('Commission Order upload failed: ' + error.message);
      updates.commission_doc_path = path;
    }

    state.profile = await updateProfile(updates);
    await logAudit('verification_submitted', { roll, commission_no: commNo });
    toast('Submitted! We\'ll review within 1 business day.');
    setView('settings');
  } catch (e) {
    if (errEl) errEl.textContent = e.message || String(e);
    if (e.message?.toLowerCase().includes('duplicate')) {
      errEl.textContent = 'That Roll Number is already linked to another NotariPro account. If this is your account, please contact support@notaripro.app.';
    }
  } finally {
    btn.disabled = false; btn.textContent = 'Submit for verification';
  }
}

// =============================================================
// 15. DATA EXPORT (DPA right to portability)
// =============================================================
async function handleDataExport() {
  toast('Compiling your data…');
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    const [profile, entries, emails, audits, reports] = await Promise.all([
      supabase.from('lawyers').select('*').eq('id', user.id).single(),
      supabase.from('register_entries').select('*'),
      supabase.from('email_dispatch_queue').select('*'),
      supabase.from('audit_logs').select('*'),
      supabase.from('notarial_reports').select('*')
    ]);
    const archive = {
      exported_at: new Date().toISOString(),
      exported_for: user.email,
      profile: profile.data,
      register_entries: entries.data || [],
      email_dispatch_queue: emails.data || [],
      audit_logs: audits.data || [],
      notarial_reports: reports.data || []
    };
    const blob = new Blob([JSON.stringify(archive, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `NotariPro-data-export-${new Date().toISOString().slice(0,10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    await logAudit('data_export', {});
    toast('Exported.');
  } catch (e) {
    toast('Export failed: ' + (e.message || e));
  }
}

async function handleAccountDeleteRequest() {
  if (!confirm('Request account deletion? Your account will be marked for deletion. We will retain your notarial records as required by the Notarial Practice Rules and permanently delete after the retention period.')) return;
  try {
    state.profile = await updateProfile({ deletion_requested_at: new Date().toISOString() });
    await logAudit('deletion_requested', {});
    toast('Deletion request submitted. Our team will be in touch.');
  } catch (e) {
    toast('Request failed: ' + (e.message || e));
  }
}

async function handleSaveSettings() {
  const fields = {
    full_name: stripHonorific(readVal('s-full-name', '')),
    roll_number: readVal('s-roll', ''),
    ibp_number: readVal('s-ibp', ''),
    ptr_number: readVal('s-ptr', ''),
    mcle_number: readVal('s-mcle', ''),
    commission_expiry: readVal('s-expiry', '') || null,
    jurisdiction: readVal('s-jurisdiction', ''),
    ocs_email: readVal('s-ocs', ''),
    archive_email: readVal('s-archive', ''),
    filename_pattern: readVal('s-pattern', '')
  };
  try {
    state.profile = await updateProfile(fields);
    renderProfileChrome();
    toast('Settings saved.');
  } catch (e) {
    toast('Save failed: ' + (e.message || e));
  }
}

// =============================================================
// 10. MONTHLY NOTARIAL REPORT
// =============================================================
async function handleMonthlyReport() {
  if (!state.profile) return;
  const promptStart = prompt('Report period — START (YYYY-MM-DD):', firstOfMonth());
  if (!promptStart) return;
  const promptEnd = prompt('Report period — END (YYYY-MM-DD):', lastOfMonth());
  if (!promptEnd) return;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(promptStart) || !/^\d{4}-\d{2}-\d{2}$/.test(promptEnd)) {
    toast('Invalid date format. Use YYYY-MM-DD.');
    return;
  }
  toast('Generating report…');
  try {
    const entries = await listEntries({ from: promptStart, to: promptEnd });
    if (!entries || entries.length === 0) {
      toast('No entries in that period — nothing to report.');
      return;
    }
    const result = await generateMonthlyReport({
      lawyer: state.profile,
      periodStart: promptStart,
      periodEnd: promptEnd,
      entries
    });
    toast(`Generated · ${result.entryCount} entries · downloaded.`);
  } catch (e) {
    console.error(e);
    toast('Report failed: ' + (e.message || e));
  }
}

function firstOfMonth() {
  const d = new Date(); d.setDate(1);
  return d.toISOString().slice(0, 10);
}
function lastOfMonth() {
  const d = new Date();
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0);
  return last.toISOString().slice(0, 10);
}

// =============================================================
// 11. DEADLINE / COMMISSION EXPIRY BANNER
// =============================================================
function renderAlertBanner() {
  const banner = document.getElementById('alert-banner');
  if (!banner) return;
  const alerts = computeAlerts();
  if (alerts.length === 0) {
    banner.classList.add('hidden');
    banner.innerHTML = '';
    return;
  }
  const a = alerts[0]; // surface the most-urgent
  const bg = a.severity === 'critical' ? 'bg-rose-50 border-rose-200 text-rose-900'
           : a.severity === 'warn'     ? 'bg-amber-50 border-amber-200 text-amber-900'
           :                              'bg-violet-50 border-violet-200 text-violet-900';
  banner.className = `border-b ${bg}`;
  banner.innerHTML = `
    <div class="px-8 py-3 flex items-center gap-3">
      <svg class="w-4 h-4 shrink-0" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24"><path d="M12 9v4M12 17h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/></svg>
      <div class="text-sm flex-1">${escapeHtml(a.message)}</div>
      ${a.action ? `<button data-view="${a.action}" class="text-xs font-semibold underline underline-offset-2">${escapeHtml(a.actionLabel)}</button>` : ''}
    </div>
  `;
  banner.querySelector('[data-view]')?.addEventListener('click', e => setView(e.currentTarget.dataset.view));
  banner.classList.remove('hidden');
}

function computeAlerts() {
  const out = [];
  const p = state.profile || {};
  // Commission expiry awareness
  if (p.commission_expiry) {
    const days = daysUntil(p.commission_expiry);
    if (days !== null) {
      if (days < 0) {
        out.push({ severity: 'critical', message: `Your notarial commission expired ${Math.abs(days)} day(s) ago. Update your commission expiry in Settings.`, action: 'settings', actionLabel: 'Settings →' });
      } else if (days <= 30) {
        out.push({ severity: 'critical', message: `Your notarial commission expires in ${days} day(s). Renew with the Executive Judge before that date.`, action: 'settings', actionLabel: 'Settings →' });
      } else if (days <= 60) {
        out.push({ severity: 'warn', message: `Your notarial commission expires in ${days} day(s). Plan your renewal soon.`, action: 'settings', actionLabel: 'Settings →' });
      }
    }
  } else {
    out.push({ severity: 'info', message: 'Set your commission expiry in Settings so we can remind you before it lapses.', action: 'settings', actionLabel: 'Settings →' });
  }
  // Outbox queued reminder
  const pending = state.cache.pendingDispatch || 0;
  if (pending > 0) {
    out.push({ severity: 'warn', message: `${pending} email(s) queued and waiting to be sent.`, action: 'outbox', actionLabel: 'Outbox →' });
  }
  // Sort: critical first, then warn, then info
  const order = { critical: 0, warn: 1, info: 2 };
  out.sort((a, b) => order[a.severity] - order[b.severity]);
  return out;
}

function daysUntil(iso) {
  if (!iso) return null;
  const target = new Date(iso + 'T00:00:00');
  if (isNaN(target.getTime())) return null;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return Math.round((target - today) / (24 * 3600 * 1000));
}

// =============================================================
// 12. MFA ENROLLMENT (TOTP)
// =============================================================
let mfaEnrollContext = null; // { factorId, secret, qr_code }

async function refreshMfaStatus() {
  const status = document.getElementById('mfa-status');
  if (!status) return;
  try {
    const { data } = await supabase.auth.mfa.listFactors();
    const verified = (data?.totp || []).find(f => f.status === 'verified');
    if (verified) {
      status.textContent = 'Enabled';
      status.className = 'text-[10px] uppercase tracking-wider font-semibold px-2 py-1 rounded bg-emerald-100 text-emerald-700';
      showMfaPanel('enrolled');
    } else {
      status.textContent = 'Not enabled';
      status.className = 'text-[10px] uppercase tracking-wider font-semibold px-2 py-1 rounded bg-amber-100 text-amber-800';
      showMfaPanel('not-enrolled');
    }
  } catch (e) {
    status.textContent = 'Check failed';
    status.className = 'text-[10px] uppercase tracking-wider font-semibold px-2 py-1 rounded bg-rose-100 text-rose-700';
  }
}

function showMfaPanel(which) {
  ['mfa-not-enrolled', 'mfa-enrolling', 'mfa-enrolled'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('hidden', !id.endsWith(which));
  });
}

async function handleMfaEnroll() {
  try {
    // Clean up any prior unverified factors so we don't accumulate them
    const { data: list } = await supabase.auth.mfa.listFactors();
    for (const f of (list?.totp || [])) {
      if (f.status !== 'verified') {
        await supabase.auth.mfa.unenroll({ factorId: f.id }).catch(() => {});
      }
    }
    const { data, error } = await supabase.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'NotariPro TOTP' });
    if (error) { toast('Enroll failed: ' + error.message); return; }
    mfaEnrollContext = { factorId: data.id, secret: data.totp.secret, qr: data.totp.qr_code };
    setText('mfa-secret', data.totp.secret);
    const qrWrap = document.getElementById('mfa-qr-wrap');
    if (qrWrap) qrWrap.innerHTML = `<img src="${data.totp.qr_code}" alt="MFA QR code" class="w-44 h-44">`;
    showMfaPanel('enrolling');
    setText('mfa-error', '');
  } catch (e) {
    toast('Enroll failed: ' + (e.message || e));
  }
}

async function handleMfaVerify() {
  if (!mfaEnrollContext) return;
  const code = readVal('mfa-code', '').trim();
  if (!/^\d{6}$/.test(code)) { setText('mfa-error', 'Enter the 6-digit code from your authenticator.'); return; }
  setText('mfa-error', '');
  try {
    const { data: chal, error: chalErr } = await supabase.auth.mfa.challenge({ factorId: mfaEnrollContext.factorId });
    if (chalErr) { setText('mfa-error', chalErr.message); return; }
    const { error: vErr } = await supabase.auth.mfa.verify({
      factorId: mfaEnrollContext.factorId,
      challengeId: chal.id,
      code
    });
    if (vErr) { setText('mfa-error', vErr.message); return; }
    mfaEnrollContext = null;
    toast('Two-factor authentication enabled.');
    await logAudit('mfa_enabled', {});
    await refreshMfaStatus();
  } catch (e) {
    setText('mfa-error', e.message || String(e));
  }
}

async function handleMfaDisable() {
  if (!confirm('Disable two-factor authentication on this account? Your login will fall back to email + password.')) return;
  try {
    const { data } = await supabase.auth.mfa.listFactors();
    const verified = (data?.totp || []).find(f => f.status === 'verified');
    if (!verified) { await refreshMfaStatus(); return; }
    const { error } = await supabase.auth.mfa.unenroll({ factorId: verified.id });
    if (error) { toast('Disable failed: ' + error.message); return; }
    toast('Two-factor authentication disabled.');
    await logAudit('mfa_disabled', {});
    await refreshMfaStatus();
  } catch (e) {
    toast('Disable failed: ' + (e.message || e));
  }
}

// =============================================================
// 16. DELETE / EDIT (register entries + outbox emails)
// =============================================================
async function handleDeleteEntry(id, label) {
  if (!confirm(`Delete register entry ${label}?\n\nThis cannot be undone. The Doc No. will be skipped in your sequence unless you manually re-use it on the next entry.`)) return;
  try {
    await deleteEntry(id);
    toast('Register entry deleted.');
    await renderRegister();
  } catch (e) {
    toast('Delete failed: ' + (e.message || e));
  }
}

async function handleDeleteEmail(id, subject) {
  if (!confirm(`Delete email "${subject || 'this message'}"?\n\nThis removes it from your outbox.`)) return;
  try {
    await deleteEmail(id);
    toast('Email deleted.');
    await renderOutbox();
    updateOutboxBadge(await countQueued());
  } catch (e) {
    toast('Delete failed: ' + (e.message || e));
  }
}

let emailEditCtx = null;
function openEmailEditModal(id) {
  const row = (state.cache.outboxRows || []).find(r => r.id === id);
  if (!row) { toast('Email not found in current view.'); return; }
  if (row.status !== 'queued') { toast('Only queued emails can be edited.'); return; }
  emailEditCtx = { id };
  setVal('em-recipient', row.recipient || '');
  setVal('em-cc', row.cc || '');
  setVal('em-subject', row.subject || '');
  setVal('em-body', row.body || '');
  setText('em-error', '');
  document.getElementById('email-edit-modal')?.classList.remove('hidden');
}

function closeEmailEditModal() {
  emailEditCtx = null;
  document.getElementById('email-edit-modal')?.classList.add('hidden');
}

async function handleEmailEditSave() {
  if (!emailEditCtx) return;
  const recipient = readVal('em-recipient', '').trim();
  const subject = readVal('em-subject', '').trim();
  const body = readVal('em-body', '');
  const cc = readVal('em-cc', '').trim() || null;
  const errEl = document.getElementById('em-error');
  if (!recipient || !subject || !body) {
    if (errEl) errEl.textContent = 'Recipient, subject, and body are required.';
    return;
  }
  const btn = document.getElementById('btn-email-edit-save');
  btn.disabled = true; btn.textContent = 'Saving…';
  try {
    await updateQueued(emailEditCtx.id, { recipient, subject, body, cc });
    toast('Email updated.');
    closeEmailEditModal();
    await renderOutbox();
  } catch (e) {
    if (errEl) errEl.textContent = 'Save failed: ' + (e.message || e);
  } finally {
    btn.disabled = false; btn.textContent = 'Save changes';
  }
}

// =============================================================
// 17. VIEWPORT SWITCHER (bottom-left)
// =============================================================
function setViewport(mode) {
  const root = document.documentElement;
  // Modes: app (default fluid), mobile (~414px), browser (1280px max)
  root.dataset.viewport = mode;
  const styleId = 'viewport-style';
  let style = document.getElementById(styleId);
  if (!style) { style = document.createElement('style'); style.id = styleId; document.head.appendChild(style); }
  if (mode === 'mobile') {
    style.textContent = `
      #screen-app, #screen-login { max-width: 414px; margin: 0 auto; box-shadow: 0 0 0 1px #d8d8e5, 0 30px 80px rgba(26,15,79,0.15); border-radius: 24px; overflow: hidden; min-height: 800px; }
      body { background: linear-gradient(180deg, #eeeef5 0%, #d8d8e5 100%); padding: 32px 0; }
      aside.w-64 { width: 0 !important; display: none !important; }
      main.flex-1 { padding: 0 !important; }
      .grid-cols-4, .grid-cols-3, .grid-cols-2 { grid-template-columns: 1fr !important; }
      .grid-cols-5 { grid-template-columns: 1fr !important; }
      .col-span-2, .col-span-3 { grid-column: span 1 !important; }
    `;
  } else if (mode === 'browser') {
    style.textContent = `
      #screen-app, #screen-login { max-width: 1280px; margin: 0 auto; }
    `;
  } else {
    // app (default) — clear overrides
    style.textContent = '';
  }
  // Highlight the active button
  document.querySelectorAll('[data-viewport]').forEach(b => {
    b.classList.toggle('vp-active', b.dataset.viewport === mode);
  });
  try { localStorage.setItem('notaripro:viewport', mode); } catch {}
}

// =============================================================
// helpers
// =============================================================
function setText(id, v) { const el = document.getElementById(id); if (el) el.textContent = v ?? ''; }
function setVal(id, v) { const el = document.getElementById(id); if (el) el.value = v ?? ''; }
function readVal(id, fallback) { const el = document.getElementById(id); return el ? el.value : fallback; }
function pad3(n) { return String(n).padStart(3, '0'); }
function escapeHtml(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }
function escapeAttr(s) { return escapeHtml(s); }
function initialsOf(s) { return (s || '?').split(' ').filter(Boolean).map(w => w[0]).slice(0, 2).join('').toUpperCase(); }
function formatLong(iso) {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('en-US', { day: 'numeric', month: 'long', year: 'numeric' });
}
function formatShort(iso) {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
function batchTimeToday(hhmm) {
  const [h, m] = (hhmm || '17:00').split(':').map(Number);
  const d = new Date(); d.setHours(h, m, 0, 0);
  return d.toISOString();
}
function toast(msg) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2800);
}
