// /js/reports.js
// Generate the Monthly Notarial Report PDF.
//
// Uses jsPDF + jsPDF-AutoTable, loaded from CDN by app.html.
// Output mimics the reportorial format that lawyers submit to the
// Executive Judge / Office of the Clerk of Court.

import { supabase } from './supabaseClient.js';
import { logAudit } from './audit.js';

/**
 * @param {object} opts
 * @param {object} opts.lawyer        lawyers row (full_name, roll_number, etc.)
 * @param {string} opts.periodStart   YYYY-MM-DD
 * @param {string} opts.periodEnd     YYYY-MM-DD (inclusive)
 * @param {Array}  opts.entries       register_entries rows for the period
 * @param {boolean} [opts.returnBlob] when true, return the PDF as a Blob and
 *                                    skip the browser download + tracking row.
 *                                    Used by the OCS submission email flow.
 */
export async function generateMonthlyReport({ lawyer, periodStart, periodEnd, entries, returnBlob = false }) {
  if (!window.jspdf || !window.jspdf.jsPDF) {
    throw new Error('jsPDF not loaded. Refresh the page and try again.');
  }
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'pt', format: 'letter' });
  const PW = doc.internal.pageSize.getWidth();
  const MARGIN = 48;

  // Header
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.text('NOTARIAL REPORT', PW / 2, MARGIN, { align: 'center' });

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.text(`For the period ${formatLong(periodStart)} to ${formatLong(periodEnd)}`,
    PW / 2, MARGIN + 16, { align: 'center' });

  // Notary block. full_name is stored without an honorific — prepend "Atty.".
  const stripHonorific = (n) => (n || '').replace(/^\s*(Atty\.?|Attorney|Hon\.?)\s+/i, '').trim();
  const attyFullName = stripHonorific(lawyer.full_name)
    ? `Atty. ${stripHonorific(lawyer.full_name)}`
    : (lawyer.full_name || '');
  let y = MARGIN + 44;
  doc.setFontSize(9);
  const notaryLines = [
    `Notary Public: ${attyFullName}`,
    `Roll of Attorneys No.: ${lawyer.roll_number || '—'}    IBP No.: ${lawyer.ibp_number || '—'}`,
    `PTR No.: ${lawyer.ptr_number || '—'}    MCLE Compliance No.: ${lawyer.mcle_number || '—'}`,
    `Territorial Jurisdiction: ${lawyer.jurisdiction || '—'}`,
    `Commission Expiry: ${lawyer.commission_expiry || '—'}`
  ];
  notaryLines.forEach(line => { doc.text(line, MARGIN, y); y += 13; });

  // Summary stats — notarial fees are confidential and intentionally omitted.
  y += 8;
  doc.setFont('helvetica', 'bold');
  doc.text(`Total entries: ${entries.length}`, MARGIN, y);

  // Entries table — sorted chronologically, then by doc_no, for the official report
  const sorted = [...entries].sort((a, b) => {
    const d = String(a.notarization_date).localeCompare(String(b.notarization_date));
    if (d !== 0) return d;
    return (a.doc_no || 0) - (b.doc_no || 0);
  });
  const head = [['Doc No.', 'Date', 'Document Type', 'Notarial Act', 'Principal(s)', 'Page', 'Book']];
  const rows = sorted.map(r => [
    `${r.series_year}-${pad3(r.doc_no)}`,
    r.notarization_date,
    r.document_type || '',
    r.notarial_act || '',
    r.principal || '',
    String(r.page_no),
    r.book_no || ''
  ]);

  // jsPDF-AutoTable
  doc.autoTable({
    head, body: rows,
    startY: y + 16,
    margin: { left: MARGIN, right: MARGIN },
    styles: { fontSize: 8, cellPadding: 4, overflow: 'linebreak' },
    headStyles: { fillColor: [242, 238, 251], textColor: [70, 37, 138], fontStyle: 'bold' },
    alternateRowStyles: { fillColor: [248, 246, 252] },
    columnStyles: {
      0: { cellWidth: 60, fontStyle: 'bold', textColor: [70, 37, 138] },
      1: { cellWidth: 60 },
      4: { cellWidth: 140 }
    }
  });

  // Footer with affirmation + signature line, on the last page
  const finalY = doc.lastAutoTable?.finalY || y + 100;
  const room = doc.internal.pageSize.getHeight() - finalY;
  if (room < 110) doc.addPage();
  const fy = (doc.lastAutoTable?.finalY && room >= 110)
    ? doc.lastAutoTable.finalY + 24
    : MARGIN;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  const affirmation = `I HEREBY CERTIFY that the above is a true and faithful record of all notarial acts performed by me during the stated period, in compliance with the 2004 Notarial Rules and the 2025 Amendments to the 2004 Rules on Notarial Practice (A.M. No. 02-8-13-SC).`;
  const split = doc.splitTextToSize(affirmation, PW - MARGIN * 2);
  doc.text(split, MARGIN, fy);

  const sigY = fy + split.length * 12 + 36;
  doc.text('_______________________________', MARGIN, sigY);
  doc.setFont('helvetica', 'bold');
  doc.text(attyFullName || 'Notary Public', MARGIN, sigY + 14);
  doc.setFont('helvetica', 'normal');
  doc.text(`Notary Public${lawyer.roll_number ? ' · Roll No. ' + lawyer.roll_number : ''}`, MARGIN, sigY + 26);
  doc.text(`Date generated: ${new Date().toLocaleDateString('en-PH', { dateStyle: 'long' })}`, MARGIN, sigY + 40);

  const filename = `NotariPro_Notarial-Report_${periodStart}_to_${periodEnd}.pdf`;

  // OCS submission flow: hand back a Blob instead of triggering a download.
  if (returnBlob) {
    return { blob: doc.output('blob'), filename, entryCount: entries.length };
  }

  // Save
  doc.save(filename);

  // Persist a tracking row (best-effort)
  try {
    await supabase.from('notarial_reports').insert({
      lawyer_id: lawyer.id,
      period_start: periodStart,
      period_end: periodEnd,
      entry_count: entries.length
    });
    await logAudit('report_generated',
      { period_start: periodStart, period_end: periodEnd, entry_count: entries.length },
      { type: 'notarial_report' });
  } catch (e) {
    console.warn('[reports] tracking insert failed (non-fatal):', e?.message || e);
  }

  return { filename, entryCount: entries.length };
}

function pad3(n) { return String(n).padStart(3, '0'); }
function formatLong(iso) {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('en-PH', { day: 'numeric', month: 'long', year: 'numeric' });
}
