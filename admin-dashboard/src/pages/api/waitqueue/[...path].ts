import type { NextApiRequest, NextApiResponse } from 'next';

const DEFAULT_API_ORIGIN = 'http://127.0.0.1:3000';
const DEFAULT_ALLOWED_HOSTS = '127.0.0.1,localhost,[::1]';
const PROXY_TIMEOUT_MS = 10_000;
const JSON_CONTENT_TYPE = 'application/json';

const ALLOWED_ROUTES = new Map<string, 'GET' | 'POST'>([
  ['admin/overview', 'GET'],
  ['admin/deadLetters', 'GET'],
  ['admin/deadLetters/replay', 'POST'],
  ['queue/newQueue', 'POST'],
  ['scheduler/addTask', 'POST'],
]);

type ErrorEnvelope = {
  code: 1;
  msg: string;
  data: never[];
};

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '32kb',
    },
  },
};

function errorEnvelope(msg: string): ErrorEnvelope {
  return { code: 1, msg, data: [] };
}

function normalizedHostname(authority: string): string {
  if (!authority || /[\\/\s]/.test(authority)) throw new Error('invalid host authority');
  const parsed = new URL(`http://${authority}`);
  if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('invalid host authority');
  }
  return parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
}

function requestHostAllowed(request: NextApiRequest): boolean {
  try {
    const configured = process.env.DASHBOARD_ALLOWED_HOSTS || DEFAULT_ALLOWED_HOSTS;
    const allowedHosts = configured.split(',').map((value) => normalizedHostname(value.trim()));
    return allowedHosts.includes(normalizedHostname(request.headers.host || ''));
  } catch {
    return false;
  }
}

function upstreamOrigin(): string {
  const raw = process.env.WAITQUEUE_API_URL || DEFAULT_API_ORIGIN;
  const parsed = new URL(raw);
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error('WAITQUEUE_API_URL must be an HTTP(S) origin without credentials or a path');
  }
  return parsed.origin;
}

function routePath(request: NextApiRequest): string | undefined {
  const segments = request.query.path;
  if (!Array.isArray(segments) || segments.some((segment) => !segment)) return undefined;
  return segments.join('/');
}

function upstreamSearch(request: NextApiRequest, path: string): string | undefined {
  const suppliedKeys = Object.keys(request.query).filter((key) => key !== 'path');
  if (path !== 'admin/deadLetters') return suppliedKeys.length === 0 ? '' : undefined;

  const allowedKeys = new Set(['queueId', 'offset', 'limit']);
  if (suppliedKeys.some((key) => !allowedKeys.has(key))) return undefined;
  const search = new URLSearchParams();
  for (const key of ['queueId', 'offset', 'limit']) {
    const value = request.query[key];
    if (value === undefined) continue;
    if (typeof value !== 'string') return undefined;
    search.set(key, value);
  }
  const serialized = search.toString();
  return serialized ? `?${serialized}` : '';
}

function copyResponseHeader(response: Response, target: NextApiResponse, name: string): void {
  const value = response.headers.get(name);
  if (value) target.setHeader(name, value);
}

export default async function handler(request: NextApiRequest, response: NextApiResponse): Promise<void> {
  if (!requestHostAllowed(request)) {
    response.status(403).json(errorEnvelope('host not allowed'));
    return;
  }

  const path = routePath(request);
  const allowedMethod = path ? ALLOWED_ROUTES.get(path) : undefined;
  if (!path || !allowedMethod) {
    response.status(404).json(errorEnvelope('route not found'));
    return;
  }

  if (request.method !== allowedMethod) {
    response.setHeader('Allow', allowedMethod);
    response.status(405).json(errorEnvelope('method not allowed'));
    return;
  }

  const search = upstreamSearch(request, path);
  if (search === undefined) {
    response.status(400).json(errorEnvelope('query parameters not allowed'));
    return;
  }

  if (allowedMethod === 'POST') {
    const contentType = request.headers['content-type'] || '';
    const mediaType = contentType.split(';', 1)[0].trim().toLowerCase();
    if (mediaType !== JSON_CONTENT_TYPE) {
      response.status(415).json(errorEnvelope('content type must be application/json'));
      return;
    }
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = { accept: JSON_CONTENT_TYPE };
    if (allowedMethod === 'POST') headers['content-type'] = JSON_CONTENT_TYPE;

    const token = process.env.WAITQUEUE_API_TOKEN?.trim();
    if (token) headers.authorization = `Bearer ${token}`;

    const upstream = await fetch(`${upstreamOrigin()}/waitqueue/${path}${search}`, {
      method: allowedMethod,
      headers,
      body: allowedMethod === 'POST' ? JSON.stringify(request.body) : undefined,
      redirect: 'manual',
      signal: controller.signal,
    });
    if (upstream.status >= 300 && upstream.status < 400) {
      throw new Error('unexpected upstream redirect');
    }

    for (const header of ['content-type', 'cache-control', 'retry-after']) {
      copyResponseHeader(upstream, response, header);
    }
    const body = await upstream.text();
    response.status(upstream.status);
    if (body) response.send(body);
    else response.end();
  } catch {
    response.status(502).json(errorEnvelope('upstream service unavailable'));
  } finally {
    clearTimeout(timeout);
  }
}
