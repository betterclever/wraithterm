import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.env.WRAITH_REPORT_DIR ??= '.cache/performance-experiments/validation/experimental-api';
const { parameterPrototype, bulkPrint } = await import(
  pathToFileURL(root + '/scripts/performance-experiments/input.mjs')
);
const parameter = await parameterPrototype(root);
const installedInstances = [];
const launch = chromium.launch.bind(chromium);
chromium.launch = async (options) => {
  const browser = await launch(options),
    create = browser.newPage.bind(browser);
  browser.newPage = async (options) => {
    const page = await create(options);
    await page.addInitScript({
      content: `(()=>{${parameter.code.replace('export function install', 'function install')}window.__parameterInstall=install;window.__bulkPrint=${bulkPrint.toString()};})();`,
    });
    await page.route('**/packages/wraith/src/xterm.*', async (route) => {
      const response = await route.fetch();
      let body = await response.text();
      if (!body.includes('accelerateInput(this);'))
        throw new Error('Unfamiliar Terminal constructor');
      body = body.replace(
        'accelerateInput(this);',
        'accelerateInput(this);window.__experimentalApiInstances=(window.__experimentalApiInstances??0)+1;window.__parameterInstall(this);window.__bulkPrint(this);',
      );
      await route.fulfill({ response, body });
    });
    return page;
  };
  const close = browser.close.bind(browser);
  browser.close = async (...args) => {
    try {
      for (const context of browser.contexts())
        for (const page of context.pages()) {
          if (page.url().includes('xterm.html')) {
            const count = await page.evaluate(() => window.__experimentalApiInstances ?? 0);
            if (!count) throw new Error('Experimental API constructor was not installed');
            installedInstances.push(count);
            console.log('Experimental API instances verified:', count);
          }
        }
    } finally {
      await close(...args);
    }
  };
  return browser;
};
await import(pathToFileURL(root + '/scripts/xterm-browser-test.mjs'));
await writeFile(
  resolve(process.env.WRAITH_REPORT_DIR, 'driver.json'),
  JSON.stringify(
    {
      date: new Date().toISOString(),
      prototypes: ['parameter batching', 'bulk ASCII printing'],
      parameterSourceSha256: parameter.sourceSha256,
      generatedParserSha256: createHash('sha256').update(parameter.code).digest('hex'),
      driverSha256: createHash('sha256')
        .update(await readFile(fileURLToPath(import.meta.url)))
        .digest('hex'),
      installedInstances,
      allChecksPassed: true,
    },
    null,
    2,
  ) + '\n',
);
