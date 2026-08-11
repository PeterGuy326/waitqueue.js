import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const fail = (message) => {
  throw new Error(`design contract: ${message}`);
};
const expectText = (source, value, context) => {
  if (!source.includes(value)) fail(`${context} is missing ${value}`);
};

const globalCss = read('src/style/global.css');
const dashboardCss = read('src/style/dashboard.module.css');
const page = read('src/pages/index.tsx');
const documentSource = read('src/pages/_document.tsx');
const theme = read('src/theme/control-room-theme.tsx');
const packageJson = JSON.parse(read('package.json'));

expectText(globalCss, '9d048faaabe0429a6a8720bfbb31418544237b6b', 'semantic adapter pin');
expectText(theme, 'fullstack-ai-infra/design-system@9d048faa', 'Ant theme pin');
expectText(documentSource, "matchMedia('(prefers-color-scheme: dark)')", 'pre-paint system theme bootstrap');
expectText(documentSource, "localStorage.getItem('waitqueue-theme')", 'legacy theme migration');
expectText(documentSource, "dataset.themeReady=mode==='dark'?'false':'true'", 'dark first-paint guard');
expectText(globalCss, "[data-theme-ready='false']", 'dark first-paint CSS guard');
expectText(theme, 'colorTextPlaceholder: colors.foregroundSubtle', 'accessible placeholder mapping');
expectText(theme, "dataset.themeReady = 'true'", 'hydrated theme readiness');

const requiredTokens = [
  '--ui-canvas:',
  '--ui-navigation:',
  '--ui-surface:',
  '--ui-foreground:',
  '--ui-primary:',
  '--ui-ai:',
  '--ui-border:',
  '--ui-font-sans:',
  '--ui-space-4:',
  '--ui-radius-lg:',
  '--ui-shadow-md:',
  '--ui-duration-normal:',
  '--ui-rail-width: 72px',
  '--ui-sidebar-width: 256px',
  '--ui-topbar-height: 60px',
];
for (const token of requiredTokens) expectText(globalCss, token, 'semantic token contract');

if (/#[\da-f]{3,8}\b/i.test(dashboardCss) || /#[\da-f]{3,8}\b/i.test(page)) {
  fail('product layout must use semantic variables instead of raw palette values');
}

for (const legacy of ['WaitQueue Workbench', 'Runtime Pulse', 'Delivery & Recovery', '#00c98b', '#17181b']) {
  if (page.includes(legacy) || dashboardCss.includes(legacy)) fail(`legacy visual language remains: ${legacy}`);
}

expectText(page, 'data-product="waitqueue-console"', 'stable dashboard marker');
expectText(page, 'aria-label="主模块导航"', 'primary navigation landmark');
expectText(page, 'aria-label="队列目录"', 'queue catalog landmark');
expectText(page, 'aria-label="运行模块"', 'rail menu name');
expectText(page, 'tabIndex={-1}', 'skip-link focus target');
expectText(dashboardCss, 'min-height: 44px', 'mobile touch targets');
for (const view of ["key: 'overview'", "key: 'queues'", "key: 'deadLetters'", "key: 'diagnostics'"]) {
  expectText(page, view, 'module navigation');
}

if (packageJson.dependencies['@ant-design/icons']) fail('product icons must not depend directly on @ant-design/icons');
if (packageJson.dependencies['lucide-react'] !== '0.468.0') fail('lucide-react must stay aligned with the pinned design-system commit');
if (packageJson.dependencies['@fontsource/inter'] !== '5.3.0') fail('Inter assets must stay aligned with the pinned design-system commit');

console.log('Warm Agent Workspace contract verified.');
