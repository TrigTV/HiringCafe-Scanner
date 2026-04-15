'use strict';

// ══════════════════════════════════════════════════════════════════════════
//  HiringCafe Resume Scanner — Content Script
// ══════════════════════════════════════════════════════════════════════════

const BADGE_CLASS      = 'hcrs-badge';
const STYLE_ID         = 'hcrs-styles';
const CARD_ATTR        = 'data-hcrs';          // stamped on each detected card
const ML_STORAGE_KEY   = 'hcrs_ml_model';
const RESUME_CACHE_KEY = 'hcrs_resume_cache';

let _keywords              = null;
let _mlModel               = null;
let _observer              = null;
let _rescanTimer           = null;
let _appliedWatcherActive  = false;

// ── Inject styles once ────────────────────────────────────────────────────
function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.textContent = `
    /* Card highlight — box-shadow only, never covers content */
    [data-hcrs="strong"] { box-shadow: inset 0 0 0 3px #22c55e, 0 2px 8px rgba(34,197,94,0.18) !important; }
    [data-hcrs="good"]   { box-shadow: inset 0 0 0 3px #3b82f6, 0 2px 8px rgba(59,130,246,0.18) !important; }
    [data-hcrs="partial"]{ box-shadow: inset 0 0 0 3px #f59e0b, 0 2px 8px rgba(245,158,11,0.18) !important; }
    [data-hcrs="weak"]   { box-shadow: inset 0 0 0 3px #ef4444, 0 2px 8px rgba(239,68,68,0.18)  !important; }

    /* Score badge — bottom-left so it doesn't cover the job title */
    .${BADGE_CLASS} {
      position: absolute !important;
      bottom: 8px !important;
      left: 8px !important;
      z-index: 9999 !important;
      padding: 2px 8px !important;
      border-radius: 99px !important;
      font-size: 11px !important;
      font-weight: 700 !important;
      color: #fff !important;
      pointer-events: none !important;
      line-height: 1.6 !important;
      font-family: -apple-system, BlinkMacSystemFont, sans-serif !important;
      box-shadow: 0 1px 4px rgba(0,0,0,0.3) !important;
      display: flex !important;
      align-items: center !important;
      gap: 3px !important;
      white-space: nowrap !important;
    }
    .hcrs-badge-strong  { background: #22c55e !important; }
    .hcrs-badge-good    { background: #3b82f6 !important; }
    .hcrs-badge-partial { background: #f59e0b !important; }
    .hcrs-badge-weak    { background: #ef4444 !important; }

    .hcrs-ml-dot {
      width: 5px !important; height: 5px !important;
      border-radius: 50% !important;
      background: rgba(255,255,255,0.75) !important;
      display: inline-block !important; flex-shrink: 0 !important;
    }

    @keyframes hcrs-learned {
      0%   { outline: 3px solid rgba(99,102,241,0.8); }
      100% { outline: 3px solid rgba(99,102,241,0); }
    }
    .hcrs-learning-flash { animation: hcrs-learned 0.8s ease-out !important; }
  `;
  document.head.appendChild(s);
}

// ── Card detection ────────────────────────────────────────────────────────
// Strategy: find the "Job Posting" footer link that HiringCafe renders on
// every card, then walk up to the tightest card-like ancestor.
function findJobCards() {
  const seen  = new Set();
  const cards = [];

  // Primary: "Job Posting" anchor text present on every HiringCafe card
  const anchors = [...document.querySelectorAll('a, span, div')].filter(el => {
    const t = el.childNodes.length <= 3 && (el.innerText || el.textContent || '').trim();
    return t === 'Job Posting';
  });

  for (const anchor of anchors) {
    const card = walkUpToCard(anchor);
    if (!card || seen.has(card)) continue;
    seen.add(card);
    cards.push(card);
  }

  // Fallback: size + content heuristic for any missed cards
  if (cards.length === 0) {
    const salaryRe = /\$[\d,.]+[k]?\s*(?:\/\s*(?:hr|yr|mo|year|hour|month))?/i;
    const typeRe   = /\b(full.?time|part.?time|contract|remote|hybrid|onsite)\b/i;

    for (const el of document.querySelectorAll('div[class], article, li')) {
      if (seen.has(el)) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 180 || rect.height < 120) continue;
      if (rect.width > window.innerWidth * 0.55) continue; // skip wide containers
      const text = el.innerText || '';
      if (text.length < 40 || text.split(/\s+/).length > 200) continue;
      if (!salaryRe.test(text) && !typeRe.test(text)) continue;
      seen.add(el);
      cards.push(el);
    }
  }

  return cards;
}

