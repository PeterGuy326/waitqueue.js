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

expectText(globalCss, '9d048faaabe0429a6a8720bfbb31418544237b6b', 'structural reference pin');
expectText(theme, 'fullstack-ai-infra/design-system@9d048faa', 'Ant structural reference pin');
expectText(documentSource, "matchMedia('(prefers-color-scheme: dark)')", 'pre-paint system theme bootstrap');
expectText(documentSource, "localStorage.getItem('waitqueue-color-mode')", 'neutral theme storage');
expectText(documentSource, "localStorage.getItem('waitqueue-warm-theme')", 'warm theme migration');
expectText(documentSource, "localStorage.getItem('waitqueue-theme')", 'original theme migration');
expectText(documentSource, "dataset.themeReady=mode==='dark'?'false':'true'", 'dark first-paint guard');
expectText(globalCss, "[data-theme-ready='false']", 'dark first-paint CSS guard');
expectText(theme, 'colorTextPlaceholder: supportingText', 'accessible placeholder mapping');
expectText(theme, 'colorTextTertiary: supportingText', 'accessible tertiary text mapping');
expectText(theme, 'cssVar: { key: `waitqueue-${mode}` }', 'isolated light and dark Ant variable scopes');
expectText(theme, 'colorPrimaryActive: colors.primary', 'accessible active primary mapping');
expectText(theme, 'colorLinkActive: colors.primary', 'accessible active link mapping');
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

const cssBlocks = {
  light: globalCss.match(/:root,\s*:root\[data-theme='light'\]\s*{([\s\S]*?)\n}/)?.[1],
  dark: globalCss.match(/:root\[data-theme='dark'\]\s*{([\s\S]*?)\n}/)?.[1],
};
const cssToken = (mode, name) => {
  const block = cssBlocks[mode];
  if (!block) fail(`${mode} semantic token block is missing`);
  const value = block.match(new RegExp(`${name}:\\s*(#[\\da-f]{6})`, 'i'))?.[1];
  if (!value) fail(`${mode} semantic token is missing ${name}`);
  return value;
};

const expectedPalette = {
  light: {
    '--ui-canvas': '#f5f5f5', '--ui-navigation': '#ffffff', '--ui-surface': '#ffffff',
    '--ui-primary': '#0958d9', '--ui-primary-hover': '#003eb3', '--ui-primary-soft': '#e6f4ff',
  },
  dark: {
    '--ui-canvas': '#141414', '--ui-navigation': '#1f1f1f', '--ui-surface': '#1f1f1f',
    '--ui-primary': '#69b1ff', '--ui-primary-hover': '#91caff', '--ui-primary-soft': '#111d2c',
  },
};
for (const mode of ['light', 'dark']) {
  for (const [role, expected] of Object.entries(expectedPalette[mode])) {
    const actual = cssToken(mode, role).toLowerCase();
    if (actual !== expected) fail(`${mode} ${role} must be ${expected}, received ${actual}`);
  }
  const surface = cssToken(mode, '--ui-surface-raised');
  for (const [role, minimum] of [
    ['--ui-foreground', 7],
    ['--ui-foreground-muted', 4.5],
    ['--ui-foreground-subtle', 4.5],
    ['--ui-primary', 4.5],
    ['--ui-primary-hover', 4.5],
  ]) {
    const ratio = contrast(cssToken(mode, role), surface);
    if (ratio < minimum) fail(`${mode} ${role} contrast ${ratio.toFixed(2)} is below ${minimum}`);
  }
  if (contrast(cssToken(mode, '--ui-control-border'), surface) < 3) {
    fail(`${mode} control boundary contrast is below 3`);
  }
  if (contrast(cssToken(mode, '--ui-primary-foreground'), cssToken(mode, '--ui-primary')) < 4.5) {
    fail(`${mode} primary button contrast is below 4.5`);
  }
}

