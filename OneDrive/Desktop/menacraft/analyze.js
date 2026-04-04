/**
 * POST /analyze/file
 *
 * Receives a multipart upload (image, video, or audio) plus optional metadata
 * (caption, language, …), fans out to the Authenticity and Context AI
 * microservices in parallel, then returns a single structured report.
 */

const express  = require('express');
const multer   = require('multer');
const FormData = require('form-data');
const fetch    = require('node-fetch');
const { v4: uuidv4 } = require('uuid');

const router = express.Router();

// ─── Storage ────────────────────────────────────────────────────────────────
// Keep files in memory so we can stream them directly to AI services.
// Switch to diskStorage for very large uploads.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024 }, // 200 MB hard cap
  fileFilter(_req, file, cb) {
    const allowed = [
      // images
      'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp',
      // video
      'video/mp4', 'video/webm', 'video/quicktime', 'video/x-msvideo',
      // audio
      'audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/mp4', 'audio/flac',
      'audio/aac', 'audio/webm',
    ];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE',
        `Unsupported MIME type: ${file.mimetype}`));
    }
  },
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Derive a human-readable content category from the MIME type.
 * @param {string} mimetype
 * @returns {'image'|'video'|'audio'|'unknown'}
 */
function resolveContentType(mimetype) {
  if (mimetype.startsWith('image/')) return 'image';
  if (mimetype.startsWith('video/')) return 'video';
  if (mimetype.startsWith('audio/')) return 'audio';
  return 'unknown';
}

/**
 * Build a FormData body that both AI services understand.
 *
 * @param {import('multer').File} file   - Multer file object (buffer in memory)
 * @param {string}                contentType - 'image' | 'video' | 'audio'
 * @param {object}                meta   - arbitrary caller-supplied metadata
 */
function buildServicePayload(file, contentType, meta) {
  const form = new FormData();
  form.append('file', file.buffer, {
    filename:    file.originalname,
    contentType: file.mimetype,
  });
  form.append('content_type', contentType);
  form.append('metadata', JSON.stringify(meta));
  return form;
}

/**
 * POST to one AI microservice with a shared timeout.
 *
 * @param {string}   serviceUrl
 * @param {FormData} payload
 * @param {number}   timeoutMs
 * @returns {Promise<{ok: boolean, status: number, body: object}>}
 */
