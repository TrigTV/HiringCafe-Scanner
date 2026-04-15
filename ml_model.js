'use strict';

// ── HiringCafe Resume Scanner — ML Model ──────────────────────────────────
//
// Centroid-based preference learner. Every time the user clicks "Mark Applied"
// on HiringCafe, we extract a feature vector from the job panel and update a
// running centroid stored in chrome.storage.local.
//
// What is stored: an averaged word-frequency map (plain JS object). No job
// titles, no descriptions, no PII — only normalized numeric term weights.
//
// Scoring: cosine similarity between the candidate job's vector and the
// learned centroid, blended with the resume keyword score.
// ─────────────────────────────────────────────────────────────────────────

const STORAGE_KEY = 'hcrs_ml_model';

// Stop words for feature extraction
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
  'why','ask','new','want','used','show','every','age','act','add','ago','aid',
  'aim','air','per','via','etc','team','years','experience','required','ability',
  'strong','excellent','knowledge','skills','working','including','minimum','plus',
  'great','bonus','opportunity','position','company','job','responsibilities',
  'requirements','qualifications','looking','seeking','join','help','drive',
  'ensure','support','implement','maintain','provide','using','related','within',
  'across','multiple','various','able','responsible','preferred','additional',
  'candidates','candidate','role','roles','apply','applied','application',
  'environment','environments','systems','system','process','processes',
]);

// ── Feature extraction ────────────────────────────────────────────────────
function extractFeatureVector(text) {
  const normalized = text.toLowerCase()
    .replace(/[^a-z0-9+#.\-\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const counts = {};
  const words  = normalized.split(' ');

  for (const raw of words) {
    const w = raw.replace(/^[-+.]+|[-+.]+$/g, '');
    if (w.length < 3 || ML_STOP.has(w)) continue;
    if (!/^[a-z0-9+#.-]{2,}$/.test(w)) continue;
    counts[w] = (counts[w] || 0) + 1;
  }

  // Also extract 2-grams for multi-word skills
  for (let i = 0; i < words.length - 1; i++) {
    const a = words[i].replace(/^[-+.]+|[-+.]+$/g, '');
    const b = words[i + 1].replace(/^[-+.]+|[-+.]+$/g, '');
    if (a.length < 2 || b.length < 2 || ML_STOP.has(a) || ML_STOP.has(b)) continue;
    const bigram = a + ' ' + b;
    counts[bigram] = (counts[bigram] || 0) + 0.8; // slightly lower weight for bigrams
  }

  // Normalize to unit vector (L2)
  const magnitude = Math.sqrt(Object.values(counts).reduce((s, v) => s + v * v, 0));
  if (magnitude === 0) return {};
  const vec = {};
  for (const [w, c] of Object.entries(counts)) vec[w] = c / magnitude;
  return vec;
}

// ── Cosine similarity ─────────────────────────────────────────────────────
function cosineSimilarity(vecA, vecB) {
  let dot = 0;
  for (const [w, a] of Object.entries(vecA)) {
    if (vecB[w]) dot += a * vecB[w];
  }
  // Both are already L2-normalized, so magnitude product = 1
  return Math.min(1, Math.max(0, dot));
}

// ── Load model from storage ───────────────────────────────────────────────
async function loadModel() {
  return new Promise((resolve) => {
    chrome.storage.local.get([STORAGE_KEY], (result) => {
      resolve(result[STORAGE_KEY] || { centroid: {}, count: 0, topWords: [] });
    });
  });
}

// ── Save model to storage ─────────────────────────────────────────────────
async function saveModel(model) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [STORAGE_KEY]: model }, resolve);
  });
}

// ── Record a new application (update centroid incrementally) ──────────────
async function recordApplication(jobText) {
  const model  = await loadModel();
  const newVec = extractFeatureVector(jobText);
  const n      = model.count;

  // Incremental centroid update: centroid = (centroid*n + newVec) / (n+1)
  const merged = {};
  const allWords = new Set([...Object.keys(model.centroid), ...Object.keys(newVec)]);
  for (const w of allWords) {
    const old = (model.centroid[w] || 0) * n;
    const cur =  newVec[w] || 0;
    merged[w] = (old + cur) / (n + 1);
  }

  // Re-normalize centroid to unit vector
  const mag = Math.sqrt(Object.values(merged).reduce((s, v) => s + v * v, 0));
  const centroid = {};
  if (mag > 0) {
    for (const [w, v] of Object.entries(merged)) centroid[w] = v / mag;
  }

  // Top words (for display — exclude single-char and pure number tokens)
  const topWords = Object.entries(centroid)
    .filter(([w]) => w.length > 2 && !/^\d+$/.test(w))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 25)
    .map(([w]) => w);

  const updated = { centroid, count: n + 1, topWords };
  await saveModel(updated);
  return updated;
}

// ── Get similarity score for a job (0–100) ─────────────────────────────────
async function getSimilarityScore(jobText) {
  const model = await loadModel();
  if (model.count === 0) return null;
  const vec  = extractFeatureVector(jobText);
  const sim  = cosineSimilarity(vec, model.centroid);
  return Math.round(sim * 100);
}

// ── Blend resume score with ML score ─────────────────────────────────────
// Blending weight grows as more applications are recorded (max 40% at 10+)
function blendScores(resumeScore, mlScore, appliedCount) {
  if (mlScore === null || appliedCount === 0) return resumeScore;
  // Weight ramps: 0→0%, 1→10%, 2→20%, 3→30%, 10+→40%
  const mlWeight = Math.min(0.40, appliedCount * 0.04);
  const blended  = Math.round(resumeScore * (1 - mlWeight) + mlScore * mlWeight);
  return Math.max(0, Math.min(100, blended));
}

// ── Get model stats ───────────────────────────────────────────────────────
async function getModelStats() {
  return loadModel();
}

// ── Reset model ───────────────────────────────────────────────────────────
async function resetModel() {
  const empty = { centroid: {}, count: 0, topWords: [] };
  await saveModel(empty);
  return empty;
}

// Export for content.js (via importScripts or direct inclusion)
if (typeof module !== 'undefined') {
  module.exports = { recordApplication, getSimilarityScore, blendScores, getModelStats, resetModel, extractFeatureVector };
}
