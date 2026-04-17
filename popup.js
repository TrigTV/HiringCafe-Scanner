'use strict';

// ── Resume state ───────────────────────────────────────────────────────────
// Keywords are cached in chrome.storage.local (keyword arrays only — no file).
// The original file bytes are never stored anywhere.
let resumeKeywords = null;
let resumeFileName = '';

const RESUME_CACHE_KEY = 'hcrs_resume_cache';

// ── DOM refs ──────────────────────────────────────────────────────────────
const uploadSection    = document.getElementById('upload-section');
const resumeLoadedSec  = document.getElementById('resume-loaded');
const scanControls     = document.getElementById('scan-controls');
const parsingProgress  = document.getElementById('parsing-progress');
const resultsSection   = document.getElementById('results-section');
const dropZone         = document.getElementById('drop-zone');
const fileInput        = document.getElementById('resume-file');
const browseBtn        = document.getElementById('browse-btn');
const clearResumeBtn   = document.getElementById('clear-resume-btn');
const scanBtn          = document.getElementById('scan-btn');
const clearBtn         = document.getElementById('clear-btn');
const resumeNameEl     = document.getElementById('resume-name');
const resumeSkillsEl   = document.getElementById('resume-skills-count');
const skillsPreviewEl  = document.getElementById('skills-preview');
const progressFill     = document.getElementById('progress-fill');
const progressText     = document.getElementById('progress-text');

// ── ML DOM refs ────────────────────────────────────────────────────────────
const mlSection        = document.getElementById('ml-section');
const mlStatusBadge    = document.getElementById('ml-status-badge');
const mlAppsCount      = document.getElementById('ml-apps-count');
const mlTrainFill      = document.getElementById('ml-train-fill');
const mlTrainLabel     = document.getElementById('ml-train-label');
const mlPrefs          = document.getElementById('ml-prefs');
const mlResetBtn       = document.getElementById('ml-reset-btn');
const mlScoreNote      = document.getElementById('ml-score-note');

// ── Resume cache: save ────────────────────────────────────────────────────
function saveResumeCache() {
  if (!resumeKeywords) return;
  chrome.storage.local.set({
    [RESUME_CACHE_KEY]: {
      fileName: resumeFileName,
      tech:     [...resumeKeywords.tech],
      general:  [...resumeKeywords.general],
      savedAt:  Date.now(),
    }
  });
}

// ── Resume cache: clear ───────────────────────────────────────────────────
function clearResumeCache() {
  chrome.storage.local.remove(RESUME_CACHE_KEY);
}

// ── Resume cache: restore from storage ───────────────────────────────────
function restoreFromCache(cached) {
  resumeFileName = cached.fileName || 'cached-resume';
  resumeKeywords = {
    tech:    new Set(cached.tech    || []),
    general: new Set(cached.general || []),
  };
  showResumeLoaded(true);
}

// ── On popup open: restore resume cache + ML stats ────────────────────────
(async () => {
  // 1. Restore resume from cache
  chrome.storage.local.get([RESUME_CACHE_KEY], (r) => {
    if (r[RESUME_CACHE_KEY]) restoreFromCache(r[RESUME_CACHE_KEY]);
  });

  // 2. Load ML stats
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
      const stats = await chrome.tabs.sendMessage(tab.id, { type: 'GET_ML_STATS' }).catch(() => null);
      if (stats) renderMLPanel(stats);
    }
  } catch (_) {
    chrome.storage.local.get(['hcrs_ml_model'], (r) => {
      if (r.hcrs_ml_model) renderMLPanel(r.hcrs_ml_model);
    });
  }
})();

// ── ML: listen for real-time model updates from content script ────────────
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'ML_MODEL_UPDATED') {
    renderMLPanel({ count: msg.count, topWords: msg.topWords });
    // Pulse the ML section to indicate learning happened
    mlSection.style.transition = 'background 0.3s';
    mlSection.style.background = 'linear-gradient(135deg, #e0e7ff 0%, #dbeafe 100%)';
    setTimeout(() => {
      mlSection.style.background = '';
    }, 600);
  }
});

