const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const chalk = require('chalk');
const fs = require('fs');
const path = require('path');
const http = require('http');

// Palet console: ok=hijau, err=merah, g=[Google] biru, api=[API] magenta,
// r9=[9Router] cyan, t=timer kuning, b=bold, dim=abu-abu.
const C = {
  ok: (s) => chalk.green(s),
  err: (s) => chalk.red(s),
  g: (s) => chalk.blue(s),
  api: (s) => chalk.magenta(s),
  r9: (s) => chalk.cyan(s),
  t: (s) => chalk.yellow(s),
  b: (s) => chalk.bold(s),
  dim: (s) => chalk.gray(s),
};

const stealth = StealthPlugin();
stealth.enabledEvasions.delete('navigator.webdriver');
puppeteer.use(stealth);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

const ROUTER_URL = 'http://localhost:20128';
const ROUTER_PASSWORD = '123456';
const REDIRECT_URI = `${ROUTER_URL}/callback`;
const AKUN_FILE = path.join(__dirname, 'akun.txt');
const PROFILE_BASE = path.join(__dirname, 'profiles');
const CONCURRENCY = 5;

function sanitizeEmail(email) {
  return email.toLowerCase().replace(/[^a-z0-9@._-]/g, '_');
}

function getProfileDir(email) {
  const dir = path.join(PROFILE_BASE, sanitizeEmail(email));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  seedProfilePrefs(dir);
  return dir;
}
function seedProfilePrefs(profileDir) {
  const prefFile = path.join(profileDir, 'Preferences');
  if (fs.existsSync(prefFile)) return;
  const prefs = {
    signin: { allowed: false },
    profile: { password_manager_enabled: false },
    credentials_enable_service: false,
  };
  try {
    fs.writeFileSync(prefFile, JSON.stringify(prefs));
  } catch {}
}

function detectBrowser() {
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    `${process.env.LOCALAPPDATA}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`,
    'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  ];

  for (const p of candidates) {
    try {
      if (p && fs.existsSync(p)) {
        const name = p.includes('chrome') || p.includes('Chrome') ? 'Chrome'
          : p.includes('edge') || p.includes('Edge') ? 'Edge'
          : p.includes('rave') ? 'Brave'
          : p.includes('chromium') ? 'Chromium' : 'Browser';
        return { path: p, name };
      }
    } catch {}
  }

  return { path: null, name: 'Chromium (bundled)' };
}

function buildLaunchOptions(browserInfo, profileDir) {
  const options = {
    headless: false,
    defaultViewport: { width: 1366, height: 768 },
    userDataDir: profileDir,
    args: [
      '--window-size=1366,768',
      '--no-default-browser-check',
      '--no-first-run',
      '--disable-dev-shm-usage',
      '--disable-sync',
      '--disable-translate',
      '--disable-extensions',
      '--lang=en-US,en',
    ],
    ignoreDefaultArgs: ['--enable-automation'],
  };

  if (browserInfo.path) {
    options.executablePath = browserInfo.path;
  }

  return options;
}

async function clickByText(page, texts, exclude = []) {
  try {
    return await page.evaluate((texts, exclude) => {
      const btns = Array.from(document.querySelectorAll('button, input[type="submit"], div[role="button"], a'));
      for (const t of texts) {
        const lower = t.toLowerCase();
        for (const b of btns) {
          const txt = (b.innerText || b.value || '').toLowerCase().trim();
          if (!txt.includes(lower)) continue;
          if (exclude.some((x) => txt.includes(x.toLowerCase()))) continue;
          b.click();
          return true;
        }
      }
      return false;
    }, texts, exclude);
  } catch {
    return false;
  }
}

async function dismissChromeSigninPopup(page) {
  return clickByText(page, ['Use Chrome without an account', 'Gunakan Chrome tanpa akun']);
}

async function clickAccountTile(page, email) {
  try {
    return await page.evaluate((email) => {
      const needle = email.toLowerCase();
      const els = Array.from(document.querySelectorAll('div, li, button, a')).reverse();
      for (const el of els) {
        const txt = (el.innerText || '').toLowerCase();
        if (!txt.includes(needle)) continue;
        // pastikan elemen terlihat
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        const clickable = el.closest('button, a, div[role="button"], div[role="link"]') || el;
        clickable.click();
        return true;
      }
      return false;
    }, email);
  } catch {
    return false;
  }
}

async function clickUnknownNext(page) {
  if (!(await isUnknownErrorPage(page))) return false;
  return clickByText(page, ['Next', 'Berikutnya']);
}

async function clickGoogleSignin(page) {
  try {
    return await page.evaluate(() => {
      const spans = Array.from(document.querySelectorAll('span.VfPpkd-vQzf8d'));
      for (const s of spans) {
        if ((s.innerText || '').trim().toLowerCase() !== 'sign in') continue;
        const btn = s.closest('button') || s;
        const r = btn.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        btn.click();
        return true;
      }
      return false;
    });
  } catch {
    return false;
  }
}

