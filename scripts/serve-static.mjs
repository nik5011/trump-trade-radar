/* 用本機預覽靜態版（等同免費空間上的行為）
   用法：node scripts/serve-static.mjs [--dir dist] [--port 8080] */

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const dirArg = args.indexOf('--dir');
const portArg = args.indexOf('--port');
const DIR = path.resolve(ROOT, dirArg >= 0 ? args[dirArg + 1] : 'dist');
const PORT = Number(portArg >= 0 ? args[portArg + 1] : 8080);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/' || rel.endsWith('/')) rel += 'index.html';
    const abs = path.resolve(DIR, rel.replace(/^\/+/, ''));
    if (!abs.startsWith(DIR)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    try {
      const data = await fs.readFile(abs);
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream',
        /* 本機預覽時不要快取，否則改了 dist 還看到舊版 */
        'Cache-Control': 'no-store',
      });
      res.end(data);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404');
    }
  })
  .listen(PORT, () => {
    console.log(`靜態版預覽：http://localhost:${PORT}  （目錄：${path.relative(ROOT, DIR)}）`);
  });
