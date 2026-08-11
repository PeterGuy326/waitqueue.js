import { App as AntApp, ConfigProvider, theme as antTheme, type ThemeConfig } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export type ColorMode = 'light' | 'dark';

interface ColorModeContextValue {
  mode: ColorMode;
  toggleMode: () => void;
}

const ColorModeContext = createContext<ColorModeContextValue | null>(null);

const FONT_SANS = '"Avenir Next", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';
const FONT_MONO = '"SFMono-Regular", "Cascadia Mono", Consolas, "Liberation Mono", Menlo, monospace';

function themeConfig(mode: ColorMode): ThemeConfig {
  const dark = mode === 'dark';
  return {
    algorithm: [dark ? antTheme.darkAlgorithm : antTheme.defaultAlgorithm, antTheme.compactAlgorithm],
    cssVar: { key: 'waitqueue' },
    token: {
      colorPrimary: '#008f68',
      colorInfo: '#008f68',
      colorSuccess: '#00a870',
      colorWarning: '#d46b08',
      colorError: '#c9363e',
      colorBgBase: dark ? '#141618' : '#f5f6f5',
      colorTextBase: dark ? '#f3f5f4' : '#1b1d1f',
      colorBorder: dark ? '#3d4144' : '#cfd2d1',
      colorBorderSecondary: dark ? '#303437' : '#e3e5e4',
      borderRadius: 8,
      borderRadiusLG: 8,
      fontFamily: FONT_SANS,
      fontFamilyCode: FONT_MONO,
      fontSize: 14,
      controlHeight: 36,
      lineWidth: 1,
      motionDurationFast: '0.12s',
      motionDurationMid: '0.18s',
      boxShadow: dark ? '0 8px 20px rgba(0,0,0,.2)' : '0 8px 20px rgba(23,30,27,.06)',
    },
    components: {
      Layout: {
        bodyBg: dark ? '#141618' : '#f5f6f5',
        headerBg: dark ? '#1b1e20' : '#ffffff',
        siderBg: dark ? '#1b1e20' : '#ffffff',
      },
      Card: {
        headerBg: 'transparent',
        paddingLG: 20,
      },
      Table: {
        headerBg: dark ? '#232729' : '#f3f5f4',
        headerColor: dark ? '#c9cfcc' : '#555b58',
        rowHoverBg: dark ? '#202a27' : '#f0faf6',
        borderColor: dark ? '#363a3d' : '#dfe2e0',
        cellPaddingBlock: 12,
        cellPaddingInline: 14,
      },
      Menu: {
        itemBg: 'transparent',
        itemSelectedBg: dark ? '#16352b' : '#e7f7f1',
        itemSelectedColor: dark ? '#5ee0b6' : '#006f52',
        itemHoverBg: dark ? '#252a2c' : '#f1f3f2',
        itemBorderRadius: 7,
      },
      Button: {
        primaryShadow: 'none',
        defaultShadow: 'none',
        dangerShadow: 'none',
      },
      Statistic: {
        contentFontSize: 24,
        titleFontSize: 12,
      },
      Progress: {
        defaultColor: '#008f68',
        remainingColor: dark ? '#303537' : '#e7eae8',
      },
    },
  };
}

export function ControlRoomTheme({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<ColorMode>('light');

  useEffect(() => {
    const saved = window.localStorage.getItem('waitqueue-theme');
    const preferred = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    setMode(saved === 'dark' || saved === 'light' ? saved : preferred);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = mode;
    document.documentElement.style.colorScheme = mode;
    window.localStorage.setItem('waitqueue-theme', mode);
  }, [mode]);

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