async function clickConsentApprove(page) {
  if (await clickGoogleSignin(page)) return true;
  if (await clickFirst(page, ['#gaplustosNext button', '#gaplustosNext'])) return true;
  if (await clickByText(page, ['I understand', 'Saya mengerti'])) return true;
  if (await clickFirst(page, ['#submit_approve_access button', '#submit_approve_access'])) return true;
  if (await clickByText(page, ['Allow', 'Izinkan'])) return true;
  if (await clickByText(page, ['Continue', 'Lanjutkan', 'Sign in', 'Masuk'], ['Continue as', 'Lanjutkan sebagai'])) return true;
  return false;
}

async function clickFirst(page, selectors) {
  for (const sel of selectors) {
    try {
      const el = await page.$(sel);
      if (el) {
        await el.click();
        return true;
      }
    } catch {}
  }
  return false;
}

async function isBlockedPage(page) {
  try {
    const text = await page.evaluate(() => document.body ? document.body.innerText : '');
    return /this browser or app may not be secure|couldn.?t sign you in/i.test(text || '');
  } catch {
    return false;
  }
}

async function isUnknownErrorPage(page) {
  try {
    const url = page.url();
    if (url.includes('/unknownerror')) return true;
    const text = await page.evaluate(() => document.body ? document.body.innerText : '');
    return /something went wrong/i.test(text || '');
  } catch {
    return false;
  }
}

function request(method, urlStr, { body, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(cookie ? { Cookie: cookie } : {}),
      },
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        const cookies = res.headers['set-cookie'] || [];
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data), cookies });
        } catch {
          resolve({ status: res.statusCode, data, cookies });
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function extractAuthCookie(cookies) {
  for (const c of cookies) {
    const match = c.match(/auth_token=([^;]+)/);
    if (match) return `auth_token=${match[1]}`;
  }
  return null;
}

function readAccounts() {
  if (!fs.existsSync(AKUN_FILE)) return [];
  const content = fs.readFileSync(AKUN_FILE, 'utf-8').trim();
  if (!content) return [];
  return content
    .split('\n')
    .map((line) => {
      const [email, password] = line.trim().split('|');
      return { email, password, raw: line.trim() };
    })
    .filter((a) => a.email && a.password);
}

function removeAccount(rawLine) {
  const content = fs.readFileSync(AKUN_FILE, 'utf-8');
  const lines = content.split('\n').filter((l) => l.trim() !== rawLine);
  fs.writeFileSync(AKUN_FILE, lines.join('\n'));
}

async function routerLogin() {
  console.log(C.r9('[9Router] Login...'));
  const res = await request('POST', `${ROUTER_URL}/api/auth/login`, {
    body: { password: ROUTER_PASSWORD },
  });

  if (res.status !== 200 || !res.data?.success) {
    throw new Error(`Login 9Router gagal: ${JSON.stringify(res.data)}`);
  }

  const cookie = extractAuthCookie(res.cookies);
  if (!cookie) {
    throw new Error('Cookie auth_token tidak ditemukan di response');
  }

  console.log(C.ok('[9Router] ✓ Login berhasil'));
  return cookie;
}

async function startOAuth(cookie) {
  const url = `${ROUTER_URL}/api/oauth/antigravity/authorize?redirect_uri=${encodeURIComponent(REDIRECT_URI)}`;
  const res = await request('GET', url, { cookie });

  if (res.status !== 200) {
    throw new Error(`Start OAuth gagal (${res.status}): ${JSON.stringify(res.data)}`);
  }

  const { authUrl, codeVerifier, state } = res.data;
  if (!authUrl || !codeVerifier || !state) {
    throw new Error(`Response OAuth tidak lengkap: ${JSON.stringify(res.data)}`);
  }

  return { authUrl, codeVerifier, state };
}

async function exchangeToken(cookie, { code, codeVerifier, state }) {
  const res = await request('POST', `${ROUTER_URL}/api/oauth/antigravity/exchange`, {
    cookie,
    body: { code, redirectUri: REDIRECT_URI, codeVerifier, state },
  });

  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`Exchange token gagal (${res.status}): ${JSON.stringify(res.data)}`);
  }

  return res.data;
}

