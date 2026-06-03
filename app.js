const EMAIL_REGEX = /(?:mailto:)?([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/gi;
const OBFUSCATED_EMAIL_REGEX = /\b([A-Z0-9._%+-]+)\s*(?:\[at\]|\(at\)|\sat\s)\s*([A-Z0-9.-]+)\s*(?:\[dot\]|\(dot\)|\sdot\s)\s*([A-Z]{2,})\b/gi;

const state = {
  documents: [],
  emailMap: new Map(),
};

const els = {
  fileInput: document.getElementById('fileInput'),
  fileSummary: document.getElementById('fileSummary'),
  replacementText: document.getElementById('replacementText'),
  exportMode: document.getElementById('exportMode'),
  preserveLayout: document.getElementById('preserveLayout'),
  safetyNet: document.getElementById('safetyNet'),
  includeMetadata: document.getElementById('includeMetadata'),
  emailTableWrap: document.getElementById('emailTableWrap'),
  selectAllBtn: document.getElementById('selectAllBtn'),
  selectNoneBtn: document.getElementById('selectNoneBtn'),
  selectRecipientsBtn: document.getElementById('selectRecipientsBtn'),
  selectBodyBtn: document.getElementById('selectBodyBtn'),
  exportBtn: document.getElementById('exportBtn'),
  clearBtn: document.getElementById('clearBtn'),
  status: document.getElementById('status'),
};

function setStatus(message, type = '') {
  els.status.className = `status ${type}`.trim();
  els.status.textContent = message;
}

function normaliseEmail(email) {
  return email.replace(/^mailto:/i, '').trim().replace(/[>),.;:]+$/g, '').toLowerCase();
}

function cleanEmailText(text) {
  return text
    .replace(/=\r?\n/g, '')
    .replace(/=20/g, ' ')
    .replace(/=3D/g, '=')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\u00a0/g, ' ');
}

function htmlToText(html) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  doc.querySelectorAll('script, style').forEach(n => n.remove());
  return doc.body ? doc.body.innerText : html;
}

function parseHeaders(raw) {
  const headerEnd = raw.search(/\r?\n\r?\n/);
  const headerText = headerEnd >= 0 ? raw.slice(0, headerEnd) : '';
  const unfolded = headerText.replace(/\r?\n[ \t]+/g, ' ');
  const headers = {};
  for (const line of unfolded.split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (!headers[key]) headers[key] = [];
    headers[key].push(value);
  }
  return headers;
}

function extractEmailMatches(text) {
  const found = new Map();
  const cleaned = cleanEmailText(text || '');

  for (const match of cleaned.matchAll(EMAIL_REGEX)) {
    const full = match[0];
    const email = normaliseEmail(match[1] || full);
    if (email.includes('@')) found.set(email, email);
  }

  for (const match of cleaned.matchAll(OBFUSCATED_EMAIL_REGEX)) {
    const email = `${match[1]}@${match[2]}.${match[3]}`.toLowerCase();
    found.set(email, email);
  }

  return Array.from(found.keys()).sort();
}

function findMultipartBody(raw) {
  const textPlain = [];
  const textHtml = [];
  const parts = raw.split(/\r?\n--[^\r\n]+/g);
  for (const part of parts) {
    const lower = part.slice(0, 800).toLowerCase();
    const split = part.search(/\r?\n\r?\n/);
    if (split < 0) continue;
    const body = cleanEmailText(part.slice(split));
    if (lower.includes('content-type: text/plain')) textPlain.push(body);
    if (lower.includes('content-type: text/html')) textHtml.push(htmlToText(body));
  }
  if (textPlain.length) return textPlain.join('\n\n');
  if (textHtml.length) return textHtml.join('\n\n');
  const split = raw.search(/\r?\n\r?\n/);
  return split >= 0 ? raw.slice(split) : raw;
}

function extractTextFromFile(name, raw) {
  const lower = name.toLowerCase();
  const cleanedRaw = cleanEmailText(raw);
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return htmlToText(cleanedRaw);
  if (lower.endsWith('.eml')) return findMultipartBody(cleanedRaw);
  return cleanedRaw;
}

function emailSourcesForDoc(doc, email) {
  const sources = [];
  for (const [header, emails] of Object.entries(doc.headerEmails)) {
    if (emails.includes(email)) sources.push(header.toUpperCase());
  }
  if (doc.bodyEmails.includes(email)) sources.push('Body');
  return sources;
}

function addEmailToMap(email, fileName, sources) {
  const key = normaliseEmail(email);
  if (!state.emailMap.has(key)) {
    state.emailMap.set(key, { email: key, files: new Set(), sources: new Set(), selected: true });
  }
  const entry = state.emailMap.get(key);
  entry.files.add(fileName);
  for (const source of sources) entry.sources.add(source);
}

async function readFileAsText(file) {
  return await file.text();
}

