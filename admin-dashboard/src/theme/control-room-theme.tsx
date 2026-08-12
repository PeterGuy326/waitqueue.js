import { App as AntApp, ConfigProvider, theme as antTheme, type ThemeConfig } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export type ColorMode = 'light' | 'dark';

interface ColorModeContextValue {
  mode: ColorMode;
  toggleMode: () => void;
}

interface SemanticPalette {
  canvas: string;
  canvasSubtle: string;
  navigation: string;
  surface: string;
  surfaceRaised: string;
  surfaceInset: string;
  foreground: string;
  foregroundMuted: string;
  foregroundSubtle: string;
  border: string;
  controlBorder: string;
  primary: string;
  primaryHover: string;
  primaryForeground: string;
  primarySoft: string;
  info: string;
  infoSoft: string;
  success: string;
  successSoft: string;
  warning: string;
  warningSoft: string;
  danger: string;
  dangerSoft: string;
  overlay: string;
  shadow: string;
  shadowStrong: string;
}

/* WaitQueue neutral palette. Shell geometry and interaction density reference
 * fullstack-ai-infra/design-system@9d048faa; color follows Ant Design 6. */
const PALETTE: Record<ColorMode, SemanticPalette> = {
  light: {
    canvas: '#f5f5f5', canvasSubtle: '#fafafa', navigation: '#ffffff', surface: '#ffffff',
    surfaceRaised: '#ffffff', surfaceInset: '#f5f5f5', foreground: '#1f1f1f', foregroundMuted: '#595959',
    foregroundSubtle: '#737373', border: '#f0f0f0', controlBorder: '#8c8c8c', primary: '#0958d9',
    primaryHover: '#003eb3', primaryForeground: '#ffffff', primarySoft: '#e6f4ff', info: '#0958d9',
    infoSoft: '#e6f4ff', success: '#237804', successSoft: '#f6ffed', warning: '#9a5b00',
    warningSoft: '#fffbe6', danger: '#cf1322', dangerSoft: '#fff1f0',
    overlay: 'rgba(0, 0, 0, 0.45)',
    shadow: '0 1px 2px rgba(0, 0, 0, 0.03), 0 4px 12px rgba(0, 0, 0, 0.05)',
    shadowStrong: '0 12px 40px rgba(0, 0, 0, 0.18), 0 3px 10px rgba(0, 0, 0, 0.08)',
  },
  dark: {
    canvas: '#141414', canvasSubtle: '#1f1f1f', navigation: '#1f1f1f', surface: '#1f1f1f',
    surfaceRaised: '#262626', surfaceInset: '#181818', foreground: '#f5f5f5', foregroundMuted: '#bfbfbf',
    foregroundSubtle: '#a6a6a6', border: '#303030', controlBorder: '#737373', primary: '#69b1ff',
    primaryHover: '#91caff', primaryForeground: '#111a2c', primarySoft: '#111d2c', info: '#69b1ff',
    infoSoft: '#111d2c', success: '#95de64', successSoft: '#162312', warning: '#ffd666',
    warningSoft: '#2b2111', danger: '#ff7875', dangerSoft: '#2a1215',
    overlay: 'rgba(0, 0, 0, 0.62)',
    shadow: '0 1px 2px rgba(0, 0, 0, 0.28), 0 6px 18px rgba(0, 0, 0, 0.24)',
    shadowStrong: '0 16px 48px rgba(0, 0, 0, 0.48), 0 4px 12px rgba(0, 0, 0, 0.30)',
  },
};

const ColorModeContext = createContext<ColorModeContextValue | null>(null);
const FONT_SANS = 'Inter, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
const FONT_MONO = '"SFMono-Regular", Consolas, "Liberation Mono", monospace';
const STORAGE_KEY = 'waitqueue-color-mode';
const LEGACY_STORAGE_KEYS = ['waitqueue-warm-theme', 'waitqueue-theme'];