async function googleLogin(browser, authUrl, email, password) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();

  try {
    let authCode = null;

    await page.setRequestInterception(true);
    const onRequest = (req) => {
      try {
        try {
          if (typeof req.isInterceptResolutionHandled === 'function' && req.isInterceptResolutionHandled()) return;
        } catch {}
        const reqUrl = req.url();

        if (reqUrl.startsWith(REDIRECT_URI)) {
          const url = new URL(reqUrl);
          authCode = url.searchParams.get('code');
          req.abort().catch(() => {});
          return;
        }

        const type = req.resourceType();
        if (['image', 'font', 'media'].includes(type)) {
          req.abort().catch(() => {});
          return;
        }

        req.continue().catch(() => {});
      } catch {}
    };
    page.on('request', onRequest);

    await page.goto(authUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

    if (authCode) {
      console.log(C.ok(`  [Google] ✓ Auth code (auto-redirect, sesi profile masih valid)`));
      return authCode;
    }

    if (await isBlockedPage(page)) {
      const debugFile = path.join(__dirname, `debug-${email.split('@')[0]}-blocked.png`);
      await page.screenshot({ path: debugFile, fullPage: true });
      throw new Error(
        'Google menolak browser ("This browser or app may not be secure"). ' +
        `Profile: ${getProfileDir(email)} masih baru/belum dipercaya. ` +
        `Solusi: biarkan browser terbuka, login manual sekali di profile itu, lalu re-run. Screenshot: ${debugFile}`
      );
    }

    console.log(C.g(`  [Google] Email...`));
    await page.waitForSelector('#identifierId', { visible: true, timeout: 15000 });
    await sleep(rand(800, 1800));
    await page.click('#identifierId', { clickCount: 3 }).catch(() => {});
    await page.type('#identifierId', email, { delay: rand(30, 80) });
    await sleep(rand(600, 1400));
    await page.keyboard.press('Enter');

    console.log(C.g(`  [Google] Password...`));
    await sleep(rand(2000, 3500));

    if (await isBlockedPage(page)) {
      const debugFile = path.join(__dirname, `debug-${email.split('@')[0]}-blocked.png`);
      await page.screenshot({ path: debugFile, fullPage: true });
      throw new Error(
        'Google menolak setelah input email ("browser may not be secure"). ' +
        'Jangan spam retry. Buka profile yang sama secara manual, login 1x, verifikasi, lalu re-run.'
      );
    }

    for (let attempt = 0; attempt < 12; attempt++) {
      const url = page.url();
      if (!url.includes('/identifier') || url.includes('/challenge') || url.includes('/pwd')) break;
      if (await isBlockedPage(page)) break;
      const pwdEl = await page.$('input[type="password"]');
      if (pwdEl) break;
      await sleep(1000);
    }

    const pwdSelectors = [
      'input[type="password"][name="Passwd"]',
      'input[type="password"]',
      '#password input',
      'input[name="Passwd"]',
    ];

    let pwdField = null;
    for (const sel of pwdSelectors) {
      try {
        pwdField = await page.waitForSelector(sel, { visible: true, timeout: 5000 });
        if (pwdField) break;
      } catch {}
    }

    if (!pwdField) {
      if (await isBlockedPage(page)) {
        const debugFile = path.join(__dirname, `debug-${email.split('@')[0]}-blocked.png`);
        await page.screenshot({ path: debugFile, fullPage: true });
        throw new Error(`Diblokir Google sebelum halaman password. Screenshot: ${debugFile}`);
      }
      const debugFile = path.join(__dirname, `debug-${email.split('@')[0]}.png`);
      await page.screenshot({ path: debugFile, fullPage: true });
      console.log(C.dim(`  [DEBUG] URL: ${page.url()}`));
      console.log(C.dim(`  [DEBUG] Screenshot: ${debugFile}`));
      throw new Error('Password field tidak ditemukan — cek screenshot');
    }

    await sleep(rand(600, 1400));
    await pwdField.type(password, { delay: rand(30, 80) });
    await sleep(rand(600, 1400));
    await page.keyboard.press('Enter');

    console.log(C.g(`  [Google] Consent...`));

    const consentDeadline = Date.now() + 90000;
    let consented = false;
    while (!authCode && Date.now() < consentDeadline) {
      try {
        const currentUrl = page.url();
        if (currentUrl.startsWith(REDIRECT_URI)) {
          authCode = new URL(currentUrl).searchParams.get('code');
          if (authCode) break;
        }
      } catch {}

      if (await isBlockedPage(page)) {
        const debugFile = path.join(__dirname, `debug-${email.split('@')[0]}-blocked.png`);
        await page.screenshot({ path: debugFile, fullPage: true });
        throw new Error(`Diblokir Google saat consent. Screenshot: ${debugFile}`);
      }

      if (await dismissChromeSigninPopup(page)) {
        await sleep(1500);
        continue;
      }
      if (await clickConsentApprove(page)) {
        consented = true;
        await sleep(1500);
        continue;
      }
      if (!consented && await clickAccountTile(page, email)) {
        await sleep(2000);
        continue;
      }
      if (await clickUnknownNext(page)) {
        await sleep(2500);
        continue;
      }
      await sleep(1000);
    }

    if (!authCode) {
      try {
        const currentUrl = page.url();
        if (currentUrl.startsWith(REDIRECT_URI)) {
          authCode = new URL(currentUrl).searchParams.get('code');
        }
      } catch {}
    }

    if (!authCode) {
      const debugFile = path.join(__dirname, `debug-${email.split('@')[0]}.png`);
      try { await page.screenshot({ path: debugFile, fullPage: true }); } catch {}
      console.log(C.dim(`  [DEBUG] URL terakhir: ${page.url()}`));
      throw new Error(`Auth code tidak ter-capture (timeout 90s). Screenshot: ${debugFile}`);
    }

    console.log(C.ok(`  [Google] ✓ Auth code didapat`));
    return authCode;
  } finally {
    try { page.off('request', onRequest); } catch {}
    try { await page.setRequestInterception(false); } catch {}
    try { await page.close({ runBeforeUnload: false }); } catch {}
    try { await context.close(); } catch {}
  }
}

