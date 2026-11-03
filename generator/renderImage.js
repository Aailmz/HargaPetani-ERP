const puppeteer = require('puppeteer');

let browserInstance = null;

async function getBrowser() {
  if (!browserInstance) {
    browserInstance = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'], // perlu di VPS linux
    });
  }
  return browserInstance;
}

/**
 * Render HTML string jadi JPG, disimpan ke outputPath.
 * width ditentukan, height auto (full content).
 */
async function renderHtmlToJpg(htmlString, outputPath, width = 650) {
  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    await page.setViewport({ width, height: 100 }); // height nanti disesuaikan
    await page.setContent(htmlString, { waitUntil: 'networkidle0' });

    const bodyHandle = await page.$('body');
    const { height } = await bodyHandle.boundingBox();
    await bodyHandle.dispose();

    await page.setViewport({ width, height: Math.ceil(height) });
    await page.screenshot({ path: outputPath, type: 'jpeg', quality: 92, fullPage: true });
  } finally {
    await page.close();
  }

  return outputPath;
}

async function tutupBrowser() {
  if (browserInstance) {
    await browserInstance.close();
    browserInstance = null;
  }
}

process.on('exit', () => {
  if (browserInstance) browserInstance.close();
});

module.exports = { renderHtmlToJpg, tutupBrowser };