// ── ML: reset button ──────────────────────────────────────────────────────
mlResetBtn.addEventListener('click', async () => {
  if (!confirm('Reset all learned preferences? This cannot be undone.')) return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) await chrome.tabs.sendMessage(tab.id, { type: 'RESET_ML' }).catch(() => {});
  } catch (_) {}
  // Also clear directly in case content script isn't loaded
  chrome.storage.local.remove('hcrs_ml_model');
  renderMLPanel({ count: 0, topWords: [] });
});

// ── ML: render panel ──────────────────────────────────────────────────────
function renderMLPanel(model) {
  const count = model.count || 0;

  if (count === 0) {
    // Show collapsed state (greyed out hint) only if there's at least a resume loaded
    // Otherwise hide it entirely
    mlSection.classList.remove('hidden');
    mlStatusBadge.textContent = 'Learning';
    mlStatusBadge.classList.remove('active');
    mlAppsCount.textContent = 'Apply to jobs to train preferences';
    mlTrainFill.style.width = '0%';
    mlTrainLabel.textContent = '0 / 10 to full influence';
    mlPrefs.innerHTML = '<span class="ml-prefs-empty">Click "Mark Applied" on any job to start learning</span>';
    mlScoreNote?.classList.add('hidden');
    return;
  }

  mlSection.classList.remove('hidden');

  // Status badge
  const pct = Math.min(100, (count / 10) * 100);
  if (count >= 10) {
    mlStatusBadge.textContent = 'Active (40%)';
    mlStatusBadge.classList.add('active');
  } else {
    const influence = Math.round(count * 4);
    mlStatusBadge.textContent = `Learning (${influence}%)`;
    mlStatusBadge.classList.remove('active');
  }

  mlAppsCount.textContent = `${count} application${count === 1 ? '' : 's'} learned`;
  mlTrainFill.style.width = pct + '%';
  mlTrainLabel.textContent = count >= 10
    ? 'Full influence reached'
    : `${count} / 10 to full influence`;

  // Preference tags
  mlPrefs.innerHTML = '';
  const words = (model.topWords || []).slice(0, 16);
  if (words.length === 0) {
    mlPrefs.innerHTML = '<span class="ml-prefs-empty">Building preferences…</span>';
  } else {
    for (const w of words) {
      const tag = document.createElement('span');
      tag.className = 'ml-pref-tag';
      tag.textContent = w;
      mlPrefs.appendChild(tag);
    }
  }

  mlScoreNote?.classList.remove('hidden');
}

// ── File handling ─────────────────────────────────────────────────────────
browseBtn.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('click', (e) => { if (e.target !== browseBtn) fileInput.click(); });

dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('drag-over');
});
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file) handleFile(file);
});

fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) handleFile(fileInput.files[0]);
});

clearResumeBtn.addEventListener('click', () => {
  resumeKeywords = null;
  resumeFileName = '';
  fileInput.value = '';
  clearResumeCache();
  uploadSection.classList.remove('hidden');
  resumeLoadedSec.classList.add('hidden');
  scanControls.classList.add('hidden');
  resultsSection.classList.add('hidden');
  sendToContent({ type: 'CLEAR_HIGHLIGHTS' });
});

scanBtn.addEventListener('click', runScan);
clearBtn.addEventListener('click', () => {
  resultsSection.classList.add('hidden');
  sendToContent({ type: 'CLEAR_HIGHLIGHTS' });
});

