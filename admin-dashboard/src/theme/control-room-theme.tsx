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
  borderStrong: string;
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

/* Pinned semantic mapping: fullstack-ai-infra/design-system@9d048faa. */
const PALETTE: Record<ColorMode, SemanticPalette> = {
  light: {
    canvas: '#f5f1e8', canvasSubtle: '#eee9df', navigation: '#e6e1d7', surface: '#fbf9f4',
    surfaceRaised: '#fffdf8', surfaceInset: '#f0ece3', foreground: '#282925', foregroundMuted: '#5f615b',
    foregroundSubtle: '#6c6e67', border: '#d9d4ca', borderStrong: '#c6c1b7', controlBorder: '#929088', primary: '#5f735e',
    primaryHover: '#50644f', primaryForeground: '#fbfdf8', primarySoft: '#e2e9df', info: '#476e84',
    infoSoft: '#e1edf2', success: '#537153', successSoft: '#e0eadf', warning: '#8b672b',
    warningSoft: '#f4e8cf', danger: '#9a4e45', dangerSoft: '#f4dfdb',
    overlay: 'rgba(40, 41, 37, 0.42)',
    shadow: '0 10px 30px rgba(40, 41, 37, 0.09), 0 2px 8px rgba(40, 41, 37, 0.05)',
    shadowStrong: '0 24px 64px rgba(40, 41, 37, 0.16), 0 4px 12px rgba(40, 41, 37, 0.07)',
  },
  dark: {
    canvas: '#1e201d', canvasSubtle: '#242622', navigation: '#292b27', surface: '#272925',
    surfaceRaised: '#2e302c', surfaceInset: '#222420', foreground: '#efede7', foregroundMuted: '#b6b5ad',
    foregroundSubtle: '#93948c', border: '#3f423c', borderStrong: '#555950', controlBorder: '#737b6e', primary: '#a1b69d',
    primaryHover: '#b2c6ae', primaryForeground: '#1c251c', primarySoft: '#344035', info: '#8eb6ca',
    infoSoft: '#2c4049', success: '#9dba9a', successSoft: '#314132', warning: '#d4b069',
    warningSoft: '#493d28', danger: '#d99488', dangerSoft: '#4d302d',
    overlay: 'rgba(0, 0, 0, 0.62)',
    shadow: '0 10px 30px rgba(0, 0, 0, 0.28), 0 2px 8px rgba(0, 0, 0, 0.2)',
    shadowStrong: '0 24px 64px rgba(0, 0, 0, 0.38), 0 4px 12px rgba(0, 0, 0, 0.24)',
  },
};

const ColorModeContext = createContext<ColorModeContextValue | null>(null);
const FONT_SANS = 'Inter, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
const FONT_MONO = '"SFMono-Regular", Consolas, "Liberation Mono", monospace';
const STORAGE_KEY = 'waitqueue-warm-theme';

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
      colorInfo: colors.info,
      colorSuccess: colors.success,
      colorWarning: colors.warning,
      colorError: colors.danger,
      colorBgBase: colors.canvas,
      colorBgLayout: colors.canvas,
      colorBgContainer: colors.surface,
      colorBgElevated: colors.surfaceRaised,
      colorBgMask: colors.overlay,
      colorFillSecondary: colors.surfaceInset,
      colorFillTertiary: colors.canvasSubtle,
      colorText: colors.foreground,
      colorTextSecondary: colors.foregroundMuted,
      colorTextTertiary: colors.foregroundSubtle,
      colorTextQuaternary: colors.foregroundSubtle,
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
        siderBg: colors.navigation,
        lightSiderBg: colors.navigation,
      },
      Card: {
        colorBgContainer: colors.surface,
        headerBg: 'transparent',
        extraColor: colors.foregroundMuted,
        actionsBg: colors.surfaceInset,
        paddingLG: 20,
      },
      Menu: {
        itemBg: 'transparent',
        subMenuItemBg: 'transparent',
        itemColor: colors.foregroundMuted,
        itemDisabledColor: colors.foregroundSubtle,
        groupTitleColor: colors.foregroundSubtle,
        itemSelectedBg: colors.surfaceRaised,
        itemSelectedColor: colors.primary,
        itemHoverBg: colors.surface,
        itemHoverColor: colors.foreground,
        itemBorderRadius: 10,
        activeBarBorderWidth: 0,
      },
      Table: {
        colorText: colors.foreground,
        headerBg: colors.surfaceInset,
        headerColor: colors.foregroundMuted,
        rowHoverBg: colors.surfaceRaised,
        rowSelectedBg: colors.primarySoft,
        rowSelectedHoverBg: colors.primarySoft,
        borderColor: colors.border,
        cellPaddingBlock: 13,
        cellPaddingInline: 14,
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
        activeShadow: `0 0 0 3px ${dark ? 'rgba(172,194,168,.18)' : 'rgba(113,134,111,.18)'}`,
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
    const saved = window.localStorage.getItem(STORAGE_KEY) ?? window.localStorage.getItem('waitqueue-theme');
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