async function callService(serviceUrl, payload, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(serviceUrl, {
      method:  'POST',
      body:    payload,
      headers: payload.getHeaders(),
      signal:  controller.signal,
    });

    const body = await res.json().catch(() => ({
      error: 'Non-JSON response from service',
    }));

    return { ok: res.ok, status: res.status, body };
  } catch (err) {
    if (err.name === 'AbortError') {
      return { ok: false, status: 504, body: { error: 'Service timed out' } };
    }
    return { ok: false, status: 503, body: { error: err.message } };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Normalise whatever an AI service returns into a consistent shape:
 *   { score, label, confidence, explanation, raw }
 *
 * Adjust field aliases here to match your actual service contracts.
 *
 * @param {object} body  - raw JSON from the service
 * @param {boolean} ok   - whether the HTTP call succeeded
 */
function normaliseResult(body, ok) {
  if (!ok) {
    return {
      score:       null,
      label:       'error',
      confidence:  null,
      explanation: body.error || 'Service unavailable',
      raw:         body,
    };
  }

  return {
    // Accept either `score` or `probability` from the service
    score:       body.score       ?? body.probability ?? null,
    // Accept either `label` or `verdict`
    label:       body.label       ?? body.verdict     ?? 'unknown',
    // Accept either `confidence` or `certainty`
    confidence:  body.confidence  ?? body.certainty   ?? null,
    // Accept either `explanation` or `reason`
    explanation: body.explanation ?? body.reason      ?? '',
    raw:         body,
  };
}

// ─── Route ───────────────────────────────────────────────────────────────────

router.post('/', upload.single('file'), async (req, res) => {

  // ── 1. Validate upload ──────────────────────────────────────────────────
  if (!req.file) {
    return res.status(400).json({
      success: false,
      error:   'No file uploaded. Include a "file" field in a multipart/form-data request.',
    });
  }

  const requestId   = uuidv4();
  const receivedAt  = new Date().toISOString();
  const contentType = resolveContentType(req.file.mimetype);

  // ── 2. Parse metadata ───────────────────────────────────────────────────
  // The client may send a JSON string in the `metadata` field,
  // individual form fields, or both.
  let parsedMeta = {};
  if (req.body.metadata) {
    try {
      parsedMeta = JSON.parse(req.body.metadata);
    } catch {
      return res.status(400).json({
        success: false,
        error:   'Invalid JSON in "metadata" field.',
      });
    }
  }

  // Merge any top-level form fields (caption, language, …) into meta.
  // Explicit `metadata` JSON wins over individual fields if they clash.
  const meta = {
    caption:  req.body.caption  || null,
    language: req.body.language || 'en',
    ...parsedMeta,
    // Always include file identity in meta for service audit logs
    filename:     req.file.originalname,
    content_type: contentType,
  };

  // ── 3. Resolve service URLs ─────────────────────────────────────────────
  const AUTHENTICITY_URL = process.env.AUTHENTICITY_SERVICE_URL
    || 'http://localhost:5001/predict';
  const CONTEXT_URL      = process.env.CONTEXT_SERVICE_URL
    || 'http://localhost:5002/predict';

  // ── 4. Call both AI services in parallel ────────────────────────────────
  // Build two independent FormData objects (one per service).
  const [authenticityRes, contextRes] = await Promise.all([
    callService(
      AUTHENTICITY_URL,
      buildServicePayload(req.file, contentType, meta),
    ),
    callService(
      CONTEXT_URL,
      buildServicePayload(req.file, contentType, meta),
    ),
  ]);

  // ── 5. Normalise results ────────────────────────────────────────────────
  const authenticity = normaliseResult(authenticityRes.body, authenticityRes.ok);
  const context      = normaliseResult(contextRes.body,      contextRes.ok);

  // ── 6. Compute aggregate verdict ───────────────────────────────────────
  //
  // Scoring logic:
  //   authenticity.score → probability that the content is REAL (0–1)
  //   context.score      → probability that caption MATCHES content (0–1)
  //
  // Both must be non-null for the aggregate to be meaningful.
  let aggregateScore   = null;
  let aggregateVerdict = 'inconclusive';

  if (authenticity.score !== null && context.score !== null) {
    // Simple equal-weight average; adjust weights via env vars if needed.
    const wA = parseFloat(process.env.WEIGHT_AUTHENTICITY || '0.6');
    const wC = parseFloat(process.env.WEIGHT_CONTEXT      || '0.4');

    aggregateScore = (authenticity.score * wA) + (context.score * wC);

    const HIGH_THRESHOLD = parseFloat(process.env.VERDICT_HIGH || '0.7');
    const LOW_THRESHOLD  = parseFloat(process.env.VERDICT_LOW  || '0.4');

    if (aggregateScore >= HIGH_THRESHOLD) {
      aggregateVerdict = 'likely_authentic';
    } else if (aggregateScore < LOW_THRESHOLD) {
      aggregateVerdict = 'likely_inauthentic';
    } else {
      aggregateVerdict = 'uncertain';
    }
  }

  // ── 7. Build the unified response ──────────────────────────────────────
  const report = {
    success:    true,
    request_id: requestId,
    received_at: receivedAt,
    analyzed_at: new Date().toISOString(),

    file: {
      name:         req.file.originalname,
      size_bytes:   req.file.size,
      mime_type:    req.file.mimetype,
      content_type: contentType,
    },

    metadata: meta,

    results: {
      authenticity: {
        service_status: authenticityRes.ok ? 'ok' : 'error',
        ...authenticity,
      },
      context: {
        service_status: contextRes.ok ? 'ok' : 'error',
        ...context,
      },
    },

    aggregate: {
      score:   aggregateScore !== null
        ? parseFloat(aggregateScore.toFixed(4))
        : null,
      verdict: aggregateVerdict,
      weights: {
        authenticity: parseFloat(process.env.WEIGHT_AUTHENTICITY || '0.6'),
        context:      parseFloat(process.env.WEIGHT_CONTEXT      || '0.4'),
      },
    },
  };

  // Surface a top-level warning if any downstream service failed.
  const serviceErrors = [];
  if (!authenticityRes.ok) serviceErrors.push('authenticity');
  if (!contextRes.ok)      serviceErrors.push('context');

  if (serviceErrors.length) {
    report.warnings = serviceErrors.map(
      svc => `The "${svc}" service returned an error; its result is excluded from scoring.`,
    );
  }

  return res.status(200).json(report);
});

// ─── Error handler for Multer ─────────────────────────────────────────────────
router.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    const messages = {
      LIMIT_FILE_SIZE:      'File exceeds the 200 MB limit.',
      LIMIT_UNEXPECTED_FILE: err.message,
    };
    return res.status(413).json({
      success: false,
      error:   messages[err.code] || err.message,
    });
  }
  // Generic fallback
  console.error('[/analyze/file]', err);
  return res.status(500).json({ success: false, error: 'Internal server error.' });
});

module.exports = router;