function walkUpToCard(el) {
  let cur = el.parentElement;
  for (let i = 0; i < 12 && cur && cur !== document.body; i++) {
    const rect  = cur.getBoundingClientRect();
    const style = window.getComputedStyle(cur);
    const br    = parseFloat(style.borderRadius);
    const bg    = style.backgroundColor;
    const hasBg = bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent';
    const goodW = rect.width >= 160 && rect.width <= window.innerWidth * 0.55;
    const goodH = rect.height >= 80;

    if ((hasBg || br > 0) && goodW && goodH) return cur;
    cur = cur.parentElement;
  }
  return null;
}

// ── Extract meaningful text from a card ──────────────────────────────────
// HiringCafe cards often have text in deeply nested spans rendered by React.
// We collect all leaf text nodes rather than relying on innerText of the root.
function extractCardText(card) {
  const parts = [];
  const walker = document.createTreeWalker(card, NodeFilter.SHOW_TEXT, null);
  let node;
  while ((node = walker.nextNode())) {
    const t = node.textContent.trim();
    if (t.length > 1) parts.push(t);
  }
  return parts.join(' ');
}

// ── Known tech skills to detect inside card text ──────────────────────────
// Mirrors the TECH_SKILLS set in popup.js so both sides agree on what counts.
const CARD_TECH_SKILLS = new Set([
  'python','javascript','typescript','java','c++','c#','go','golang','rust','ruby',
  'php','swift','kotlin','scala','r','matlab','perl','bash','powershell','sql',
  'html','css','sass','less','react','angular','vue','svelte','nextjs','express',
  'fastapi','django','flask','spring','rails','laravel','dotnet','.net','nodejs',
  'node.js','deno','pytorch','tensorflow','keras','sklearn','scikit-learn','pandas',
  'numpy','scipy','matplotlib','seaborn','plotly','aws','azure','gcp','docker',
  'kubernetes','k8s','terraform','ansible','jenkins','circleci','gitlab','devops',
  'helm','prometheus','grafana','datadog','splunk','elasticsearch','kibana',
  'mysql','postgresql','postgres','sqlite','mongodb','redis','cassandra','dynamodb',
  'firestore','snowflake','bigquery','redshift','clickhouse','kafka','rabbitmq',
  'airflow','dbt','databricks','spark','hadoop','graphql','grpc','rest',
  'microservices','machine learning','deep learning','nlp','computer vision',
  'data science','data engineering','mlops','git','github','linux','unix',
  'tableau','powerbi','looker','excel','figma','jira','agile','scrum',
]);

