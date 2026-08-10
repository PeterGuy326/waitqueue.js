import Head from 'next/head';
import type { AppProps } from 'next/app';
import '@arco-design/web-react/dist/css/arco.css';
import '../style/global.css';

export default function WaitQueueApp({ Component, pageProps }: AppProps) {
  return (
    <>
      <Head>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="theme-color" content="#0b1220" />
      </Head>
      <Component {...pageProps} />
    </>
  );
}
