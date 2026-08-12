import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('../', import.meta.url);
const out = new URL('out/', root);
const fail = (message) => { throw new Error(`pages export: ${message}`); };
const read = (path) => readFileSync(new URL(path, root), 'utf8');

if (!existsSync(new URL('out/index.html', root))) fail('out/index.html is missing');
if (!existsSync(new URL('out/404.html', root))) fail('out/404.html is missing');

const html = read('out/index.html');
const pageSource = read('src/pages/index.tsx');
for (const marker of [
  'WaitQueue · 只读演示',
  '访客演示 · 只读快照',
  '当前页面使用仓库内置的脱敏示例数据',
  'billing-export',
  '/waitqueue.js/_next/',
]) {
  if (!html.includes(marker)) fail(`static HTML is missing ${marker}`);
}

const files = [];
const walk = (directory) => {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) walk(path);
    else files.push(path);
  }
};
walk(out.pathname);

if (files.some((path) => path.includes('/api/'))) fail('API route output must not be published');
if (files.some((path) => path.endsWith('server.js'))) fail('Node server output must not be published');

const browserAssets = files
  .filter((path) => /\.(?:html|js)$/.test(path))
  .map((path) => readFileSync(path, 'utf8'))
  .join('\n');
if (/WAITQUEUE_API_TOKEN|DASHBOARD_ALLOWED_HOSTS/.test(browserAssets)) fail('server-only configuration leaked into the export');
if (/https?:\/\/(?:mock-hook|localhost|127\.0\.0\.1)/.test(browserAssets)) fail('local service address leaked into the export');
if (/\/waitqueue\/(?:admin|health|queue|scheduler)/.test(browserAssets)) fail('live WaitQueue request path leaked into the export');
if (!browserAssets.includes('example.invalid')) fail('sanitized demonstration origins are missing');

for (const control of [
  'disabled={DEMO_MODE} onClick={() => openQueueModal()',
  'disabled={DEMO_MODE} onClick={() => openQueueModal(activeQueue)}',
  'disabled={DEMO_MODE} onClick={() => openTaskModal(activeQueue)}',
  'disabled={DEMO_MODE} onClick={() => replayDeadLetter(item)}',
  'htmlType="submit" disabled={DEMO_MODE}',
]) {
  if (!pageSource.includes(control)) fail(`read-only control guard is missing: ${control}`);
}

console.log('WaitQueue Pages export contract verified.');
