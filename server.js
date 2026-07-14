const express = require('express');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;
const publicDirectory = path.join(__dirname, 'public');

app.disable('x-powered-by');
app.use(express.static(publicDirectory, {
  etag: true,
  maxAge: '5m',
  setHeaders(res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
  }
}));

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(publicDirectory, 'index.html'));
});

app.listen(port, '0.0.0.0', () => {
  console.log(`Verification frontend listening on port ${port}`);
});