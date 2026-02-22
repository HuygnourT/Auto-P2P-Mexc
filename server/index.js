// server/index.js
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const rateLimitMiddleware = require('./middleware/rateLimit.middleware');
const p2pRoutes = require('./routes/p2p.routes');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '../public')));

// Rate limiting on API routes
app.use('/api', rateLimitMiddleware);

// Routes
app.use('/api/p2p', p2pRoutes);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString(), version: '1.0.0' });
});

// Serve frontend
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// Error handler
app.use((err, req, res, next) => {
  console.error('[ERROR]', err.stack);
  res.status(500).json({ success: false, error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════╗
║     MEXC P2P Tool - Server Ready     ║
╠══════════════════════════════════════╣
║  URL:  http://localhost:${PORT}         ║
║  ENV:  ${process.env.NODE_ENV || 'development'}               ║
╚══════════════════════════════════════╝
  `);
});

module.exports = app;