const themeBlock = (mode) => theme.match(new RegExp(`${mode}: \\{([\\s\\S]*?)\\n  \\},`))?.[1];
for (const mode of ['light', 'dark']) {
  const block = themeBlock(mode);
  if (!block) fail(`${mode} theme palette is missing`);
  const color = (role) => {
    const value = block.match(new RegExp(`${role}:\\s*'(#[\\da-f]{6})'`, 'i'))?.[1];
    if (!value) fail(`${mode} theme palette is missing ${role}`);
    return value;
  };
  for (const role of ['info', 'success', 'warning', 'danger']) {
    const ratio = contrast(color(role), color(`${role}Soft`));
    if (ratio < 4.5) fail(`${mode} ${role} tag contrast ${ratio.toFixed(2)} is below 4.5`);
  }
}

const retiredWarmPalette = [
  '#f5f1e8', '#eee9df', '#e6e1d7', '#fbf9f4', '#fffdf8', '#f0ece3',
  '#5f735e', '#50644f', '#e2e9df', '#1e201d', '#242622', '#292b27',
  '#272925', '#2e302c', '#344035', '#a1b69d', '#b2c6ae',
];
for (const color of retiredWarmPalette) {
  if (globalCss.toLowerCase().includes(color) || theme.toLowerCase().includes(color)) {
    fail(`retired green/warm palette remains: ${color}`);
  }
}

if (/#[\da-f]{3,8}\b/i.test(dashboardCss) || /#[\da-f]{3,8}\b/i.test(page)) {
  fail('product layout must use semantic variables instead of raw palette values');
}
if (dashboardCss.includes('!important')) {
  fail('product layout must not override Ant Design component tokens with !important');
}

const referencedStyles = new Set([...page.matchAll(/styles\.([A-Za-z][A-Za-z0-9_]*)/g)].map((match) => match[1]));
for (const styleName of referencedStyles) {
  if (!new RegExp(`\\.${styleName}(?=[\\s,{:.>])`).test(dashboardCss)) {
    fail(`CSS module class referenced by the page is missing: ${styleName}`);
  }
}

for (const legacy of ['WaitQueue Workbench', 'Runtime Pulse', 'Delivery & Recovery', '#00c98b', '#17181b']) {
  if (page.includes(legacy) || dashboardCss.includes(legacy)) fail(`legacy visual language remains: ${legacy}`);
}

expectText(page, 'data-product="waitqueue-console"', 'stable dashboard marker');
expectText(page, 'aria-label="主模块导航"', 'primary navigation landmark');
expectText(page, 'aria-label="队列目录"', 'queue catalog landmark');
expectText(page, 'aria-label="运行模块"', 'rail menu name');
expectText(page, 'className={styles.queueMenu}', 'Ant Design queue menu');
expectText(page, '<Row className={styles.metricGrid}', 'Ant Design responsive metric grid');
expectText(page, '<Title level={1}', 'accessible Ant Design page title');
expectText(page, 'STATUS_TAG_STYLES', 'final semantic status tag colors');
expectText(page, 'QUEUE_COUNT_BADGE_STYLES', 'readable queue count badge');
expectText(page, '当前页面', 'screen-reader current page state');
expectText(page, '当前队列', 'screen-reader current queue state');
expectText(page, 'tabIndex={-1}', 'skip-link focus target');
expectText(dashboardCss, 'min-height: 44px', 'mobile touch targets');
for (const view of ["key: 'overview'", "key: 'queues'", "key: 'deadLetters'", "key: 'diagnostics'"]) {
  expectText(page, view, 'module navigation');
}

if (packageJson.dependencies['@ant-design/icons']) fail('product icons must not depend directly on @ant-design/icons');
if (packageJson.dependencies['lucide-react'] !== '0.468.0') fail('lucide-react must stay aligned with the structural design-system reference');
if (packageJson.dependencies['@fontsource/inter'] !== '5.3.0') fail('Inter assets must stay aligned with the structural design-system reference');

console.log('WaitQueue neutral Ant console contract verified.');
