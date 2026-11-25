// Serve the instrumented frontend from a standalone scratch checkout.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const [project, port, events, token] = process.argv.slice(2);
const cacheDir = project + '/.crash-gate-vite';
const { createBuilder } = await import(pathToFileURL(project + '/node_modules/vite/dist/node/index.js'));
const builder = await createBuilder({ root: project, cacheDir });
await builder.buildApp();

const directory = resolve(project, 'build');
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
  try {
    if (pathname === '/_gate-health') {
      response.end(token);
    } else if (pathname === '/_gate-event' && request.method === 'POST') {
      let body = '';
      for await (const chunk of request) body += chunk;
      const result = await fetch(`http://127.0.0.1:${events}/`, { method: 'POST', body });
      response.writeHead(result.status, { 'Content-Type': 'application/json' });
      response.end(await result.text());
    } else {
      const name = resolve(directory, pathname === '/' ? 'index.html' : '.' + pathname);
      if (!name.startsWith(directory + sep)) {
        response.writeHead(404).end();
        return;
      }
      let contents;
      try {
        contents = await readFile(name);
      } catch (error) {
        if (error.code !== 'ENOENT' || pathname !== '/') throw error;
        contents = await readFile(resolve(directory, '200.html'));
      }
      response.writeHead(200, {
        'Content-Type': mime[extname(name)] ?? 'application/octet-stream',
        'Cache-Control': pathname.startsWith('/_app/immutable/') ? 'public, max-age=3600' : 'no-store'
      });
      response.end(contents);
    }
  } catch (error) {
    // SIGKILL can sever a telemetry connection mid-request.
    if (request.aborted || error.code === 'ECONNRESET') return;
    if (!response.headersSent) response.statusCode = error.code === 'ENOENT' ? 404 : 500;
    response.end(String(error));
  }
});
server.listen(Number(port), '127.0.0.1');
