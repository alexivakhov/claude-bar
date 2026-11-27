// LAN endpoint for the e-ink companion display (NM-EPD-420, ESP32-S3).
// Serves the last usage payload as JSON; the board polls it over Wi-Fi.
const http = require('http');
const crypto = require('crypto');

const DEFAULT_PORT = 8765;

let server = null;
let bonjour = null;
let bonjourService = null;

function tokenOk(provided, expected) {
  if (typeof provided !== 'string' || !expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function newToken() {
  return crypto.randomBytes(16).toString('hex');
}

// getData: () => last normalized usage payload (or null)
function start({ port, token, getData }) {
  stop();
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const provided = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') ||
      url.searchParams.get('token');
    if (!tokenOk(provided, token)) {
      res.writeHead(401).end();
      return;
    }
    if (req.method !== 'GET' || url.pathname !== '/usage') {
      res.writeHead(404).end();
      return;
    }
    const data = getData();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ now: Date.now(), usage: data }));
  });
  server.on('error', (e) => console.error('eink-server error:', e.message));
  server.listen(port, '0.0.0.0');

  try {
    const { Bonjour } = require('bonjour-service');
    bonjour = new Bonjour();
    bonjourService = bonjour.publish({ name: 'Claude Bar', type: 'claudebar', protocol: 'tcp', port });
  } catch (e) {
    console.warn('eink-server: mDNS unavailable:', e.message);
  }
}

function stop() {
  try { if (bonjourService) bonjourService.stop(); } catch {}
  try { if (bonjour) bonjour.destroy(); } catch {}
  bonjourService = bonjour = null;
  if (server) { server.close(); server = null; }
}

module.exports = { start, stop, newToken, DEFAULT_PORT };