function themeConfig(mode: ColorMode): ThemeConfig {
  const colors = PALETTE[mode];
  const dark = mode === 'dark';
  const supportingText = dark ? colors.foregroundMuted : colors.foregroundSubtle;
  return {
    algorithm: dark ? antTheme.darkAlgorithm : antTheme.defaultAlgorithm,
    // Keep SSR light variables and hydrated dark variables in separate scopes.
    // A shared key lets the server's later light rule override dark component vars.
    cssVar: { key: `waitqueue-${mode}` },
    token: {
      colorPrimary: colors.primary,
      colorPrimaryHover: colors.primaryHover,
      colorPrimaryActive: colors.primary,
      colorInfo: colors.info,
      colorInfoBg: colors.infoSoft,
      colorSuccess: colors.success,
      colorSuccessBg: colors.successSoft,
      colorWarning: colors.warning,
      colorWarningBg: colors.warningSoft,
      colorError: colors.danger,
      colorErrorBg: colors.dangerSoft,
      colorBgBase: colors.canvas,
      colorBgLayout: colors.canvas,
      colorBgContainer: colors.surface,
      colorBgElevated: colors.surfaceRaised,
      colorBgMask: colors.overlay,
      colorFillSecondary: colors.surfaceInset,
      colorFillTertiary: colors.canvasSubtle,
      colorText: colors.foreground,
      colorTextSecondary: colors.foregroundMuted,
      colorTextTertiary: supportingText,
      colorTextQuaternary: supportingText,
      colorTextPlaceholder: supportingText,
      colorTextHeading: colors.foreground,
      colorTextLabel: colors.foregroundMuted,
      colorTextDescription: colors.foregroundMuted,
      colorTextDisabled: colors.foregroundSubtle,
      colorIcon: colors.foregroundMuted,
      colorIconHover: colors.foreground,
      colorBgContainerDisabled: colors.surfaceInset,
      colorBorderDisabled: colors.border,
      colorSplit: colors.border,
      colorBorder: colors.controlBorder,
      colorBorderSecondary: colors.border,
      colorLink: colors.primary,
      colorLinkHover: colors.primaryHover,
      colorLinkActive: colors.primary,
      borderRadius: 10,
      borderRadiusLG: 14,
      borderRadiusSM: 6,
      fontFamily: FONT_SANS,
      fontFamilyCode: FONT_MONO,
      fontSize: 14,
      fontSizeSM: 13,
      fontSizeLG: 15,
      controlHeight: 38,
      controlHeightLG: 44,
      controlHeightSM: 30,
      lineHeight: 1.55,
      lineWidth: 1,
      motionDurationFast: '0.12s',
      motionDurationMid: '0.18s',
      boxShadow: colors.shadow,
      boxShadowSecondary: colors.shadow,
    },
    components: {
      Layout: {
        bodyBg: colors.canvas,
        headerBg: colors.canvas,
        headerColor: colors.foreground,
        headerHeight: 60,
        headerPadding: '0 var(--ui-topbar-inline, 24px)',
        siderBg: colors.navigation,
        lightSiderBg: colors.navigation,
      },
      Card: {
        colorBgContainer: colors.surface,
        headerBg: 'transparent',
        extraColor: colors.foregroundMuted,
        bodyPadding: 20,
        headerHeight: 64,
        headerPadding: 20,
      },
      Menu: {
        itemBg: 'transparent',
        subMenuItemBg: 'transparent',
        itemColor: colors.foregroundMuted,
        itemDisabledColor: colors.foregroundSubtle,
        groupTitleColor: colors.foregroundSubtle,
        itemSelectedBg: colors.primarySoft,
        itemSelectedColor: colors.primary,
        itemHoverBg: colors.surfaceInset,
        itemHoverColor: colors.foreground,
        itemBorderRadius: 10,
        activeBarBorderWidth: 0,
        darkItemBg: 'transparent',
        darkSubMenuItemBg: 'transparent',
        darkItemColor: colors.foregroundMuted,
        darkItemSelectedBg: colors.primarySoft,
        darkItemSelectedColor: colors.primary,
        darkItemHoverBg: colors.surfaceInset,
        darkItemHoverColor: colors.foreground,
        darkGroupTitleColor: colors.foregroundSubtle,
        darkItemDisabledColor: colors.foregroundSubtle,
      },
      Table: {
        colorText: colors.foreground,
        headerBg: colors.surfaceInset,
        headerColor: colors.foregroundMuted,
        rowHoverBg: colors.surfaceInset,
        borderColor: colors.border,
        cellPaddingBlockSM: 10,
        cellPaddingInlineSM: 12,
      },
      Button: {
        primaryColor: colors.primaryForeground,
        defaultColor: colors.foreground,
        defaultBg: colors.surfaceRaised,
        defaultBorderColor: colors.controlBorder,
        defaultHoverBg: colors.surface,
        defaultHoverColor: colors.primaryHover,
        defaultHoverBorderColor: colors.primary,
        defaultActiveBg: colors.surfaceInset,
        defaultActiveColor: colors.primaryHover,
        defaultActiveBorderColor: colors.primary,
        textTextColor: colors.foregroundMuted,
        textTextHoverColor: colors.foreground,
        textTextActiveColor: colors.primary,
        primaryShadow: 'none',
        defaultShadow: 'none',
        dangerShadow: 'none',
      },
      Input: {
        colorBgContainer: colors.surfaceRaised,
        colorText: colors.foreground,
        colorTextPlaceholder: supportingText,
        colorTextDisabled: colors.foregroundSubtle,
        colorBgContainerDisabled: colors.surfaceInset,
        hoverBg: colors.surfaceRaised,
        activeBg: colors.surfaceRaised,
        hoverBorderColor: colors.primary,
        activeBorderColor: colors.primary,
        activeShadow: `0 0 0 3px ${dark ? 'rgba(105,177,255,.2)' : 'rgba(22,119,255,.15)'}`,
      },
      Select: {
        colorBgContainer: colors.surfaceRaised,
        colorText: colors.foreground,
        colorTextPlaceholder: supportingText,
        colorTextDisabled: colors.foregroundSubtle,
        optionSelectedBg: colors.primarySoft,
      },
      Breadcrumb: {
        itemColor: colors.foregroundMuted,
        linkColor: colors.foregroundMuted,
        linkHoverColor: colors.primary,
        lastItemColor: colors.foreground,
        separatorColor: colors.foregroundSubtle,
      },
      Modal: {
        contentBg: colors.surfaceRaised,
        headerBg: colors.surfaceRaised,
        borderRadiusLG: 18,
        boxShadow: colors.shadowStrong,
      },
      Drawer: {
        colorBgElevated: colors.canvasSubtle,
      },
      Statistic: {
        contentFontSize: 28,
        titleFontSize: 13,
      },
      Progress: {
        defaultColor: colors.primary,
        remainingColor: colors.surfaceInset,
      },
      Tag: {
        defaultBg: colors.surfaceInset,
        defaultColor: colors.foregroundMuted,
      },
    },
  };
}

