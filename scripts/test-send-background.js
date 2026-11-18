'use strict';
// Run: PLAYWRIGHT_MODULE=/path/to/playwright node scripts/test-send-background.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const root = path.resolve(__dirname, '..');

async function waitForSenderReady(page) {
  await page.waitForFunction(() => typeof wasmReady !== 'undefined' && wasmReady);
}

async function runTargetSuite(browser, target, label, evidenceDir, offline) {
  const context = await browser.newContext({ offline, viewport: { width: 1440, height: 960 } });
  const errors = [];
  const attachErrorCollector = (p) => {
    p.on('pageerror', (err) => errors.push(String(err)));
  };

  try {
    const page = await context.newPage();
    attachErrorCollector(page);
    await page.goto(target);
    await waitForSenderReady(page);

    // 1. Default state is dark background
    const initial = await page.evaluate(() => ({
      hasWhiteClass: document.body.classList.contains('white-bg'),
      currentBackground,
      buttonText: $('btnBackground').textContent,
      buttonTitle: $('btnBackground').title,
      buttonAria: $('btnBackground').getAttribute('aria-label'),
      stored: localStorage.getItem(BACKGROUND_STORAGE_KEY),
    }));
    assert.equal(initial.hasWhiteClass, false, `${label}: default should be dark`);
    assert.equal(initial.currentBackground, 'dark', `${label}: initial state should be dark`);
    assert.equal(initial.buttonText, 'White bg', `${label}: button should offer White bg`);
    assert.ok(initial.buttonTitle.includes('white background'), `${label}: title should describe switching to white`);
    assert.equal(initial.buttonAria, initial.buttonTitle, `${label}: aria-label should match title`);
    assert.equal(initial.stored, null, `${label}: startup must not write storage before user toggles`);

    // 2. Toggle to white background & verify styles + storage
    await page.click('#btnBackground');
    await page.waitForTimeout(250);
    const toggledWhite = await page.evaluate(() => ({
      hasWhiteClass: document.body.classList.contains('white-bg'),
      currentBackground,
      bodyBg: getComputedStyle(document.body).backgroundColor,
      headerBg: getComputedStyle($('header')).backgroundColor,
      headerHeight: Math.round($('header').getBoundingClientRect().height),
      dropzoneBg: getComputedStyle($('dropzone')).backgroundColor,
      buttonText: $('btnBackground').textContent,
      buttonTitle: $('btnBackground').title,
      stored: localStorage.getItem(BACKGROUND_STORAGE_KEY),
    }));
    assert.equal(toggledWhite.hasWhiteClass, true, `${label}: body.white-bg must be applied`);
    assert.equal(toggledWhite.currentBackground, 'white');
    assert.equal(toggledWhite.bodyBg, 'rgb(255, 255, 255)', `${label}: body background must be pure white`);
    assert.ok(toggledWhite.headerHeight <= 56, `${label}: header must stay single-row at 1440px width (got ${toggledWhite.headerHeight}px)`);
    assert.equal(toggledWhite.buttonText, 'Dark bg', `${label}: button should offer Dark bg`);
    assert.equal(toggledWhite.buttonTitle, 'Switch to dark background');
    assert.equal(toggledWhite.stored, 'white', `${label}: white setting must persist in localStorage`);

    await page.screenshot({ path: path.join(evidenceDir, `${label}-idle-white.png`), fullPage: true });

    // 3. Reloading AND opening a brand-new tab preserves white background
    await page.reload();
    await waitForSenderReady(page);
    const afterReload = await page.evaluate(() => ({
      hasWhiteClass: document.body.classList.contains('white-bg'),
      bodyBg: getComputedStyle(document.body).backgroundColor,
      buttonText: $('btnBackground').textContent,
    }));
    assert.deepEqual(afterReload, {
      hasWhiteClass: true,
      bodyBg: 'rgb(255, 255, 255)',
      buttonText: 'Dark bg',
    }, `${label}: reload must preserve white background`);

    const reopened = await context.newPage();
    attachErrorCollector(reopened);
    await reopened.goto(target);
    await waitForSenderReady(reopened);
    const afterReopen = await reopened.evaluate(() => ({
      hasWhiteClass: document.body.classList.contains('white-bg'),
      bodyBg: getComputedStyle(document.body).backgroundColor,
      buttonText: $('btnBackground').textContent,
    }));
    assert.deepEqual(afterReopen, {
      hasWhiteClass: true,
      bodyBg: 'rgb(255, 255, 255)',
      buttonText: 'Dark bg',
    }, `${label}: reopening page must preserve white background`);
    await reopened.close();

    // 4. Language switching keeps background button labels synchronized in both modes
    await page.click('#btnLanguage');
    const zhWhite = await page.evaluate(() => ({
      text: $('btnBackground').textContent,
      title: $('btnBackground').title,
      aria: $('btnBackground').getAttribute('aria-label'),
    }));
    assert.equal(zhWhite.text, '深色背景');
    assert.equal(zhWhite.title, '切换为深色背景');
    assert.equal(zhWhite.aria, '切换为深色背景');

    await page.click('#btnBackground');
    const zhDark = await page.evaluate(() => ({
      hasWhiteClass: document.body.classList.contains('white-bg'),
      text: $('btnBackground').textContent,
      title: $('btnBackground').title,
      stored: localStorage.getItem(BACKGROUND_STORAGE_KEY),
    }));
    assert.equal(zhDark.hasWhiteClass, false);
    assert.equal(zhDark.text, '白色背景');
    assert.ok(zhDark.title.includes('白色背景'));
    assert.equal(zhDark.stored, 'dark');

    await page.reload();
    await waitForSenderReady(page);
    const afterDarkReload = await page.evaluate(() => ({
      hasWhiteClass: document.body.classList.contains('white-bg'),
      locale: currentLocale,
      text: $('btnBackground').textContent,
    }));
    assert.deepEqual(afterDarkReload, {
      hasWhiteClass: false,
      locale: 'zh-CN',
      text: '白色背景',
    }, `${label}: reload after switching back to dark must stay dark`);

    // Switch back to English + white background for active transfer / layout / fullscreen checks
    await page.click('#btnLanguage');
    await page.click('#btnBackground');

    // 5. Paste while #btnBackground is focused still stages clipboard content
    const pasteHandled = await page.evaluate(async () => {
      $('btnClearBundle').click();
      $('btnBackground').focus();
      const data = new DataTransfer();
      data.setData('text/plain', 'paste from background button focus');
      const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
      document.activeElement.dispatchEvent(event);
      await new Promise((r) => setTimeout(r, 30));
      const count = State.bundleItems.length;
      $('btnClearBundle').click();
      return { prevented: event.defaultPrevented, count };
    });
    assert.deepEqual(pasteHandled, { prevented: true, count: 1 }, `${label}: paste from #btnBackground focus must stage`);

    // 6. Active multi-chunk transfer: live toggle, quiet zone, aspect ratio, chunk states, and fullscreen white background
    await page.evaluate(async () => {
      $('chunkSize').disabled = false;
      $('chunkSize').value = '5242880'; // 5 MB -> 6 MB file produces manifest + 2 chunks
      const payload = new Uint8Array(6 * 1024 * 1024);
      for (let i = 0; i < payload.length; i += 4096) payload[i] = (i >> 12) & 0xff;
      await prepareFile(new File([payload], 'scan-test.bin', { type: 'application/octet-stream' }));
      startTransmission();
      // Exercise completed + locked + active states on jump buttons + open debug log
      State.completedChunks.add(0);
      lockChunk(1);
      $('log').classList.add('active');
    });
    await page.waitForFunction(() => State.active && State.totalFramesSent >= 2);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

    const activeLayout = await page.evaluate(() => {
      const center = $('center');
      const canvas = $('canvas');
      const main = $('main');
      const left = $('left-panel');
      const right = $('right-panel');
      const centerRect = center.getBoundingClientRect();
      const canvasRect = canvas.getBoundingClientRect();
      const mainRect = main.getBoundingClientRect();
      return {
        centerBg: getComputedStyle(center).backgroundColor,
        sideBg: getComputedStyle(left).backgroundColor,
        canvasW: Math.round(canvasRect.width),
        canvasH: Math.round(canvasRect.height),
        quietTop: Math.round(canvasRect.top - centerRect.top),
        quietBottom: Math.round(centerRect.bottom - canvasRect.bottom),
        quietLeft: Math.round(canvasRect.left - centerRect.left),
        quietRight: Math.round(centerRect.right - canvasRect.right),
        leftWidth: Math.round(left.getBoundingClientRect().width),
        rightWidth: Math.round(right.getBoundingClientRect().width),
        fitsMainHeight: Math.round(centerRect.height) <= Math.round(mainRect.height),
        completedBtnBg: getComputedStyle(document.querySelector('#chunkJumpBar button[data-idx="0"]')).backgroundColor,
        activeLockedBtnBg: getComputedStyle(document.querySelector('#chunkJumpBar button[data-idx="1"]')).backgroundColor,
        idleBtnBg: getComputedStyle(document.querySelector('#chunkJumpBar button[data-idx="2"]')).backgroundColor,
      };
    });

    assert.equal(activeLayout.centerBg, 'rgb(255, 255, 255)', `${label}: #center must be pure white`);
    assert.equal(activeLayout.canvasW, activeLayout.canvasH, `${label}: Mode B canvas must remain 1:1 square`);
    assert.ok(activeLayout.quietTop >= 12 && activeLayout.quietBottom >= 12, `${label}: vertical white quiet zone >= 12px`);
    assert.ok(activeLayout.quietLeft >= 12 && activeLayout.quietRight >= 12, `${label}: horizontal white quiet zone >= 12px`);
    assert.ok(activeLayout.leftWidth >= 120 && activeLayout.rightWidth >= 120, `${label}: side panels keep min width`);
    assert.ok(activeLayout.fitsMainHeight, `${label}: #center must not overflow #main`);
    assert.notEqual(activeLayout.completedBtnBg, activeLayout.idleBtnBg, `${label}: completed chunk button must stay visually distinct`);
    assert.notEqual(activeLayout.activeLockedBtnBg, activeLayout.idleBtnBg, `${label}: active+locked chunk button must stay visually distinct`);

    await page.screenshot({ path: path.join(evidenceDir, `${label}-active-white.png`), fullPage: true });

    // Live toggle to dark and back to white during active transmission must not stop frames
    const liveToggle = await page.evaluate(async () => {
      const before = State.totalFramesSent;
      $('btnBackground').click(); // -> dark
      await new Promise((r) => setTimeout(r, 90));
      const darkHasClass = document.body.classList.contains('white-bg');
      $('btnBackground').click(); // -> white
      await new Promise((r) => setTimeout(r, 90));
      return {
        active: State.active,
        darkHasClass,
        whiteHasClass: document.body.classList.contains('white-bg'),
        framesAdvanced: State.totalFramesSent > before,
      };
    });
    assert.deepEqual(liveToggle, {
      active: true,
      darkHasClass: false,
      whiteHasClass: true,
      framesAdvanced: true,
    }, `${label}: live background toggle must keep transmission running`);

    // 7. Fullscreen white background & exit padding cleanup
    const fullscreenCheck = await page.evaluate(async () => {
      const center = $('center');
      const canvas = $('canvas');
      const hud = $('fullscreenHud');
      // Simulate active fullscreen state deterministically in headless Chromium
      const origFsEl = Object.getOwnPropertyDescriptor(Document.prototype, 'fullscreenElement');
      let fsTarget = center;
      Object.defineProperty(document, 'fullscreenElement', {
        configurable: true,
        get: () => fsTarget,
      });
      try {
        handleFullscreenChange();
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const fsBg = getComputedStyle(center).backgroundColor;
        const hudBg = getComputedStyle(hud).backgroundColor;
        const padTop = parseFloat(getComputedStyle(center).paddingTop);
        const padLeft = parseFloat(getComputedStyle(center).paddingLeft);
        const padBottom = parseFloat(getComputedStyle(center).paddingBottom);
        const inlinePadBottomDuringFs = center.style.paddingBottom;
        const cw = parseFloat(canvas.style.width);
        const ch = parseFloat(canvas.style.height);

        // Simulate resize firing BEFORE fullscreenchange when exiting fullscreen
        fsTarget = null;
        fitCanvas();
        const inlinePadAfterResizeBeforeEvent = center.style.paddingBottom;
        const normalPadBottom = parseFloat(getComputedStyle(center).paddingBottom);
        handleFullscreenChange();

        return {
          fsBg,
          hudBg,
          padTop,
          padLeft,
          padBottom,
          hasInlineReserve: inlinePadBottomDuringFs !== '',
          squareInFs: cw === ch && cw >= 80,
          inlinePadAfterResizeBeforeEvent,
          normalPadBottom,
        };
      } finally {
        if (origFsEl) Object.defineProperty(document, 'fullscreenElement', origFsEl);
        else delete document.fullscreenElement;
      }
    });

    assert.equal(fullscreenCheck.fsBg, 'rgb(255, 255, 255)', `${label}: fullscreen #center must be pure white in white-bg mode`);
    assert.ok(fullscreenCheck.padTop >= 16 && fullscreenCheck.padLeft >= 16, `${label}: fullscreen white quiet zone >= 16px`);
    assert.ok(fullscreenCheck.padBottom >= 64 && fullscreenCheck.hasInlineReserve, `${label}: fullscreen HUD reserve preserved`);
    assert.ok(fullscreenCheck.squareInFs, `${label}: fullscreen canvas stays square`);
    assert.equal(fullscreenCheck.inlinePadAfterResizeBeforeEvent, '', `${label}: fitCanvas clears stale fullscreen inline paddingBottom`);
    assert.equal(fullscreenCheck.normalPadBottom, 12, `${label}: normal white-bg padding restored after fullscreen exit`);

    // 8. Storage fallback resilience (throwing getItem/setItem + legacy 'light' alias)
    const storageEdge = await page.evaluate(() => {
      stopTransmission();
      localStorage.setItem(BACKGROUND_STORAGE_KEY, 'light');
      const aliasResult = readStoredBackground();
      localStorage.setItem(BACKGROUND_STORAGE_KEY, 'unexpected');
      const invalidResult = readStoredBackground();

      const origSet = Storage.prototype.setItem;
      const origGet = Storage.prototype.getItem;
      Storage.prototype.setItem = () => { throw new Error('blocked'); };
      Storage.prototype.getItem = () => { throw new Error('blocked'); };
      try {
        const blockedRead = readStoredBackground();
        applyBackground('dark', true);
        const switchedDark = !document.body.classList.contains('white-bg');
        applyBackground('white', true);
        const switchedWhite = document.body.classList.contains('white-bg');
        return { aliasResult, invalidResult, blockedRead, switchedDark, switchedWhite };
      } finally {
        Storage.prototype.setItem = origSet;
        Storage.prototype.getItem = origGet;
      }
    });
    assert.deepEqual(storageEdge, {
      aliasResult: 'white',
      invalidResult: 'dark',
      blockedRead: 'dark',
      switchedDark: true,
      switchedWhite: true,
    }, `${label}: storage fallback and alias handling must succeed`);

    assert.deepEqual(errors, [], `${label}: unexpected page errors`);
  } finally {
    await context.close();
  }
}

async function main() {
  const server = http.createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, 'http://localhost').pathname;
      const file = path.resolve(root, '.' + decodeURIComponent(pathname));
      if (!file.startsWith(root + path.sep)) { response.writeHead(403).end(); return; }
      const bytes = await fs.promises.readFile(file);
      const type = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm' }[path.extname(file)] || 'application/octet-stream';
      response.writeHead(200, { 'Content-Type': type });
      response.end(bytes);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const evidenceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cimbar-background-'));
    const httpUrl = `http://127.0.0.1:${server.address().port}/send.html`;
    const fileUrl = pathToFileURL(path.join(root, 'send.standalone.html')).href;

    await runTargetSuite(browser, httpUrl, 'source', evidenceDir, false);
    await runTargetSuite(browser, fileUrl, 'standalone', evidenceDir, true);
    console.log(JSON.stringify({ status: 'PASS', targets: ['source', 'standalone'], screenshots: evidenceDir }));
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