async function loginAccount(browser, cookie, account, index, total) {
  const { email, password } = account;
  const t0 = Date.now();
  console.log(C.b(`\n[${index + 1}/${total}] ${email}`));

  console.log(C.api(`  [API] OAuth authorize...`));
  const { authUrl, codeVerifier, state } = await startOAuth(cookie);

  const authCode = await googleLogin(browser, authUrl, email, password);

  console.log(C.api(`  [API] Exchange token...`));
  const result = await exchangeToken(cookie, { code: authCode, codeVerifier, state });

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(C.ok(`[✓] ${email} — ${C.t(`${elapsed}s`)} (${result.connection?.id || 'OK'})`));
  removeAccount(account.raw);
  return true;
}

(async () => {
  const accounts = readAccounts();
  if (accounts.length === 0) {
    console.log(C.t('Tidak ada akun di akun.txt'));
    return;
  }

  console.log(C.b(`Total akun: ${accounts.length}`));

  const browser_info = detectBrowser();
  console.log(`Browser: ${browser_info.name}${browser_info.path ? ` (${browser_info.path})` : ''}`);
  console.log(`Mode: 1 browser + ${CONCURRENCY} incognito (stealth, tanpa jeda)`);
  console.log(C.dim(`Profiles: ${PROFILE_BASE}\n`));

  try {
    if (fs.existsSync(PROFILE_BASE)) {
      fs.rmSync(PROFILE_BASE, { recursive: true, force: true });
      console.log(C.ok(`[Cleanup] ✓ Sisa profiles/ lama dibersihkan`));
    }
  } catch (e) {
    console.warn(C.t(`[Cleanup] Gagal bersihkan profiles/: ${e.message}`));
  }

  if (!browser_info.path || browser_info.name.includes('bundled')) {
    console.warn(
      '[WARN] Chrome/Edge/Brave tidak ditemukan, fallback ke Chromium bundled. ' +
      'Sangat disarankan install Chrome stable terbaru agar lolos cek Google.'
    );
  }

  const cookie = await routerLogin();

  const runProfileDir = getProfileDir('shared-run');
  console.log(C.r9(`[Browser] Launching 1x: ${runProfileDir}`));
  const browser = await puppeteer.launch(buildLaunchOptions(browser_info, runProfileDir));

  let successCount = 0;
  let failCount = 0;
  const t0 = Date.now();

  try {
  for (let i = 0; i < accounts.length; i += CONCURRENCY) {
    const batch = accounts.slice(i, i + CONCURRENCY);

    const results = await Promise.all(batch.map(async (account, batchIdx) => {
      try {
        await loginAccount(browser, cookie, account, i + batchIdx, accounts.length);
        return true;
      } catch (error) {
        console.error(C.err(`[✗] ${account.email}: ${error.message}`));
        return false;
      }
    }));

    for (const ok of results) {
      if (ok) successCount++;
      else failCount++;
    }
  }
  } finally {
    try { await browser.close(); } catch {}
    console.log(C.ok(`\n[Browser] ✓ Ditutup`));
  }

  const totalTime = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(C.b(`\n========================================`));
  console.log(`Selesai dalam ${C.t(`${totalTime}s`)}`);
  console.log(`${C.ok(`Sukses: ${successCount}`)} | ${C.err(`Gagal: ${failCount}`)}`);
  console.log(C.b(`========================================`));

  try {
    if (fs.existsSync(PROFILE_BASE)) {
      fs.rmSync(PROFILE_BASE, { recursive: true, force: true });
      console.log(C.ok(`[Cleanup] ✓ Folder profiles/ dihapus`));
    }
  } catch (e) {
    console.warn(C.t(`[Cleanup] Gagal hapus profiles/: ${e.message}`));
  }
})();
