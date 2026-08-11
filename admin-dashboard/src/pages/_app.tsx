import Head from 'next/head';
import type { AppProps } from 'next/app';
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '../style/global.css';
import { ControlRoomTheme } from '../theme/control-room-theme';

export default function WaitQueueApp({ Component, pageProps }: AppProps) {
  return (
    <>
      <Head>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="theme-color" content="#f5f1e8" />
      </Head>
      <ControlRoomTheme>
        <Component {...pageProps} />
      </ControlRoomTheme>
    </>
  );
}
