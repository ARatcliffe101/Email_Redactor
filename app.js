const EMAIL_REGEX = /(?:mailto:)?([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/gi;
const OBFUSCATED_EMAIL_REGEX = /\b([A-Z0-9._%+-]+)\s*(?:\[at\]|\(at\)|\sat\s)\s*([A-Z0-9.-]+)\s*(?:\[dot\]|\(dot\)|\sdot\s)\s*([A-Z]{2,})\b/gi;
const MAX_METADATA_FIELD_CHARS = 1800;
const SUPPORTED_FILE_TYPES = {
  eml: 'email message',
  msg: 'Outlook message',
  txt: 'plain text',
  html: 'HTML document',
  htm: 'HTML document',
  csv: 'CSV text',
  md: 'Markdown text',
  log: 'log text',
  docx: 'Word document',
  doc: 'Legacy Word document',
};
const UNSUPPORTED_FILE_MESSAGES = {
  pdf: 'PDF parsing is not supported in this browser version. Use the desktop version or export the PDF text first.',
  xls: 'Spreadsheets are not supported in this browser version. Save as .csv or use the desktop version.',
  xlsx: 'Spreadsheets are not supported in this browser version. Save as .csv or use the desktop version.',
};

const state = {
  documents: [],
  emailMap: new Map(),
  loadErrors: [],
  ignoredFiles: [],
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

function cleanExtractedString(value) {
  return String(value || '')
    .replace(/\u0000/g, '')
    .replace(/[\x01-\x08\x0B\x0C\x0E-\x1F]/g, '')
    .trim();
}


function isIgnorableFileName(name) {
  const baseName = String(name || '').split(/[\\/]/).pop();
  const lower = baseName.toLowerCase();

  return (
    !baseName ||
    baseName.startsWith('~$') ||
    baseName.startsWith('._') ||
    lower === '.ds_store' ||
    lower === 'thumbs.db' ||
    lower.endsWith('.tmp') ||
    lower.endsWith('.db') ||
    lower.endsWith('.7z') ||
    lower.endsWith('.zip')
  );
}

function waitForUi() {
  return new Promise(resolve => {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => resolve());
    } else {
      setTimeout(resolve, 0);
    }
  });
}

function getFileExtension(name) {
  const match = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  return match ? match[1] : '';
}

function getSupportedFileType(name) {
  const extension = getFileExtension(name);
  if (SUPPORTED_FILE_TYPES[extension]) return extension;
  return '';
}

function assertSupportedFile(name) {
  const extension = getFileExtension(name);
  const supportedType = getSupportedFileType(name);
  if (supportedType) return supportedType;

  if (UNSUPPORTED_FILE_MESSAGES[extension]) {
    throw new Error(UNSUPPORTED_FILE_MESSAGES[extension]);
  }

  throw new Error('Unsupported file type. Please upload .eml, .msg, .docx, .doc, .txt, .html, .htm, .csv, .log, or .md files.');
}

function isBinarySupportedType(fileType) {
  return fileType === 'msg' || fileType === 'docx' || fileType === 'doc';
}

function assertLooksLikeText(raw, name) {
  const text = String(raw || '');
  if (!text) return;

  if (text.includes('\u0000')) {
    throw new Error(`${name} looks like a binary file, so it was skipped.`);
  }

  const sample = text.slice(0, 4000);
  const controlChars = (sample.match(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g) || []).length;
  if (controlChars > Math.max(8, sample.length * 0.02)) {
    throw new Error(`${name} contains binary/control data, so it was skipped.`);
  }
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

function normaliseCharset(charset) {
  const value = String(charset || 'utf-8').trim().toLowerCase().replace(/^"|"$/g, '');
  if (['latin1', 'latin-1', 'iso8859-1', 'windows-1252'].includes(value)) return 'iso-8859-1';
  return value || 'utf-8';
}

function decodeBytes(bytes, charset = 'utf-8') {
  const preferred = normaliseCharset(charset);
  const fallbacks = [preferred, 'utf-8', 'iso-8859-1'];

  for (const name of [...new Set(fallbacks)]) {
    try {
      return new TextDecoder(name).decode(bytes);
    } catch (err) {
      // Try the next browser-supported charset.
    }
  }

  return Array.from(bytes, byte => String.fromCharCode(byte)).join('');
}

function decodeQuotedPrintable(value, charset = 'utf-8') {
  const text = String(value || '').replace(/=\r?\n/g, '');
  const bytes = [];

  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '=' && /^[0-9A-F]{2}$/i.test(text.slice(i + 1, i + 3))) {
      bytes.push(parseInt(text.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      const code = text.charCodeAt(i);
      if (code <= 0xff) {
        bytes.push(code);
      } else {
        for (const byte of new TextEncoder().encode(text[i])) bytes.push(byte);
      }
    }
  }

  return decodeBytes(new Uint8Array(bytes), charset);
}

function decodeBase64(value, charset = 'utf-8') {
  const compact = String(value || '').replace(/\s+/g, '');
  if (!compact) return '';

  try {
    const binary = atob(compact);
    const bytes = Uint8Array.from(binary, ch => ch.charCodeAt(0));
    return decodeBytes(bytes, charset);
  } catch (err) {
    throw new Error('Invalid base64 content in email body.');
  }
}

function decodeMimeWords(value) {
  return String(value || '').replace(/=\?([^?]+)\?([QB])\?([^?]*)\?=/gi, (full, charset, encoding, encoded) => {
    try {
      if (encoding.toUpperCase() === 'B') return decodeBase64(encoded, charset);
      return decodeQuotedPrintable(encoded.replace(/_/g, ' '), charset);
    } catch (err) {
      return full;
    }
  });
}

function htmlToText(html) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  doc.querySelectorAll('script, style').forEach(n => n.remove());
  const hrefEmails = Array.from(doc.querySelectorAll('[href]'))
    .map(node => node.getAttribute('href') || '')
    .filter(href => href.toLowerCase().startsWith('mailto:') || href.includes('@'));
  return [doc.body ? doc.body.innerText : html, ...hrefEmails].filter(Boolean).join('\n');
}

function splitHeaderBody(raw) {
  const split = String(raw || '').search(/\r?\n\r?\n/);
  if (split < 0) return { headerText: String(raw || ''), body: '' };
  const separator = String(raw || '').slice(split).match(/^\r?\n\r?\n/)[0];
  return {
    headerText: String(raw || '').slice(0, split),
    body: String(raw || '').slice(split + separator.length),
  };
}

function parseHeaders(raw) {
  const { headerText } = splitHeaderBody(raw);
  const unfolded = headerText.replace(/\r?\n[ \t]+/g, ' ');
  const headers = {};
  for (const line of unfolded.split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = decodeMimeWords(line.slice(idx + 1).trim());
    if (!headers[key]) headers[key] = [];
    headers[key].push(value);
  }
  return headers;
}

function getHeader(headers, key) {
  return (headers[key.toLowerCase()] || []).join(', ');
}

function firstNonEmptyHeader(headers, keys) {
  for (const key of keys) {
    const value = (headers[key.toLowerCase()] || []).find(item => String(item || '').trim());
    if (value) return value;
  }
  return '';
}

function parseHeaderParams(value) {
  const pieces = String(value || '').match(/(?:[^;"']+|"[^"]*"|'[^']*')+/g) || [];
  const type = (pieces.shift() || '').trim().toLowerCase();
  const params = {};

  for (const piece of pieces) {
    const idx = piece.indexOf('=');
    if (idx < 0) continue;
    const key = piece.slice(0, idx).trim().toLowerCase();
    const paramValue = piece.slice(idx + 1).trim().replace(/^"|"$/g, '');
    params[key] = paramValue;
  }

  return { type, params };
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function splitMultipartParts(body, boundary) {
  if (!boundary) return [];

  const parts = [];
  const marker = new RegExp(`(?:^|\\r?\\n)--${escapeRegex(boundary)}(--)?[^\\r\\n]*(?:\\r?\\n|$)`, 'g');
  let partStart = null;
  let match;

  while ((match = marker.exec(body)) !== null) {
    if (partStart !== null) {
      parts.push(body.slice(partStart, match.index));
    }

    if (match[1] === '--') {
      partStart = null;
      break;
    }

    partStart = marker.lastIndex;
  }

  return parts.filter(part => part.trim());
}

function decodeMimeBody(body, headers) {
  const contentType = parseHeaderParams(getHeader(headers, 'content-type'));
  const transferEncoding = getHeader(headers, 'content-transfer-encoding').toLowerCase();
  const charset = contentType.params.charset || 'utf-8';

  if (transferEncoding.includes('quoted-printable')) return decodeQuotedPrintable(body, charset);
  if (transferEncoding.includes('base64')) return decodeBase64(body, charset);
  return cleanEmailText(body);
}

function collectTextParts(raw, depth = 0) {
  if (depth > 12) return { textPlain: [], textHtml: [] };

  const headers = parseHeaders(raw);
  const contentType = parseHeaderParams(getHeader(headers, 'content-type'));
  const { body } = splitHeaderBody(raw);
  const textPlain = [];
  const textHtml = [];

  if (contentType.type.startsWith('multipart/')) {
    for (const part of splitMultipartParts(body, contentType.params.boundary)) {
      const child = collectTextParts(part, depth + 1);
      textPlain.push(...child.textPlain);
      textHtml.push(...child.textHtml);
    }
    return { textPlain, textHtml };
  }

  if (contentType.type === 'text/plain') {
    textPlain.push(cleanEmailText(decodeMimeBody(body, headers)));
  } else if (contentType.type === 'text/html') {
    textHtml.push(htmlToText(cleanEmailText(decodeMimeBody(body, headers))));
  }

  return { textPlain, textHtml };
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
  const rootHeaders = parseHeaders(raw);
  const { textPlain, textHtml } = collectTextParts(raw);

  if (textPlain.length) return textPlain.join('\n\n');
  if (textHtml.length) return textHtml.join('\n\n');

  const { body } = splitHeaderBody(raw);
  return body ? decodeMimeBody(body, rootHeaders) : raw;
}

function xmlToText(xml) {
  return String(xml || '')
    .replace(/<w:tab\b[^>]*\/>/g, '\t')
    .replace(/<w:br\b[^>]*\/>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}


function readUInt32LE(view, offset) {
  return view.getUint32(offset, true);
}

function readInt32LE(view, offset) {
  return view.getInt32(offset, true);
}

function isOleCompoundFile(bytes) {
  const signature = [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];
  return signature.every((value, index) => bytes[index] === value);
}

function decodeDirectoryName(bytes) {
  let name = '';
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    const code = bytes[i] | (bytes[i + 1] << 8);
    if (!code) break;
    name += String.fromCharCode(code);
  }
  return name;
}

function sectorOffset(sector, sectorSize) {
  return 512 + (sector * sectorSize);
}

function readSectorChain(bytes, view, fat, startSector, sectorSize, maxBytes = Infinity) {
  if (startSector < 0) return new Uint8Array();
  const chunks = [];
  const seen = new Set();
  let sector = startSector;
  let total = 0;

  while (sector >= 0 && sector < fat.length && !seen.has(sector)) {
    seen.add(sector);
    const offset = sectorOffset(sector, sectorSize);
    if (offset < 0 || offset >= bytes.length) break;
    const remaining = Math.max(0, Math.min(sectorSize, bytes.length - offset, maxBytes - total));
    if (!remaining) break;
    chunks.push(bytes.slice(offset, offset + remaining));
    total += remaining;
    if (total >= maxBytes) break;
    const next = fat[sector];
    if (next === -2 || next === -1 || next === -3 || next === -4) break;
    sector = next;
  }

  const out = new Uint8Array(total);
  let cursor = 0;
  for (const chunk of chunks) {
    out.set(chunk, cursor);
    cursor += chunk.length;
  }
  return out;
}

function parseOleDirectoryStreams(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  if (bytes.length < 512 || !isOleCompoundFile(bytes)) {
    throw new Error('Legacy .doc file is not a valid Word binary document. Save it as .docx, .txt, or .html and try again.');
  }

  const view = new DataView(arrayBuffer);
  const sectorShift = view.getUint16(0x1e, true);
  const sectorSize = 1 << sectorShift;
  const fatSectorCount = readUInt32LE(view, 0x2c);
  const directoryStartSector = readInt32LE(view, 0x30);
  const miniCutoff = readUInt32LE(view, 0x38) || 4096;
  const difat = [];

  for (let offset = 0x4c; offset < 0x4c + 109 * 4; offset += 4) {
    const sector = readInt32LE(view, offset);
    if (sector >= 0) difat.push(sector);
  }

  const fat = [];
  for (const fatSector of difat.slice(0, fatSectorCount || difat.length)) {
    const offset = sectorOffset(fatSector, sectorSize);
    if (offset < 0 || offset + 4 > bytes.length) continue;
    for (let pos = offset; pos + 4 <= Math.min(offset + sectorSize, bytes.length); pos += 4) {
      fat.push(readInt32LE(view, pos));
    }
  }

  const directoryBytes = readSectorChain(bytes, view, fat, directoryStartSector, sectorSize);
  const entries = [];
  for (let offset = 0; offset + 128 <= directoryBytes.length; offset += 128) {
    const entry = directoryBytes.slice(offset, offset + 128);
    const nameLength = Math.max(0, (entry[0x40] | (entry[0x41] << 8)) - 2);
    const name = decodeDirectoryName(entry.slice(0, Math.min(nameLength, 64)));
    const type = entry[0x42];
    const startSector = readInt32LE(new DataView(entry.buffer, entry.byteOffset, entry.byteLength), 0x74);
    const size = readUInt32LE(new DataView(entry.buffer, entry.byteOffset, entry.byteLength), 0x78);
    if (name && (type === 2 || type === 5)) entries.push({ name, type, startSector, size });
  }

  const streams = [];
  for (const entry of entries) {
    if (entry.type !== 2) continue;
    if (entry.size > 0 && entry.size < miniCutoff) continue;
    const data = readSectorChain(bytes, view, fat, entry.startSector, sectorSize, entry.size || Infinity);
    if (data.length) streams.push({ name: entry.name, data });
  }
  return streams;
}

function extractAsciiStrings(bytes) {
  const strings = [];
  let current = '';
  const flush = () => {
    const cleaned = current.replace(/[ \t]{2,}/g, ' ').trim();
    if (cleaned.length >= 4) strings.push(cleaned);
    current = '';
  };

  for (const byte of bytes) {
    if (byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte <= 126) || byte >= 160) {
      current += String.fromCharCode(byte);
      if (current.length >= 2000) flush();
    } else {
      flush();
    }
  }
  flush();
  return strings;
}

function extractUtf16LeStrings(bytes) {
  const strings = [];
  let current = '';
  const flush = () => {
    const cleaned = current.replace(/[ \t]{2,}/g, ' ').trim();
    if (cleaned.length >= 4) strings.push(cleaned);
    current = '';
  };

  for (let i = 0; i + 1 < bytes.length; i += 2) {
    const code = bytes[i] | (bytes[i + 1] << 8);
    if (code === 9 || code === 10 || code === 13 || (code >= 32 && code <= 0xd7ff) || (code >= 0xe000 && code <= 0xfffd)) {
      current += String.fromCharCode(code);
      if (current.length >= 2000) flush();
    } else {
      flush();
    }
  }
  flush();
  return strings;
}

function extractLegacyDocText(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  let streams = [];
  try {
    streams = parseOleDirectoryStreams(arrayBuffer);
  } catch (error) {
    throw error;
  }

  const preferredNames = ['WordDocument', '1Table', '0Table', 'Data', '\u0005SummaryInformation', '\u0005DocumentSummaryInformation'];
  const selectedStreams = streams.filter(stream => preferredNames.includes(stream.name));
  const sourceStreams = selectedStreams.length ? selectedStreams : streams;
  const parts = [];

  for (const stream of sourceStreams) {
    for (const item of extractUtf16LeStrings(stream.data)) parts.push(item);
    for (const item of extractAsciiStrings(stream.data)) parts.push(item);
  }

  // Fallback scan across the whole file. This improves detection where a document stores
  // useful strings in a small stream that the static parser cannot safely reconstruct.
  for (const item of extractUtf16LeStrings(bytes)) parts.push(item);
  for (const item of extractAsciiStrings(bytes)) parts.push(item);

  const unique = [];
  const seen = new Set();
  for (const part of parts.map(cleanExtractedString).filter(Boolean)) {
    const normalised = part.slice(0, 500);
    if (!seen.has(normalised)) {
      seen.add(normalised);
      unique.push(normalised);
    }
  }

  if (!unique.length) {
    throw new Error('No readable text could be extracted from this .doc file. Save it as .docx, .txt, or .html and try again.');
  }

  return unique.join('\n');
}

async function extractDocxText(arrayBuffer) {
  const zip = await JSZip.loadAsync(arrayBuffer);
  const documentXml = zip.file('word/document.xml');
  if (!documentXml) throw new Error('Word document is missing word/document.xml.');

  const parts = [xmlToText(await documentXml.async('string'))];
  const rels = zip.file('word/_rels/document.xml.rels');

  if (rels) {
    const relXml = await rels.async('string');
    const urls = Array.from(relXml.matchAll(/Target="([^"]+)"/g))
      .map(match => match[1])
      .filter(target => target.includes('@') || target.toLowerCase().startsWith('mailto:'));
    parts.push(...urls);
  }

  return parts.filter(Boolean).join('\n');
}


function isLikelyBinaryNoise(value) {
  const text = String(value || '');
  if (!text) return false;
  const sample = text.slice(0, 6000);
  if (/(Root Entry|__substg|__recip_version|__properties_version|__nameid_version)/i.test(sample)) return true;
  const controls = (sample.match(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g) || []).length;
  if (controls > Math.max(12, sample.length * 0.015)) return true;
  const readable = (sample.match(/[A-Za-z0-9 .,;:'"!?@()\[\]\-_/\r\n]/g) || []).length;
  return sample.length > 80 && readable / sample.length < 0.72;
}

function cleanMsgTextField(value) {
  const cleaned = cleanExtractedString(value);
  if (!cleaned || isLikelyBinaryNoise(cleaned)) return '';
  return cleaned;
}

function extractFallbackEmailsFromMsgBytes(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const parts = [];
  for (const item of extractUtf16LeStrings(bytes)) parts.push(item);
  for (const item of extractAsciiStrings(bytes)) parts.push(item);
  const seen = new Set();
  const emails = [];
  for (const part of parts) {
    for (const email of extractEmailMatches(part)) {
      if (!seen.has(email)) {
        seen.add(email);
        emails.push(email);
      }
    }
  }
  return emails;
}

function headersFromMsgData(fileData) {
  if (fileData.headers) return parseHeaders(fileData.headers);

  const headers = {};
  const add = (key, value) => {
    if (!value) return;
    headers[key] = [cleanExtractedString(value)];
  };

  add('subject', fileData.subject);
  add('from', [fileData.senderName, fileData.senderEmail].filter(Boolean).join(' <') + (fileData.senderEmail ? '>' : ''));
  if (fileData.recipients && fileData.recipients.length) {
    headers.to = [fileData.recipients.map(formatMsgAddress).filter(Boolean).join(', ')];
  }

  return headers;
}

function formatMsgAddress(address) {
  if (!address) return '';
  const name = cleanExtractedString(address.name);
  const email = cleanExtractedString(address.email);
  if (name && email) return `${name} <${email}>`;
  return email || name || '';
}

function extractMsgData(arrayBuffer) {
  if (!window.MSGReader) {
    throw new Error('Outlook .msg support did not load. Refresh the page and try again.');
  }

  const reader = new window.MSGReader(arrayBuffer);
  const fileData = reader.getFileData();
  if (fileData.error) throw new Error(fileData.error);

  const headers = headersFromMsgData(fileData);
  const recipients = '';
  const plainBody = cleanMsgTextField(fileData.body);
  const htmlBody = cleanMsgTextField(fileData.bodyHTML ? htmlToText(fileData.bodyHTML) : '');
  const body = plainBody || htmlBody;
  const attachments = (fileData.attachments || [])
    .map(item => item.fileName || item.fileNameShort)
    .filter(Boolean)
    .map(name => `Attachment: ${name}`)
    .join('\n');

  let fallbackEmails = '';
  if (!recipients && !body) {
    const emails = extractFallbackEmailsFromMsgBytes(arrayBuffer);
    if (emails.length) fallbackEmails = `Email addresses found in MSG file:\n${emails.join('\n')}`;
  }

  const text = [cleanMsgTextField(fileData.subject), recipients, body, attachments, fallbackEmails]
    .filter(Boolean)
    .join('\n\n');

  if (!text) {
    throw new Error('No readable message text could be extracted from this .msg file. The file may be encrypted, corrupted, or an unsupported Outlook variant.');
  }

  if (isLikelyBinaryNoise(text)) {
    throw new Error('The MSG parser returned binary storage data instead of readable email text, so this file was skipped rather than exported as gibberish.');
  }

  return { headers, text };
}

async function extractTextFromFile(name, raw, arrayBuffer = null) {
  const fileType = assertSupportedFile(name);
  if (isBinarySupportedType(fileType)) {
    if (!arrayBuffer) throw new Error(`${name} needs binary reading but no data was provided.`);
    if (fileType === 'docx') return extractDocxText(arrayBuffer);
    if (fileType === 'doc') return extractLegacyDocText(arrayBuffer);
    if (fileType === 'msg') return extractMsgData(arrayBuffer).text;
  }

  assertLooksLikeText(raw, name);
  const cleanedRaw = cleanEmailText(decodeMimeWords(raw));
  if (fileType === 'html' || fileType === 'htm') return htmlToText(cleanedRaw);
  if (fileType === 'eml') return findMultipartBody(raw);
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

async function readFileAsArrayBuffer(file) {
  return await file.arrayBuffer();
}

async function handleFiles(files) {
  state.documents = [];
  state.emailMap = new Map();
  state.loadErrors = [];
  state.ignoredFiles = [];
  setStatus('Reading files...');

  const fileList = Array.from(files || []);
  for (let fileIndex = 0; fileIndex < fileList.length; fileIndex += 1) {
    const file = fileList[fileIndex];
    if (isIgnorableFileName(file.name)) {
      state.ignoredFiles.push(file.name);
      continue;
    }

    if (fileIndex > 0 && fileIndex % 10 === 0) {
      setStatus(`Reading file ${fileIndex + 1} of ${fileList.length}...`);
      await waitForUi();
    }
    try {
      const fileType = assertSupportedFile(file.name);
      let raw = '';
      let arrayBuffer = null;
      let headers = {};
      let text = '';

      if (isBinarySupportedType(fileType)) {
        arrayBuffer = await readFileAsArrayBuffer(file);
        if (fileType === 'msg') {
          const msgData = extractMsgData(arrayBuffer);
          headers = msgData.headers;
          text = msgData.text;
        } else {
          text = await extractTextFromFile(file.name, raw, arrayBuffer);
        }
      } else {
        raw = await readFileAsText(file);
        assertLooksLikeText(raw, file.name);
        headers = fileType === 'eml' ? parseHeaders(raw) : {};
        text = await extractTextFromFile(file.name, raw);
      }

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
    } catch (error) {
      console.error(error);
      state.loadErrors.push({ file: file.name, message: error.message || 'Unknown parsing error.' });
    }
  }

  renderSummary();
  renderEmailTable();
  const ignoredText = state.ignoredFiles.length ? ` Ignored ${state.ignoredFiles.length} temporary/system file(s).` : '';
  if (state.loadErrors.length && !state.documents.length) {
    setStatus(`No files could be loaded. ${state.loadErrors[0].file}: ${state.loadErrors[0].message}${ignoredText}`, 'error');
  } else if (state.loadErrors.length) {
    setStatus(`Loaded ${state.documents.length} file(s), skipped ${state.loadErrors.length}. Found ${state.emailMap.size} unique email address(es).${ignoredText}`, 'warning');
  } else {
    setStatus(`Loaded ${state.documents.length} file(s). Found ${state.emailMap.size} unique email address(es).${ignoredText}`, 'success');
  }
}

function renderSummary() {
  const errorList = state.loadErrors.length
    ? `<ul class="error-list">${state.loadErrors.map(error => `<li><strong>${escapeHtml(error.file)}</strong>: ${escapeHtml(error.message)}</li>`).join('')}</ul>`
    : '';
  const ignoredText = state.ignoredFiles.length
    ? ` <strong>${state.ignoredFiles.length}</strong> temporary/system file(s) ignored.`
    : '';

  if (!state.documents.length) {
    els.fileSummary.innerHTML = state.loadErrors.length
      ? `<strong>${state.loadErrors.length}</strong> file(s) could not be loaded.${ignoredText}${errorList}`
      : ignoredText;
    return;
  }
  const errorText = state.loadErrors.length
    ? ` <strong>${state.loadErrors.length}</strong> file(s) skipped.`
    : '';
  els.fileSummary.innerHTML = `<strong>${state.documents.length}</strong> file(s) loaded. <strong>${state.emailMap.size}</strong> unique email address(es) found.${errorText}${ignoredText}${errorList}`;
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
    const subject = firstNonEmptyHeader(doc.headers, ['subject', 'thread-topic']);
    const date = getHeader(doc.headers, 'date');
    const from = getHeader(doc.headers, 'from');
    parts.push(doc.name);
    if (subject) parts.push(`Subject: ${subject}`);
    if (date) parts.push(`Date: ${date}`);
    if (from) parts.push(formatMetadataHeader('From', from, selectedEmails, replacement, preserveLayout, safetyNet));
    // Recipient headers are deliberately omitted from exported PDFs/text output.
    // Large To/Cc/Bcc lists create pages of redacted or blank recipient metadata
    // and are not useful in the redacted document copy. Recipient addresses are
    // still detected and shown in the selection/audit UI before export.
    parts.push('');
  }
  parts.push(redactText(doc.text, selectedEmails, replacement, preserveLayout, safetyNet));
  return parts.join('\n');
}

function shouldRemoveEmail(email, selectedEmails, safetyNet) {
  return safetyNet || selectedEmails.has(normaliseEmail(email));
}

function removeEmailsFromRecipientHeader(value, selectedEmails, safetyNet) {
  let output = cleanEmailText(value || '');

  output = output.replace(/([^,;\n<>]*?)\s*<([^<>\s@]+@[^<>\s@]+\.[^<>\s@]+)>/g, (full, displayName, email) => {
    if (!shouldRemoveEmail(email, selectedEmails, safetyNet)) return full;
    const cleanedName = cleanEmailText(displayName).replace(/[\s,;]+$/g, '').trim();
    return cleanedName;
  });

  output = output.replace(/mailto:([^\s,;<>]+@[^\s,;<>]+\.[^\s,;<>]+)/gi, (full, email) => {
    return shouldRemoveEmail(email, selectedEmails, safetyNet) ? '' : full;
  });

  output = output.replace(EMAIL_REGEX, (full, captured) => {
    const email = captured || full;
    return shouldRemoveEmail(email, selectedEmails, safetyNet) ? '' : full;
  });

  output = output
    .replace(/<\s*>/g, '')
    .replace(/\(\s*\)/g, '')
    .replace(/\[\s*\]/g, '')
    .replace(/\s*[,;]\s*[,;]+/g, ', ')
    .replace(/^[\s,;]+|[\s,;]+$/g, '')
    .replace(/\s{2,}/g, ' ');

  return output;
}

function formatRecipientMetadataHeader(label, value, selectedEmails, safetyNet) {
  const cleaned = removeEmailsFromRecipientHeader(value, selectedEmails, safetyNet);
  if (!cleaned) return `${label}:`;
  if (cleaned.length <= MAX_METADATA_FIELD_CHARS) return `${label}: ${cleaned}`;

  const addressCount = extractEmailMatches(value).length;
  const preview = cleaned.slice(0, MAX_METADATA_FIELD_CHARS).replace(/\s+$/g, '');
  const suffix = addressCount
    ? ` ... [${addressCount} address(es) removed from ${label}; metadata shortened for stable PDF export]`
    : ' ... [metadata shortened for stable PDF export]';
  return `${label}: ${preview}${suffix}`;
}

function formatMetadataHeader(label, value, selectedEmails, replacement, preserveLayout, safetyNet) {
  const redacted = redactText(value, selectedEmails, replacement, preserveLayout, safetyNet);
  if (redacted.length <= MAX_METADATA_FIELD_CHARS) return `${label}: ${redacted}`;

  const addressCount = extractEmailMatches(value).length;
  const preview = redacted.slice(0, MAX_METADATA_FIELD_CHARS).replace(/\s+$/g, '');
  const suffix = addressCount
    ? ` ... [${addressCount} address(es) in ${label}; metadata shortened for stable PDF export]`
    : ' ... [metadata shortened for stable PDF export]';
  return `${label}: ${preview}${suffix}`;
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
    const line = makePdfSafeText(rawLine) || ' ';
    const chunks = [];
    for (let i = 0; i < line.length; i += maxChars) chunks.push(line.slice(i, i + maxChars));
    if (!chunks.length) chunks.push(' ');
    for (const chunk of chunks) {
      if (y < margin) newPage();
      page.drawText(chunk, { x: margin, y, size: fontSize, font });
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
        try {
          const text = buildOutputText(doc, selectedEmails, replacement, preserveLayout, safetyNet, includeMetadata);
          zip.file(`${safeBaseName(doc.name)}_redacted.txt`, text);
        } catch (error) {
          throw new Error(`${doc.name}: ${error.message}`);
        }
      }
      downloadBlob(await zip.generateAsync({ type: 'blob' }), 'redacted_text_files.zip');
    } else if (exportMode === 'zip') {
      const zip = new JSZip();
      for (const doc of state.documents) {
        try {
          const text = buildOutputText(doc, selectedEmails, replacement, preserveLayout, safetyNet, includeMetadata);
          const pdfBytes = await createPdfBytes(`${doc.name}`, text);
          zip.file(`${safeBaseName(doc.name)}_redacted.pdf`, pdfBytes);
        } catch (error) {
          throw new Error(`${doc.name}: ${error.message}`);
        }
      }
      zip.file('redaction_audit.csv', buildAuditCsv(selectedEmails));
      downloadBlob(await zip.generateAsync({ type: 'blob' }), 'redacted_pdfs.zip');
    } else {
      const { PDFDocument } = PDFLib;
      const combined = await PDFDocument.create();
      for (const doc of state.documents) {
        try {
          const text = buildOutputText(doc, selectedEmails, replacement, preserveLayout, safetyNet, includeMetadata);
          const pdfBytes = await createPdfBytes(`${doc.name}`, text);
          const src = await PDFDocument.load(pdfBytes);
          const pages = await combined.copyPages(src, src.getPageIndices());
          pages.forEach(p => combined.addPage(p));
        } catch (error) {
          throw new Error(`${doc.name}: ${error.message}`);
        }
      }
      const combinedBytes = await combined.save();
      downloadBlob(new Blob([combinedBytes], { type: 'application/pdf' }), 'combined_redacted_documents.pdf');
    }
    setStatus('Export generated successfully.', 'success');
  } catch (error) {
    console.error(error);
    setStatus(`Export failed. ${error.message || 'Try TXT export or remove the problem file.'}`, 'error');
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
  state.loadErrors = [];
  els.fileInput.value = '';
  renderSummary();
  renderEmailTable();
  setStatus('Cleared.');
});