// ── File reading & parsing ────────────────────────────────────────────────
async function handleFile(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  if (!['pdf', 'docx', 'txt'].includes(ext)) {
    alert('Please upload a PDF, DOCX, or TXT file.');
    return;
  }

  resumeFileName = file.name;
  showProgress('Reading file...', 10);

  try {
    const buffer = await file.arrayBuffer();
    let text = '';

    showProgress('Extracting text...', 30);

    if (ext === 'txt') {
      text = new TextDecoder().decode(buffer);
    } else if (ext === 'pdf') {
      text = await extractTextFromPDF(buffer);
    } else if (ext === 'docx') {
      text = await extractTextFromDOCX(buffer);
    }

    showProgress('Analyzing keywords...', 70);

    if (!text || text.trim().length < 50) {
      hideProgress();
      alert('Could not extract enough text from this file.\n\n' +
        'Try: saving as TXT from your word processor, or using a non-scanned PDF.');
      return;
    }

    resumeKeywords = extractKeywords(text);
    saveResumeCache();
    showProgress('Done!', 100);

    setTimeout(() => {
      hideProgress();
      showResumeLoaded(false);
    }, 400);

  } catch (err) {
    hideProgress();
    console.error('Resume parse error:', err);
    alert('Error reading file: ' + err.message);
  }
}

// ── PDF Text Extraction (pure JS, no libraries) ───────────────────────────
async function extractTextFromPDF(buffer) {
  const bytes = new Uint8Array(buffer);
  // Convert to latin-1 string preserving byte values
  let raw = '';
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    raw += String.fromCharCode(...chunk);
  }

  const parts = [];

  // Extract from FlateDecode streams (compressed text streams)
  const streamPattern = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let streamMatch;
  while ((streamMatch = streamPattern.exec(raw)) !== null) {
    const streamData = streamMatch[1];
    const decompressed = await tryInflatePDFStream(streamData);
    if (decompressed) {
      // Successfully decompressed — use the decompressed content only
      parts.push(...extractPDFTextOps(decompressed));
    } else {
      // Not compressed (or decompression failed) — try as raw text ops
      parts.push(...extractPDFTextOps(streamData));
    }
  }

  // Fallback: try direct BT/ET extraction from uncompressed sections
  if (parts.join('').replace(/\s/g, '').length < 100) {
    const btEt = /BT\s*([\s\S]*?)\s*ET/g;
    let m;
    while ((m = btEt.exec(raw)) !== null) {
      parts.push(...extractPDFTextOps(m[1]));
    }
  }

  // Last resort: extract readable ASCII words
  if (parts.join('').replace(/\s/g, '').length < 100) {
    const words = raw.match(/[A-Za-z][A-Za-z0-9+#.\-@]{2,}/g) || [];
    return words.join(' ');
  }

  return parts.join(' ');
}

async function tryInflatePDFStream(streamData) {
  // Skip streams that are clearly too short or obviously not compressed
  if (streamData.length < 4) return null;

  const asBytes = new Uint8Array(streamData.length);
  for (let i = 0; i < streamData.length; i++) {
    asBytes[i] = streamData.charCodeAt(i) & 0xff;
  }

  const inflateWith = async (format) => {
    const ds = new DecompressionStream(format);
    const writer = ds.writable.getWriter();
    const reader = ds.readable.getReader();

    // Write and close must be fire-and-forget so the reader can drain
    // concurrently — awaiting write before reading causes a deadlock on
    // large streams where the internal buffer fills up.
    writer.write(asBytes).then(() => writer.close()).catch(() => writer.abort());

    const chunks = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let pos = 0;
    for (const c of chunks) { out.set(c, pos); pos += c.length; }
    const text = new TextDecoder('latin1', { fatal: false }).decode(out);
    // Sanity check: decompressed output should contain readable ASCII
    if (text.length < 10) throw new Error('decompressed output too short');
    return text;
  };

  try {
    return await inflateWith('deflate-raw');
  } catch (_) {
    try {
      return await inflateWith('deflate');
    } catch (_) {
      return null;
    }
  }
}

function extractPDFTextOps(block) {
  const parts = [];

  // (text) Tj  or  (text) '  operators
  const tjRe = /\(([^)\\]*(?:\\.[^)\\]*)*)\)\s*(?:Tj|'|")/g;
  let m;
  while ((m = tjRe.exec(block)) !== null) {
    parts.push(decodePDFString(m[1]));
  }

  // [(text) num ...] TJ  operator
  const tjArrayRe = /\[([^\]]*)\]\s*TJ/g;
  while ((m = tjArrayRe.exec(block)) !== null) {
    const inner = m[1];
    const strRe = /\(([^)\\]*(?:\\.[^)\\]*)*)\)/g;
    let sm;
    while ((sm = strRe.exec(inner)) !== null) {
      parts.push(decodePDFString(sm[1]));
    }
  }

  return parts;
}

