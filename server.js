'use strict';
// Minimal dependency-free static server for Nuvio's Plugin Tester.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = __dirname;
const host = process.env.HOST || '0.0.0.0';
const port = Number(process.env.PORT || 3000);
const mime = { '.json': 'application/json; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.md': 'text/markdown; charset=utf-8' };
http.createServer((req, res) => {
  console.log("[HTTP]", req.method, req.url);
  let pathname;
  // Keep the rest of your existing code unchanged.
  try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
  catch { res.writeHead(400); return res.end('Bad request'); }

  if (pathname === '/__debug' && req.method === 'POST') {
    let body = '';

    req.setEncoding('utf8');
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 16000) req.destroy();
    });

    req.on('end', () => {
      console.log(`[NUVIO ${new Date().toISOString()}] ${body}`);
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*'
      });
      res.end();
    });

    return;
  }

  if (pathname === '/') pathname = '/README.md';
  const filePath = path.resolve(root, '.' + pathname);
  if (!filePath.startsWith(root + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(err.code === 'ENOENT' ? 404 : 500); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': mime[path.extname(filePath)] || 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    res.end(data);
  });
}).listen(port, host, () => {
  console.log(`CircleFTP provider server listening on http://${host}:${port}`);
  console.log(`Manifest: http://${host}:${port}/manifest.json`);
  console.log(`Provider: http://<THIS-PC-LAN-IP>:${port}/providers/circleftp.js`);
});
