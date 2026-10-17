/** Serves the review UI and docs for the demo. Never serves anything outside the allow-list. */
import fs from 'node:fs';
import path from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.md': 'text/markdown; charset=utf-8',
  '.json': 'application/json; charset=utf-8'
};

export function createStaticHandler(root) {
  const base = path.resolve(root);
  const allowed = (rel) => rel === '/src/client.js' || ['/demo/', '/assets/', '/docs/'].some((p) => rel.startsWith(p));

  return function serveStatic(urlPath, res) {
    let rel;
    try { rel = decodeURIComponent(urlPath.split('?')[0]); } catch { return false; }
    // The page loads styles.css and js/ relative to its own URL, so it must be served from /demo/, not / or /demo.
    if (rel === '/' || rel === '/demo') {
      res.writeHead(302, { Location: '/demo/' });
      res.end();
      return true;
    }
    if (rel === '/demo/') rel = '/demo/index.html';
    if (!allowed(rel)) return false;
    const file = path.normalize(path.join(base, rel.replace(/^\//, '')));
    if (!file.startsWith(base + path.sep)) return false;
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
    return true;
  };
}