// ── Resume scoring ────────────────────────────────────────────────────────
// Correct approach:
//   1. Find which tech skills the card explicitly requires.
//   2. Score = what fraction of those card-required skills are in the resume.
//
// This avoids the "penalize for resume keywords not in a 60-word card" trap
// that was causing all scores to be near 0%.
//
// For non-tech cards (no recognized tech skills), fall back to general
// keyword overlap as a fraction of the card's unique meaningful words.
//
// ML blending only activates after the first "Mark Applied" click.
function resumeScore(text, keywords) {
  if (!keywords || (!keywords.tech.length && !keywords.general.length)) return null;

  const norm = text.toLowerCase().replace(/[^a-z0-9+#.\-\s]/g, ' ').replace(/\s+/g, ' ');
  if (norm.trim().length < 10) return 0;

  const resumeTechSet = new Set(keywords.tech);
  const resumeGenSet  = new Set(keywords.general);

  // ── Step 1: find tech skills the card mentions ────────────────────────
  const cardTech = [];
  for (const skill of CARD_TECH_SKILLS) {
    if (norm.includes(skill)) cardTech.push(skill);
  }

  // ── Step 2: tech-heavy card ───────────────────────────────────────────
  if (cardTech.length > 0) {
    let covered = 0;
    for (const skill of cardTech) {
      if (resumeTechSet.has(skill)) covered++;
    }
    // Core: fraction of card's tech requirements covered by the resume
    const techCoverage = covered / cardTech.length;

    // Small bonus for general keyword matches (education, YOE, etc.)
    const normWords = norm.split(' ');
    let genHits = 0;
    for (const kw of resumeGenSet) {
      if (normWords.includes(kw)) genHits++;
    }
    const genBonus = Math.min(0.15, genHits * 0.03);

    return Math.min(100, Math.round((techCoverage + genBonus) * 100));
  }

  // ── Step 3: non-tech card — general keyword overlap ───────────────────
  const cardWords = new Set(
    norm.split(' ')
      .map(w => w.replace(/^[-+.]+|[-+.]+$/g, ''))
      .filter(w => w.length >= 4 && /^[a-z][a-z0-9-]+$/.test(w))
  );
  if (cardWords.size === 0) return 0;

  let genHits = 0;
  for (const kw of resumeGenSet) {
    if (cardWords.has(kw)) genHits++;
  }
  // Normalize: 3+ general hits = reasonable match
  return Math.min(100, Math.round((genHits / Math.max(cardWords.size * 0.15, 3)) * 100));
}

function scoreToTier(score) {
  if (score >= 65) return 'strong';
  if (score >= 40) return 'good';
  if (score >= 20) return 'partial';
  return 'weak';
}

// ── Apply highlight to a single card ─────────────────────────────────────
function highlightCard(card, score, hasML) {
  const tier = scoreToTier(score);

  // Remove any prior highlight on this card
  card.removeAttribute('data-hcrs');
  card.querySelector(`.${BADGE_CLASS}`)?.remove();

  // Ensure badge can be positioned inside
  const pos = window.getComputedStyle(card).position;
  if (pos === 'static') card.style.position = 'relative';

  // Box-shadow tier (no overlay div — never covers content)
  card.setAttribute(CARD_ATTR, tier);

  // Badge — bottom-left, small
  const badge = document.createElement('div');
  badge.className = `${BADGE_CLASS} hcrs-badge-${tier}`;
  badge.textContent = `${score}%`;
  if (hasML) {
    const dot = document.createElement('span');
    dot.className = 'hcrs-ml-dot';
    dot.title = 'ML-influenced';
    badge.appendChild(dot);
  }
  card.appendChild(badge);
}

function clearHighlights() {
  document.querySelectorAll(`[${CARD_ATTR}]`).forEach(el => {
    el.removeAttribute(CARD_ATTR);
    el.querySelector(`.${BADGE_CLASS}`)?.remove();
  });
}

// ── ML helpers ────────────────────────────────────────────────────────────
const ML_STOP = new Set([
  'the','and','for','are','but','not','you','all','can','had','her','was','one',
  'our','out','get','has','him','his','how','its','now','old','see','two','who',
  'did','let','put','say','she','too','use','may','have','with','this','that',
  'from','they','will','been','more','also','into','than','then','when','your',
  'some','what','time','each','make','like','just','know','take','year','good',
  'come','over','think','back','after','could','these','those','which','there',
  'about','would','other','their','only','first','well','very','even','same',
  'much','must','most','any','way','long','down','work','part','need','both',
  'here','high','next','open','own','turn','such','give','tell','does','end',
  'why','ask','new','want','used','show','every','age','act','add','ago',
  'per','via','etc','team','years','experience','required','ability','strong',
  'excellent','knowledge','skills','working','including','minimum','plus',
  'great','bonus','opportunity','position','company','job','responsibilities',
  'requirements','qualifications','looking','seeking','join','help','drive',
  'ensure','support','implement','maintain','provide','using','related',
  'within','across','multiple','various','able','responsible','preferred',
  'additional','candidates','candidate','role','roles','apply','applied',
  'application','environment','environments','systems','system','process',
]);

function featureVec(text) {
  const norm = text.toLowerCase().replace(/[^a-z0-9+#.\-\s]/g, ' ').replace(/\s+/g, ' ').trim();
  const counts = {};
  const words  = norm.split(' ');
  for (const raw of words) {
    const w = raw.replace(/^[-+.]+|[-+.]+$/g, '');
    if (w.length < 3 || ML_STOP.has(w) || !/^[a-z0-9+#.-]{2,}$/.test(w)) continue;
    counts[w] = (counts[w] || 0) + 1;
  }
  for (let i = 0; i < words.length - 1; i++) {
    const a = words[i].replace(/^[-+.]+|[-+.]+$/g, '');
    const b = words[i+1].replace(/^[-+.]+|[-+.]+$/g, '');
    if (a.length < 2 || b.length < 2 || ML_STOP.has(a) || ML_STOP.has(b)) continue;
    const bg = `${a} ${b}`;
    counts[bg] = (counts[bg] || 0) + 0.8;
  }
  const mag = Math.sqrt(Object.values(counts).reduce((s, v) => s + v * v, 0));
  if (mag === 0) return {};
  const vec = {};
  for (const [w, c] of Object.entries(counts)) vec[w] = c / mag;
  return vec;
}

function cosineSim(a, b) {
  let dot = 0;
  for (const [w, v] of Object.entries(a)) if (b[w]) dot += v * b[w];
  return Math.min(1, Math.max(0, dot));
}

function mlScore(text) {
  if (!_mlModel || _mlModel.count === 0) return null;
  return Math.round(cosineSim(featureVec(text), _mlModel.centroid) * 100);
}

// Phase 1 (0 applications): pure resume score.
// Phase 2 (1+ applications): ML centroid similarity blended in, growing
//   4% per application up to 40% at 10+. Resume is always the foundation.
function blendScores(rScore, ml, appliedCount) {
  if (appliedCount === 0 || ml === null) return rScore;   // Phase 1 — resume only
  const mlWeight = Math.min(0.40, appliedCount * 0.04);   // Phase 2 — gradual blend
  return Math.max(0, Math.min(100, Math.round(rScore * (1 - mlWeight) + ml * mlWeight)));
}

async function loadMLModel() {
  return new Promise(resolve => {
    chrome.storage.local.get([ML_STORAGE_KEY], r => {
      _mlModel = r[ML_STORAGE_KEY] || { centroid: {}, count: 0, topWords: [] };
      resolve(_mlModel);
    });
  });
}

async function recordApplication(jobText) {
  const model  = _mlModel || { centroid: {}, count: 0, topWords: [] };
  const newVec = featureVec(jobText);
  const n      = model.count;

  const merged = {};
  for (const w of new Set([...Object.keys(model.centroid), ...Object.keys(newVec)])) {
    merged[w] = ((model.centroid[w] || 0) * n + (newVec[w] || 0)) / (n + 1);
  }
  const mag = Math.sqrt(Object.values(merged).reduce((s, v) => s + v * v, 0));
  const centroid = {};
  if (mag > 0) for (const [w, v] of Object.entries(merged)) centroid[w] = v / mag;

  const topWords = Object.entries(centroid)
    .filter(([w]) => w.length > 2 && !/^\d+$/.test(w))
    .sort((a, b) => b[1] - a[1]).slice(0, 25).map(([w]) => w);

  _mlModel = { centroid, count: n + 1, topWords };
  await new Promise(r => chrome.storage.local.set({ [ML_STORAGE_KEY]: _mlModel }, r));

  chrome.runtime.sendMessage({
    type: 'ML_MODEL_UPDATED', count: _mlModel.count, topWords: _mlModel.topWords,
  }).catch(() => {});

  return _mlModel;
}

// ── Main scan ─────────────────────────────────────────────────────────────
async function scanAndHighlight(keywords) {
  injectStyles();
  await loadMLModel();

  if (!keywords || (!keywords.tech.length && !keywords.general.length)) {
    return { error: 'empty_keywords', total: 0, strong: 0, good: 0, partial: 0, weak: 0, mlCount: 0 };
  }

  const cards   = findJobCards();
  const counts  = { strong: 0, good: 0, partial: 0, weak: 0 };
  const mlCount = _mlModel ? _mlModel.count : 0;

  // ML only influences scores after the user has explicitly applied to at least 1 job.
  const inMLPhase = mlCount >= 1;

  for (const card of cards) {
    const text   = extractCardText(card);
    const rScore = resumeScore(text, keywords) ?? 0;
    const ml     = inMLPhase ? mlScore(text) : null;
    const final  = blendScores(rScore, ml, mlCount);

    highlightCard(card, final, inMLPhase);
    counts[scoreToTier(final)]++;
  }

  return { total: cards.length, ...counts, mlCount };
}

// ── "Mark Applied" watcher ────────────────────────────────────────────────
function startAppliedWatcher() {
  if (_appliedWatcherActive) return;
  _appliedWatcherActive = true;

  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('button, [role="button"], a');
    if (!btn) return;
    if ((btn.innerText || btn.textContent || '').trim() !== 'Mark Applied') return;

    const panel = findJobPanel(btn);
    const jobText = panel ? (panel.innerText || panel.textContent || '') : '';
    if (jobText.length < 50) return;

    panel.classList.add('hcrs-learning-flash');
    setTimeout(() => panel.classList.remove('hcrs-learning-flash'), 900);

    const updated = await recordApplication(jobText);
    console.log(`[HCRS] Learned app #${updated.count}: ${updated.topWords.slice(0,5).join(', ')}`);

    if (_keywords) {
      clearTimeout(_rescanTimer);
      _rescanTimer = setTimeout(() => scanAndHighlight(_keywords), 400);
    }
  }, true);
}

function findJobPanel(btn) {
  // Walk up looking for the right-side job detail panel
  let el = btn.parentElement;
  for (let i = 0; i < 20 && el && el !== document.body; i++) {
    const r = el.getBoundingClientRect();
    if (r.height > window.innerHeight * 0.5 && r.width > 300 && r.width < window.innerWidth * 0.7) {
      return el;
    }
    el = el.parentElement;
  }
  // Last resort: right-side fixed/sticky panel
  for (const sel of ['[class*="panel"]','[class*="drawer"]','[class*="detail"]','[class*="sheet"]','[class*="modal"]']) {
    for (const o of document.querySelectorAll(sel)) {
      if (o.contains(btn)) return o;
    }
  }
  return document.body;
}

// ── MutationObserver ──────────────────────────────────────────────────────
function startObserver() {
  if (_observer) return;
  _observer = new MutationObserver(() => {
    if (!_keywords) return;
    clearTimeout(_rescanTimer);
    _rescanTimer = setTimeout(() => scanAndHighlight(_keywords), 700);
  });
  _observer.observe(document.body, { childList: true, subtree: true });
}

// ── Message listener ──────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'SCAN_JOBS') {
    const doScan = kw => {
      _keywords = kw;
      scanAndHighlight(kw).then(r => { sendResponse(r); startObserver(); startAppliedWatcher(); });
    };
    if (msg.keywords && (msg.keywords.tech.length || msg.keywords.general.length)) {
      doScan(msg.keywords);
    } else {
      chrome.storage.local.get([RESUME_CACHE_KEY], r => {
        const c = r[RESUME_CACHE_KEY];
        if (c && (c.tech?.length || c.general?.length)) {
          doScan({ tech: c.tech || [], general: c.general || [] });
        } else {
          sendResponse({ error: 'no_resume', total: 0, strong: 0, good: 0, partial: 0, weak: 0, mlCount: 0 });
        }
      });
    }
    return true;
  }

  if (msg.type === 'CLEAR_HIGHLIGHTS') {
    _keywords = null;
    clearHighlights();
    _observer?.disconnect(); _observer = null;
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'GET_ML_STATS') {
    loadMLModel().then(() => sendResponse(_mlModel || { count: 0, topWords: [] }));
    return true;
  }

  if (msg.type === 'RESET_ML') {
    chrome.storage.local.remove(ML_STORAGE_KEY, () => {
      _mlModel = { centroid: {}, count: 0, topWords: [] };
      if (_keywords) { clearHighlights(); scanAndHighlight(_keywords); }
      sendResponse({ ok: true });
    });
    return true;
  }
});

// ── Auto-init on page load ────────────────────────────────────────────────
(async () => {
  await loadMLModel();
  if (!_keywords) {
    chrome.storage.local.get([RESUME_CACHE_KEY], r => {
      const c = r[RESUME_CACHE_KEY];
      if (c) _keywords = { tech: c.tech || [], general: c.general || [] };
    });
  }
  startAppliedWatcher();
})();
