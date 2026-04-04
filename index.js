const express = require("express");
const { createProxyMiddleware } = require("http-proxy-middleware");
const morgan = require("morgan");
const helmet = require("helmet");

const app = express();
const PORT = process.env.PORT || 3000;

// Microservice URLs (set via environment variables or defaults)
const SERVICES = {
  fileAnalyzer: process.env.FILE_ANALYZER_URL || "http://localhost:4001",
  scoreAggregator: process.env.SCORE_AGGREGATOR_URL || "http://localhost:4002",
  chatbot: process.env.CHATBOT_URL || "http://localhost:4003",
};

// Middleware
app.use(helmet());
app.use(morgan("dev"));
app.use(express.json());

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", gateway: "API Gateway", routes: 3 });
});

// Route: POST /analyze/file → File & Content Analyzer
app.use(
  "/analyze/file",
  createProxyMiddleware({
    target: SERVICES.fileAnalyzer,
    changeOrigin: true,
    on: {
      error: (err, req, res) => {
        console.error("[/analyze/file] Proxy error:", err.message);
        res.status(502).json({ error: "File Analyzer service unavailable" });
      },
    },
  })
);

// Route: POST /analyze/link → Source & Score Aggregator
app.use(
  "/analyze/link",
  createProxyMiddleware({
    target: SERVICES.scoreAggregator,
    changeOrigin: true,
    on: {
      error: (err, req, res) => {
        console.error("[/analyze/link] Proxy error:", err.message);
        res.status(502).json({ error: "Score Aggregator service unavailable" });
      },
    },
  })
);

// Route: POST /chat → File & Content Analyzer (chatbot logic)
app.use(
  "/chat",
  createProxyMiddleware({
    target: SERVICES.chatbot,
    changeOrigin: true,
    pathRewrite: { "^/chat": "/chat" },
    on: {
      error: (err, req, res) => {
        console.error("[/chat] Proxy error:", err.message);
        res.status(502).json({ error: "Chatbot service unavailable" });
      },
    },
  })
);

// 404 fallback
app.use((req, res) => {
  res.status(404).json({ error: `Route ${req.method} ${req.path} not found` });
});

app.listen(PORT, () => {
  console.log(`\n🔷 API Gateway running on http://localhost:${PORT}`);
  console.log(`   POST /analyze/file  → ${SERVICES.fileAnalyzer}`);
  console.log(`   POST /analyze/link  → ${SERVICES.scoreAggregator}`);
  console.log(`   POST /chat          → ${SERVICES.chatbot}\n`);
});