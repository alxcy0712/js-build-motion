import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { dirname, resolve, sep, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
let repository = root;
while (!existsSync(resolve(repository, 'assets/personal-ip/portrait.png')) && dirname(repository) !== repository) repository = dirname(repository);
const personalIP = resolve(repository, 'assets/personal-ip');
const port = Number(process.argv[2] ?? 8821);
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.png': 'image/png', '.md': 'text/plain; charset=utf-8', '.json': 'application/json' };
createServer((request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const shared = pathname.startsWith('/personal-ip/');
    const directory = shared ? personalIP : root;
    const path = resolve(directory, shared ? pathname.slice('/personal-ip/'.length) : '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!path.startsWith(directory + sep) || !statSync(path).isFile()) throw new Error('Missing file');
    response.writeHead(200, { 'Content-Type': mime[extname(path)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    createReadStream(path).pipe(response);
  } catch { response.writeHead(404); response.end('File not found'); }
}).listen(port, '127.0.0.1', () => process.stdout.write('http://127.0.0.1:' + port + '\n'));
