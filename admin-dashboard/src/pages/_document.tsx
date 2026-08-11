import { createCache, extractStyle, StyleProvider } from '@ant-design/cssinjs';
import Document, { Head, Html, Main, NextScript, type DocumentContext } from 'next/document';

export default class WaitQueueDocument extends Document {
  static async getInitialProps(ctx: DocumentContext) {
    const cache = createCache();
    const originalRenderPage = ctx.renderPage;

    ctx.renderPage = () =>
      originalRenderPage({
        enhanceApp: (App) => (props) => (
          <StyleProvider cache={cache}>
            <App {...props} />
          </StyleProvider>
        ),
      });

    const initialProps = await Document.getInitialProps(ctx);
    const antStyles = extractStyle(cache, true);
    return {
      ...initialProps,
      styles: (
        <>
          {initialProps.styles}
          <style id="antd-ssr" dangerouslySetInnerHTML={{ __html: antStyles }} />
        </>
      ),
    };
  }

  render() {
    return (
      <Html lang="zh-CN">
        <Head>
          <script
            id="waitqueue-theme-bootstrap"
            dangerouslySetInnerHTML={{
              __html: `(function(){try{var saved=localStorage.getItem('waitqueue-warm-theme')||localStorage.getItem('waitqueue-theme');var mode=saved==='dark'||saved==='light'?saved:(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');document.documentElement.dataset.theme=mode;document.documentElement.dataset.themeReady=mode==='dark'?'false':'true';document.documentElement.style.colorScheme=mode;}catch(error){}})();`,
            }}
          />
        </Head>
        <body>
          <Main />
          <NextScript />
        </body>
      </Html>
    );
  }
}