async function handleFiles(files) {
  state.documents = [];
  state.emailMap = new Map();
  setStatus('Reading files...');

  for (const file of files) {
    const raw = await readFileAsText(file);
    const headers = parseHeaders(raw);
    const text = extractTextFromFile(file.name, raw);

    const headerEmails = { to: [], cc: [], bcc: [], from: [], 'reply-to': [] };
    for (const header of Object.keys(headerEmails)) {
      headerEmails[header] = extractEmailMatches((headers[header] || []).join(', '));
    }

    const bodyEmails = extractEmailMatches(text);
    const doc = { name: file.name, raw, headers, headerEmails, text, bodyEmails };
    state.documents.push(doc);

    for (const [header, emails] of Object.entries(headerEmails)) {
      for (const email of emails) addEmailToMap(email, file.name, [header.toUpperCase()]);
    }
    for (const email of bodyEmails) addEmailToMap(email, file.name, ['Body']);
  }

  renderSummary();
  renderEmailTable();
  setStatus(`Loaded ${state.documents.length} file(s). Found ${state.emailMap.size} unique email address(es).`, 'success');
}

function renderSummary() {
  if (!state.documents.length) {
    els.fileSummary.textContent = '';
    return;
  }
  els.fileSummary.innerHTML = `<strong>${state.documents.length}</strong> file(s) loaded. <strong>${state.emailMap.size}</strong> unique email address(es) found.`;
}

function renderEmailTable() {
  if (!state.emailMap.size) {
    els.emailTableWrap.textContent = state.documents.length ? 'No email addresses detected.' : 'Upload files to see detected email addresses.';
    return;
  }

  const entries = Array.from(state.emailMap.values()).sort((a, b) => a.email.localeCompare(b.email));
  els.emailTableWrap.innerHTML = `
    <table>
      <thead><tr><th>Redact</th><th>Email address</th><th>Found in</th><th>Files</th></tr></thead>
      <tbody>
        ${entries.map((entry, idx) => `
          <tr>
            <td><input class="email-check" type="checkbox" data-email="${escapeHtml(entry.email)}" ${entry.selected ? 'checked' : ''}></td>
            <td><code>${escapeHtml(entry.email)}</code></td>
            <td>${escapeHtml(Array.from(entry.sources).sort().join(', '))}</td>
            <td>${escapeHtml(Array.from(entry.files).sort().join(', '))}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
  els.emailTableWrap.querySelectorAll('.email-check').forEach(cb => {
    cb.addEventListener('change', e => {
      const entry = state.emailMap.get(e.target.dataset.email);
      if (entry) entry.selected = e.target.checked;
    });
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>'"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[ch]));
}

function makePdfSafeText(value) {
  return String(value)
    .replace(/[\u2580-\u259F]/g, 'x')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, '');
}

function setSelection(predicate) {
  for (const entry of state.emailMap.values()) entry.selected = predicate(entry);
  renderEmailTable();
}

function makeReplacement(original, replacement, preserveLayout) {
  if (!preserveLayout) return replacement;
  if (replacement.length === original.length) return replacement;
  if (replacement.length < original.length) return replacement + ' '.repeat(original.length - replacement.length);
  return 'x'.repeat(Math.max(3, original.length));
}

function redactText(text, selectedEmails, replacement, preserveLayout, safetyNet) {
  let output = cleanEmailText(text || '');

  output = output.replace(EMAIL_REGEX, (full, captured) => {
    const email = normaliseEmail(captured || full);
    if (selectedEmails.has(email) || safetyNet) {
      return makeReplacement(full, replacement, preserveLayout);
    }
    return full;
  });

  output = output.replace(OBFUSCATED_EMAIL_REGEX, (full, local, domain, tld) => {
    const email = `${local}@${domain}.${tld}`.toLowerCase();
    if (selectedEmails.has(email) || safetyNet) {
      return makeReplacement(full, replacement, preserveLayout);
    }
    return full;
  });

  return output;
}

function buildOutputText(doc, selectedEmails, replacement, preserveLayout, safetyNet, includeMetadata) {
  const parts = [];
  if (includeMetadata) {
    const subject = (doc.headers.subject || [''])[0];
    const date = (doc.headers.date || [''])[0];
    const from = (doc.headers.from || ['']).join(', ');
    const to = (doc.headers.to || ['']).join(', ');
    const cc = (doc.headers.cc || ['']).join(', ');
    const bcc = (doc.headers.bcc || ['']).join(', ');
    parts.push(doc.name);
    if (subject) parts.push(`Subject: ${subject}`);
    if (date) parts.push(`Date: ${date}`);
    if (from) parts.push(`From: ${redactText(from, selectedEmails, replacement, preserveLayout, safetyNet)}`);
    if (to) parts.push(`To: ${redactText(to, selectedEmails, replacement, preserveLayout, safetyNet)}`);
    if (cc) parts.push(`Cc: ${redactText(cc, selectedEmails, replacement, preserveLayout, safetyNet)}`);
    if (bcc) parts.push(`Bcc: ${redactText(bcc, selectedEmails, replacement, preserveLayout, safetyNet)}`);
    parts.push('');
  }
  parts.push(redactText(doc.text, selectedEmails, replacement, preserveLayout, safetyNet));
  return parts.join('\n');
}

async function createPdfBytes(title, text) {
  const { PDFDocument, StandardFonts, rgb } = PDFLib;
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Courier);
  const bold = await pdfDoc.embedFont(StandardFonts.CourierBold);
  const pageSize = [595.28, 841.89];
  const margin = 42;
  const fontSize = 9;
  const lineHeight = 12;
  const maxChars = 92;
  let page = pdfDoc.addPage(pageSize);
  let y = pageSize[1] - margin;

  page.drawText(makePdfSafeText(title).slice(0, 90), { x: margin, y, size: 11, font: bold, color: rgb(0, 0.25, 0.53) });
  y -= 22;

  function newPage() {
    page = pdfDoc.addPage(pageSize);
    y = pageSize[1] - margin;
  }

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine || ' ';
    const chunks = [];
    for (let i = 0; i < line.length; i += maxChars) chunks.push(line.slice(i, i + maxChars));
    if (!chunks.length) chunks.push(' ');
    for (const chunk of chunks) {
      if (y < margin) newPage();
      page.drawText(makePdfSafeText(chunk), { x: margin, y, size: fontSize, font });
      y -= lineHeight;
    }
  }

  return await pdfDoc.save();
}