function decodePDFString(str) {
  return str
    .replace(/\\(\d{3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)))
    .replace(/\\n/g, ' ').replace(/\\r/g, ' ').replace(/\\t/g, ' ')
    .replace(/\\\\/g, '\\').replace(/\\\(/g, '(').replace(/\\\)/g, ')');
}

// ── DOCX Text Extraction (ZIP + XML, no libraries) ────────────────────────
async function extractTextFromDOCX(buffer) {
  const bytes = new Uint8Array(buffer);
  const view  = new DataView(buffer);

  // Walk ZIP local file headers: signature PK\x03\x04 = 0x504B0304
  let offset = 0;
  while (offset < bytes.length - 30) {
    if (view.getUint32(offset, false) !== 0x504B0304) {
      offset++;
      continue;
    }

    const compression   = view.getUint16(offset + 8,  true);
    const compressedSz  = view.getUint32(offset + 18, true);
    const fileNameLen   = view.getUint16(offset + 26, true);
    const extraLen      = view.getUint16(offset + 28, true);
    const fileName      = new TextDecoder().decode(bytes.slice(offset + 30, offset + 30 + fileNameLen));
    const dataStart     = offset + 30 + fileNameLen + extraLen;

    if (fileName === 'word/document.xml' || fileName === 'word/document2.xml') {
      const compressed = bytes.slice(dataStart, dataStart + compressedSz);
      let xmlBytes;

      if (compression === 0) {
        xmlBytes = compressed;
      } else if (compression === 8) {
        // DEFLATE (raw)
        xmlBytes = await inflate(compressed);
      } else {
        offset = dataStart + compressedSz;
        continue;
      }

      const xml = new TextDecoder('utf-8', { fatal: false }).decode(xmlBytes);
      // Strip XML tags, decode entities, collapse whitespace
      return xml
        .replace(/<w:p[ >]/g, '\n<')
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n))
        .replace(/[ \t]+/g, ' ')
        .trim();
    }

    offset = dataStart + compressedSz;
  }

  return '';
}

async function inflate(data) {
  const ds     = new DecompressionStream('deflate-raw');
  const writer = ds.writable.getWriter();
  const reader = ds.readable.getReader();
  writer.write(data);
  writer.close();
  const chunks = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let pos = 0;
  for (const c of chunks) { out.set(c, pos); pos += c.length; }
  return out;
}

