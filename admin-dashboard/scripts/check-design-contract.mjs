import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const fail = (message) => {
  throw new Error(`design contract: ${message}`);
};
const expectText = (source, value, context) => {
  if (!source.includes(value)) fail(`${context} is missing ${value}`);
};
const hexLuminance = (hex) => {
  const channels = hex.match(/[\da-f]{2}/gi)?.map((value) => Number.parseInt(value, 16) / 255);
  if (!channels || channels.length !== 3) fail(`invalid contrast color ${hex}`);
  const linear = channels.map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
};
const contrast = (foreground, background) => {
  const [lighter, darker] = [hexLuminance(foreground), hexLuminance(background)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
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
expectText(theme, 'colorTextPlaceholder: supportingText', 'accessible placeholder mapping');
expectText(theme, 'cssVar: { key: `waitqueue-${mode}` }', 'isolated light and dark Ant variable scopes');
expectText(theme, 'defaultColor: colors.foreground', 'readable Ant button mapping');
expectText(theme, 'itemColor: colors.foregroundMuted', 'readable Ant navigation mapping');
expectText(theme, 'lastItemColor: colors.foreground', 'readable Ant breadcrumb mapping');
expectText(theme, "dataset.themeReady = 'true'", 'hydrated theme readiness');

const requiredTokens = [
  '--ui-canvas:',
  '--ui-navigation:',
  '--ui-surface:',
  '--ui-foreground:',
  '--ui-primary:',
  '--ui-ai:',
  '--ui-border:',
  '--ui-control-border:',
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

const darkBlock = globalCss.match(/:root\[data-theme='dark'\]\s*{([\s\S]*?)\n}/)?.[1];
if (!darkBlock) fail('dark semantic token block is missing');
const darkToken = (name) => {
  const value = darkBlock.match(new RegExp(`${name}:\\s*(#[\\da-f]{6})`, 'i'))?.[1];
  if (!value) fail(`dark semantic token is missing ${name}`);
  return value;
};
const darkSurface = darkToken('--ui-surface-raised');
for (const [role, minimum] of [['--ui-foreground', 7], ['--ui-foreground-muted', 4.5], ['--ui-primary', 4.5]]) {
  const ratio = contrast(darkToken(role), darkSurface);
  if (ratio < minimum) fail(`${role} dark contrast ${ratio.toFixed(2)} is below ${minimum}`);
}
if (contrast(darkToken('--ui-control-border'), darkSurface) < 3) {
  fail('dark control boundary contrast is below 3');
}

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