async function exportFiles() {
  if (!state.documents.length) {
    setStatus('Upload at least one file first.', 'error');
    return;
  }

  setStatus('Generating export...');
  const selectedEmails = new Set(Array.from(state.emailMap.values()).filter(e => e.selected).map(e => e.email));
  const replacement = els.replacementText.value || '[email redacted]';
  const preserveLayout = els.preserveLayout.checked;
  const safetyNet = els.safetyNet.checked;
  const includeMetadata = els.includeMetadata.checked;
  const exportMode = els.exportMode.value;

  try {
    if (exportMode === 'txtzip') {
      const zip = new JSZip();
      for (const doc of state.documents) {
        const text = buildOutputText(doc, selectedEmails, replacement, preserveLayout, safetyNet, includeMetadata);
        zip.file(`${safeBaseName(doc.name)}_redacted.txt`, text);
      }
      downloadBlob(await zip.generateAsync({ type: 'blob' }), 'redacted_text_files.zip');
    } else if (exportMode === 'zip') {
      const zip = new JSZip();
      for (const doc of state.documents) {
        const text = buildOutputText(doc, selectedEmails, replacement, preserveLayout, safetyNet, includeMetadata);
        const pdfBytes = await createPdfBytes(`${doc.name}`, text);
        zip.file(`${safeBaseName(doc.name)}_redacted.pdf`, pdfBytes);
      }
      zip.file('redaction_audit.csv', buildAuditCsv(selectedEmails));
      downloadBlob(await zip.generateAsync({ type: 'blob' }), 'redacted_pdfs.zip');
    } else {
      const { PDFDocument } = PDFLib;
      const combined = await PDFDocument.create();
      for (const doc of state.documents) {
        const text = buildOutputText(doc, selectedEmails, replacement, preserveLayout, safetyNet, includeMetadata);
        const pdfBytes = await createPdfBytes(`${doc.name}`, text);
        const src = await PDFDocument.load(pdfBytes);
        const pages = await combined.copyPages(src, src.getPageIndices());
        pages.forEach(p => combined.addPage(p));
      }
      const combinedBytes = await combined.save();
      downloadBlob(new Blob([combinedBytes], { type: 'application/pdf' }), 'combined_redacted_documents.pdf');
    }
    setStatus('Export generated successfully.', 'success');
  } catch (error) {
    console.error(error);
    setStatus(`Export failed: ${error.message}`, 'error');
  }
}

function buildAuditCsv(selectedEmails) {
  const rows = [['Email', 'Selected', 'Sources', 'Files']];
  for (const entry of Array.from(state.emailMap.values()).sort((a, b) => a.email.localeCompare(b.email))) {
    rows.push([
      entry.email,
      selectedEmails.has(entry.email) ? 'yes' : 'no',
      Array.from(entry.sources).sort().join('; '),
      Array.from(entry.files).sort().join('; '),
    ]);
  }
  return rows.map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\n');
}

function safeBaseName(name) {
  return name.replace(/\.[^.]+$/, '').replace(/[^a-z0-9_-]+/gi, '_').replace(/^_+|_+$/g, '') || 'document';
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

els.fileInput.addEventListener('change', e => handleFiles(Array.from(e.target.files || [])));
els.selectAllBtn.addEventListener('click', () => setSelection(() => true));
els.selectNoneBtn.addEventListener('click', () => setSelection(() => false));
els.selectRecipientsBtn.addEventListener('click', () => setSelection(entry => ['TO', 'CC', 'BCC'].some(s => entry.sources.has(s))));
els.selectBodyBtn.addEventListener('click', () => setSelection(entry => entry.sources.has('Body')));
els.exportBtn.addEventListener('click', exportFiles);
els.clearBtn.addEventListener('click', () => {
  state.documents = [];
  state.emailMap = new Map();
  els.fileInput.value = '';
  renderSummary();
  renderEmailTable();
  setStatus('Cleared.');
});