// ── Keyword Extraction ────────────────────────────────────────────────────
function extractKeywords(text) {
  const normalized = text.toLowerCase()
    .replace(/[^a-z0-9+#.\-\s]/g, ' ')
    .replace(/\s+/g, ' ');

  // Known tech skills dictionary (weighted higher during scoring)
  const TECH_SKILLS = new Set([
    // Languages
    'python','javascript','typescript','java','c++','c#','c','go','golang',
    'rust','ruby','php','swift','kotlin','scala','r','matlab','perl','bash',
    'powershell','sql','html','css','sass','less',
    // Frameworks / libs
    'react','angular','vue','svelte','nextjs','nuxtjs','express','fastapi',
    'django','flask','spring','rails','laravel','asp.net','dotnet','.net',
    'nodejs','node.js','deno','pytorch','tensorflow','keras','sklearn',
    'scikit-learn','pandas','numpy','scipy','matplotlib','seaborn','plotly',
    // Cloud / DevOps
    'aws','azure','gcp','docker','kubernetes','k8s','terraform','ansible',
    'jenkins','github actions','circleci','gitlab','ci/cd','devops','helm',
    'prometheus','grafana','datadog','splunk','elasticsearch','kibana','logstash',
    // Databases
    'mysql','postgresql','postgres','sqlite','mongodb','redis','cassandra',
    'dynamodb','firestore','neo4j','oracle','mssql','snowflake','bigquery',
    'redshift','clickhouse','kafka','rabbitmq','celery','airflow',
    // Concepts
    'machine learning','deep learning','nlp','computer vision','data science',
    'data engineering','mlops','rest','graphql','grpc','microservices',
    'api','oauth','jwt','agile','scrum','tdd','bdd','oop','functional',
    'distributed','blockchain','embedded','iot','robotics',
    // Tools
    'git','github','gitlab','bitbucket','jira','confluence','figma','sketch',
    'postman','swagger','vscode','intellij','vim','linux','unix','windows',
    'excel','tableau','powerbi','looker',
    // Roles
    'full stack','frontend','backend','fullstack','mobile','ios','android',
    'devops','sre','data scientist','ml engineer','software engineer',
    'product manager','ux','ui designer',
  ]);

  const STOP_WORDS = new Set([
    'the','and','for','are','but','not','you','all','can','had','her','was',
    'one','our','out','day','get','has','him','his','how','its','now','old',
    'see','two','who','did','let','put','say','she','too','use','may','have',
    'with','this','that','from','they','will','been','more','also','into',
    'than','then','when','your','some','what','time','each','make','like',
    'just','know','take','year','good','come','over','think','also','back',
    'after','could','these','those','which','there','about','would','other',
    'their','only','first','well','very','even','same','much','must','most',
    'any','way','long','down','work','part','need','life','both','here','high',
    'next','only','open','own','same','turn','such','give','most','tell',
    'does','end','put','why','ask','men','too','old','new','want','used',
    'show','every','good','able','age','act','add','ago','aid','aim','air',
    'per','via','etc','role','team','years','experience','required','preferred',
    'ability','strong','excellent','knowledge','skills','working','related',
    'including','minimum','plus','great','bonus','opportunity','position',
    'company','job','responsibilities','requirements','qualifications','looking',
    'seeking','join','help','drive','build','design','develop','manage',
    'ensure','support','create','implement','maintain','provide',
  ]);

  const SKILL_ALIASES = {
    'node.js': 'nodejs',
    'asp.net': 'dotnet',
    '.net': 'dotnet',
    'golang': 'go',
    'postgresql': 'postgres',
    'k8s': 'kubernetes',
    'scikit-learn': 'sklearn',
    'github actions': 'github',
    'power bi': 'powerbi',
  };

  const escapeRegExp = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const canonicalizeSkill = (skill) => SKILL_ALIASES[skill] || skill;

  const keywords = { tech: new Set(), general: new Set() };
  const words = normalized.split(/\s+/);

  // Single-word matches
  for (const word of words) {
    const clean = word.replace(/^[-+.]+|[-+.]+$/g, '');
    if (clean.length < 2 || STOP_WORDS.has(clean)) continue;
    if (TECH_SKILLS.has(clean)) {
      keywords.tech.add(canonicalizeSkill(clean));
    } else if (clean.length >= 3 && /^[a-z0-9+#.-]+$/.test(clean)) {
      keywords.general.add(clean);
    }
  }

  // Multi-word tech skills
  for (const skill of TECH_SKILLS) {
    const re = new RegExp(`(?:^|[^a-z0-9+#.-])${escapeRegExp(skill)}(?:$|[^a-z0-9+#.-])`, 'i');
    if (re.test(normalized)) {
      keywords.tech.add(canonicalizeSkill(skill));
    }
  }

  // Extract year-of-experience patterns: "5 years", "5+ years"
  const yoeMatches = normalized.match(/(\d+)\+?\s*(?:years?|yrs?)/g) || [];
  for (const m of yoeMatches) {
    const n = parseInt(m);
    if (n >= 1 && n <= 30) keywords.general.add(`${n}yoe`);
  }

  // Education
  if (/bachelor|b\.s\.|b\.eng|undergraduate/.test(normalized)) keywords.general.add('bachelor');
  if (/master|m\.s\.|m\.eng|graduate/.test(normalized))          keywords.general.add('master');
  if (/phd|ph\.d|doctorate/.test(normalized))                     keywords.general.add('phd');
  if (/mba/.test(normalized))                                      keywords.general.add('mba');

  return keywords;
}

// ── UI helpers ────────────────────────────────────────────────────────────
function showProgress(msg, pct) {
  parsingProgress.classList.remove('hidden');
  uploadSection.classList.add('hidden');
  progressFill.style.width = pct + '%';
  progressText.textContent = msg;
}

function hideProgress() {
  parsingProgress.classList.add('hidden');
}

function showResumeLoaded(fromCache = false) {
  uploadSection.classList.add('hidden');
  resumeLoadedSec.classList.remove('hidden');
  scanControls.classList.remove('hidden');

  resumeNameEl.textContent = resumeFileName;
  const total = resumeKeywords.tech.size + resumeKeywords.general.size;
  resumeSkillsEl.textContent = `${total} keywords · ${resumeKeywords.tech.size} tech skills`;

  // Show/hide cache badge
  const cacheBadge = document.getElementById('cache-badge');
  if (cacheBadge) {
    if (fromCache) cacheBadge.classList.remove('hidden');
    else cacheBadge.classList.add('hidden');
  }

  // Show skill tags
  skillsPreviewEl.innerHTML = '';
  const techList = [...resumeKeywords.tech].slice(0, 12);
  const genList  = [...resumeKeywords.general].slice(0, 6);
  for (const s of techList) skillsPreviewEl.appendChild(makeTag(s, 'tech'));
  for (const s of genList.slice(0, 4)) skillsPreviewEl.appendChild(makeTag(s, ''));
  if (total > 18) skillsPreviewEl.appendChild(makeTag(`+${total - 18} more`, 'more'));
}

function makeTag(text, cls) {
  const span = document.createElement('span');
  span.className = 'skill-tag ' + cls;
  span.textContent = text;
  return span;
}

// ── Scan ──────────────────────────────────────────────────────────────────
async function runScan() {
  if (!resumeKeywords) return;
  scanBtn.disabled = true;
  scanBtn.textContent = 'Scanning...';

  // Serialize Sets to arrays for message passing
  const payload = {
    type: 'SCAN_JOBS',
    keywords: {
      tech:    [...resumeKeywords.tech],
      general: [...resumeKeywords.general],
    }
  };

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) throw new Error('No active tab');

    // Inject content script if not already present
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content.js']
    }).catch(() => {}); // ignore if already injected

    const response = await chrome.tabs.sendMessage(tab.id, payload);
    if (response) {
      if (response.error === 'empty_keywords') {
        alert('Your resume was loaded but no keywords were found.\n\nTry a different file format (TXT works most reliably).');
      } else if (response.error === 'no_resume') {
        alert('No resume found. Please upload your resume first.');
      } else {
        showResults(response);
      }
    }
  } catch (err) {
    console.error('Scan error:', err);
    alert('Could not scan the page.\n\nMake sure you are on https://hiring.cafe/ and try again.');
  } finally {
    scanBtn.disabled = false;
    scanBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg> Scan Job Cards`;
  }
}

function showResults(data) {
  resultsSection.classList.remove('hidden');
  document.getElementById('results-count').textContent = `${data.total} jobs scanned`;
  document.getElementById('count-strong').textContent  = data.strong;
  document.getElementById('count-good').textContent    = data.good;
  document.getElementById('count-partial').textContent = data.partial;
  document.getElementById('count-weak').textContent    = data.weak;

  // Show ML note if model has data
  const note = document.getElementById('ml-score-note');
  if (note) {
    if (data.mlCount > 0) note.classList.remove('hidden');
    else note.classList.add('hidden');
  }
}

async function sendToContent(msg) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) chrome.tabs.sendMessage(tab.id, msg).catch(() => {});
  } catch (_) {}
}