export function ControlRoomTheme({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<ColorMode>('light');
  const [initialized, setInitialized] = useState(false);

  useEffect(() => {
    const saved = window.localStorage.getItem(STORAGE_KEY)
      ?? LEGACY_STORAGE_KEYS.map((key) => window.localStorage.getItem(key)).find(Boolean);
    const preferred: ColorMode = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    const initialMode: ColorMode = saved === 'dark' || saved === 'light' ? saved : preferred;
    setMode(initialMode);
    document.documentElement.dataset.theme = initialMode;
    document.documentElement.style.colorScheme = initialMode;
    setInitialized(true);
  }, []);

  useEffect(() => {
    if (!initialized) return;
    document.documentElement.dataset.theme = mode;
    document.documentElement.style.colorScheme = mode;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', PALETTE[mode].canvas);
    window.localStorage.setItem(STORAGE_KEY, mode);
    document.documentElement.dataset.themeReady = 'true';
  }, [initialized, mode]);

  const value = useMemo<ColorModeContextValue>(
    () => ({ mode, toggleMode: () => setMode((current) => (current === 'light' ? 'dark' : 'light')) }),
    [mode]
  );

  return (
    <ConfigProvider locale={zhCN} componentSize="middle" theme={themeConfig(mode)}>
      <AntApp>
        <ColorModeContext.Provider value={value}>{children}</ColorModeContext.Provider>
      </AntApp>
    </ConfigProvider>
  );
}

export function useColorMode(): ColorModeContextValue {
  const context = useContext(ColorModeContext);
  if (!context) throw new Error('useColorMode must be used inside ControlRoomTheme');
  return context;
}
