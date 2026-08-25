import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { pool, query } from './db.js';
import { getProject, listProjects, listReference } from './projects.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const host = process.env.HOST || '0.0.0.0';
const port = Number(process.env.PORT || 8000);
const staticFiles = new Map([
  ['/', 'index.html'],
  ['/index.html', 'index.html'],
  ['/app.js', 'app.js'],
  ['/styles.css', 'styles.css'],
  ['/config.js', 'config.js'],
]);
const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

function sendJson(response, status, body) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': process.env.CORS_ORIGIN || '*',
  });
  response.end(JSON.stringify(body));
}

async function sendStatic(response, pathname) {
  const filename = staticFiles.get(pathname);
  if (!filename) return false;
  const body = await readFile(resolve(root, filename));
  response.writeHead(200, {
    'Content-Type': contentTypes[extname(filename)] || 'application/octet-stream',
    'Cache-Control': filename === 'config.js' ? 'no-store' : 'public, max-age=300',
  });
  response.end(body);
  return true;
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  try {
    if (request.method === 'GET' && url.pathname === '/api/v1/health') {
      const database = await query('SELECT now() AS checked_at');
      const sync = await query('SELECT status, finished_at, projects_seen, errors_count FROM sync_runs ORDER BY started_at DESC LIMIT 1');
      return sendJson(response, 200, {
        status: 'ok', database: 'connected', checked_at: database.rows[0].checked_at,
        latest_sync: sync.rows[0] || null,
      });
    }

    if (request.method === 'GET' && url.pathname === '/api/v1/projects') {
      return sendJson(response, 200, await listProjects(url.searchParams));
    }

    const projectMatch = url.pathname.match(/^\/api\/v1\/projects\/([^/]+)$/);
    if (request.method === 'GET' && projectMatch) {
      const project = await getProject(decodeURIComponent(projectMatch[1]));
      return sendJson(response, project ? 200 : 404, project ? { data: project } : { error: 'Project not found.' });
    }

    if (request.method === 'GET' && url.pathname === '/api/v1/filters/states') {
      return sendJson(response, 200, { data: await listReference('states') });
    }
    if (request.method === 'GET' && url.pathname === '/api/v1/filters/districts') {
      return sendJson(response, 200, { data: await listReference('districts', url.searchParams.get('state') || '') });
    }
    if (request.method === 'GET' && url.pathname === '/api/v1/filters/cities') {
      return sendJson(response, 200, { data: await listReference('cities', url.searchParams.get('district') || '') });
    }
    if (request.method === 'GET' && url.pathname === '/api/v1/filters/statuses') {
      return sendJson(response, 200, { data: await listReference('statuses') });
    }

    if (request.method === 'GET' && await sendStatic(response, url.pathname)) return;
    sendJson(response, 404, { error: 'Not found.' });
  } catch (error) {
    console.error(error);
    sendJson(response, 500, { error: 'The application could not complete this request.' });
  }
});

server.listen(port, host, () => {
  console.log(`Property Nearby is running at http://localhost:${port}`);
});

async function shutdown(signal) {
  console.log(`Received ${signal}; shutting down.`);
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

