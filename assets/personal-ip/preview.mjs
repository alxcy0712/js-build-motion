import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const port = Number(process.argv[2] ?? 8831);
const mime = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp', '.md': 'text/plain; charset=utf-8' };
createServer((request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const path = resolve(root, '.' + (pathname === '/' ? '/preview.html' : pathname));
    if (!path.startsWith(root + sep) || !statSync(path).isFile()) throw new Error('Missing file');
    response.writeHead(200, { 'Content-Type': mime[extname(path)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    createReadStream(path).pipe(response);
  } catch { response.writeHead(404); response.end('File not found'); }
}).listen(port, '127.0.0.1', () => process.stdout.write('http://127.0.0.1:' + port + '/#wardrobe\n'));
