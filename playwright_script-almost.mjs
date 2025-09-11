// A Playwright script to automate booking a service on Housecall Pro.

import { chromium } from 'playwright';
import fs from 'fs/promises';
import path from 'path';
import * as pw from 'playwright-core';

/**
 * Generates a random delay between min and max milliseconds.
 */
function randomDelay(min, max) {
  const delay = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise(resolve => setTimeout(resolve, delay));
}

/**
 * ============================================
 * Configuration
 * ============================================
 */
const START_URL =
  'https://book.housecallpro.com/book/Portland-NW-Carpet-Cleaning/f504201a0f8e45f5924aa530d018c8b0?v2=true';

const PAYLOAD_JSON_STRING = process.env.PAYLOAD_JSON;

const SLOWMO = Number(process.env.SLOWMO || '0');
const KEEP_OPEN = process.env.KEEP_OPEN === '1';
const HEADLESS =
  process.env.HEADLESS === '1' ? true : process.env.HEADLESS === '0' ? false : false;

/** ======= Utils ======= */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[run]', ...a);
const warn = (...a) => console.warn('[warn]', ...a);
const errLog = (...a) => console.error('[err]', ...a);

function normInt(v) {
  if (v == null) return 0;
  const n = parseInt(String(v).trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * DEBUG HELPERS
 */

// Normalize time slot text
function normTimeText(s = '') {
  return String(s)
    .replace(/\u00A0|\u2009|\u200A|\u202F/g, ' ')  // various spaces -> space
    .replace(/[–—−]/g, '-')                       // dashes -> hyphen
    .replace(/\s+/g, ' ')                         // collapse spaces
    .trim();
}

// Dump time options within an optional scope
async function logTimeOptions(page, scopeLocator) {
  const btns = scopeLocator
    ? scopeLocator.locator('button').filter({ hasText: /(am|pm)\b/i })
    : page.locator('button').filter({ hasText: /(am|pm)\b/i });

  const texts = await btns.evaluateAll(nodes =>
    nodes.map(n => (n.textContent || '').trim())
  );

  const normalized = texts.map(normTimeText);
  console.log('[time] slots raw:', JSON.stringify(texts));
  console.log('[time] slots norm:', JSON.stringify(normalized));
  return { btns, texts, normalized };
}

// quick screenshot helper for failures
async function snap(page, tag) {
  try {
    const name = `${tag || 'snap'}-${Date.now()}.png`;
    await page.screenshot({ path: name, fullPage: true });
    console.log('[time] saved screenshot:', name);
  } catch {}
}

async function waitIdle(page, ms = 250) {
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await sleep(ms);
}

async function tryClick(page, variants, tag = 'click') {
  for (const v of variants) {
    try {
      let loc;
      if (typeof v === 'string') {
        loc = page.locator(v).first();
      } else if (v.role) {
        loc = page.getByRole(v.role, { name: v.name, exact: v.exact ?? false }).first();
      } else if (v.text) {
        loc = page.getByText(v.text).first();
      } else if (v.label) {
        loc = page.getByLabel(v.label).first();
      }
      if (!loc) continue;
      if ((await loc.count()) === 0) continue;
      await loc.scrollIntoViewIfNeeded().catch(() => {});
      await loc.click({ timeout: 3500 });
      return true;
    } catch {}
  }
  return false;
}

async function verifySuccess(page) {
  try {
    await page.getByText('Thank you').waitFor({ state: 'visible', timeout: 3000 });
    await page.getByText('Your booking was successful.').waitFor({ state: 'visible', timeout: 3000 });
    log('Successfully reached the "Thank you" confirmation page.');
    return true;
  } catch (e) {
    warn('Did not reach the "Thank you" confirmation page.');
    return false;
  }
}

async function setQty(page, qty) {
  if (!qty || qty <= 0) return false;
  const locs = [
    'input[type="number"]',
    'input[role="spinbutton"]',
    { label: /qty|quantity/i },
    { role: 'spinbutton', name: /qty|quantity/i },
  ];
  for (const v of locs) {
    try {
      const loc =
        typeof v === 'string'
          ? page.locator(v).first()
          : v.label
          ? page.getByLabel(v.label).first()
          : page.getByRole(v.role, { name: v.name }).first();
      if ((await loc.count()) === 0) continue;
      await loc.scrollIntoViewIfNeeded().catch(() => {});
      await loc.fill(String(qty), { timeout: 3000 });
      await page.keyboard.press('Tab').catch(() => {});
      return true;
    } catch {}
  }
  warn('Could not set quantity; proceeding.');
  return false;
}

/** ======= Main menu waits & service click ======= */
async function waitForMainMenu(page) {
  const candidates = [
    () => page.getByRole('button', { name: /carpet cleaning/i }),
    () => page.getByRole('button', { name: /upholstery/i }),
    () => page.getByRole('button', { name: /pet stain/i }),
    () => page.locator('.MuiCardActionArea-root:has-text("Carpet Cleaning")'),
    () => page.locator('.MuiCardActionArea-root:has-text("Upholstery")'),
    () => page.locator('.MuiCardActionArea-root:has-text("Pet Stain")'),
    () => page.getByText(/what can we do for you/i),
  ];

  const start = Date.now();
  const timeout = 15000;
  while (Date.now() - start < timeout) {
    for (const get of candidates) {
      try {
        const loc = get().first();
        if ((await loc.count()) > 0 && (await loc.isVisible())) return true;
      } catch {}
    }
    await sleep(200);
  }
  throw new Error('Service menu did not render.');
}

function escRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function clickService(page, label) {
  await waitForMainMenu(page);

  const re = new RegExp(`\\b${escRe(label)}\\b`, 'i');

  const candidates = [
    page.getByRole('button', { name: re }).first(),
    page.locator('button').filter({ hasText: re }).first(),
    page.locator('[role="button"]').filter({ hasText: re }).first(),
    page.locator('.MuiCardActionArea-root, .MuiButtonBase-root').filter({ hasText: re }).first(),
    // Click closest clickable ancestor of the visible text
    page.getByText(re).locator('xpath=ancestor-or-self::button[1]').first(),
    page.getByText(re).locator('xpath=ancestor::div[@role="button"][1]').first(),
    // As a last resort click the text itself
    page.getByText(re).first(),
  ];

  for (const loc of candidates) {
    try {
      if ((await loc.count()) === 0) continue;
      await loc.scrollIntoViewIfNeeded().catch(() => {});
      await loc.click({ timeout: 4000 });
      await waitIdle(page, 350);
      return true;
    } catch {}
  }

  const txts = await page.locator('button, [role="button"]').allInnerTexts().catch(() => []);
  warn('Clickable texts seen on page:', txts?.slice(0, 30));
  throw new Error(`Service button "${label}" not found`);
}

/** ======= Drawer/overlay handling ======= */
async function closeCartDrawerIfOpen(page) {
  const closed =
    (await tryClick(page, [{ role: 'button', name: /close|dismiss|x/i }], 'drawer-close')) ||
    (await tryClick(page, ['[aria-label="close"]', '[data-testid="CloseIcon"]'], 'drawer-close2')) ||
    (await tryClick(page, [{ text: /shopping cart|cart details/i }], 'click-away')) ||
    (await page.keyboard.press('Escape').then(() => true).catch(() => false));

  if (closed) await waitIdle(page, 200);
}

/** ======= Contact details & scheduling ======= */
async function fillContactDetails(page, p) {
  const { first_name, last_name, phone, email, street_address, city, state, zipcode } = p;

  log('[contact] Filling contact form...');

  if (first_name) await page.getByTestId('online-booking-contact-firstname').fill(first_name);
  if (last_name) await page.getByTestId('online-booking-contact-lastname').fill(last_name);
  if (phone) await page.getByTestId('online-booking-contact-phone').fill(phone);
  if (email) await page.getByTestId('online-booking-contact-email').fill(email);
  if (street_address) await page.getByTestId('online-booking-contact-street').fill(street_address);
  if (city) await page.getByTestId('online-booking-contact-city').fill(city);
  if (zipcode) await page.getByTestId('online-booking-contact-zip').fill(zipcode);

  if (state) {
    log(`[contact] Selecting state: ${state}`);
    const stateInput = page.getByTestId('online-booking-contact-state');
    await stateInput.click();
    await stateInput.type(state, { delay: 1000 });
    const option = page.getByRole('option', { name: new RegExp(state, 'i') }).first();
    await option.click();
  }

  log('[contact] Form filled.');
  await tryClick(page, [{ role: 'checkbox' }, 'input[type="checkbox"]'], 'consent');
}

function parseMMDDYYYY(s) {
  if (!s) return null;
  if (s.includes('/')) {
    const [mm, dd, yyyy] = s.split('/').map((x) => parseInt(x, 10));
    return { y: yyyy, m: mm, d: dd };
  }
  if (s.includes('-')) {
    const [yyyy, mm, dd] = s.split('-').map((x) => parseInt(x, 10));
    return { y: yyyy, m: mm, d: dd };
  }
  return null;
}

async function selectDate(page, dateStr) {
  const dt = parseMMDDYYYY(dateStr);
  if (!dt) {
    warn('Bad appointment_date; skip date selection.');
    return false;
  }

  const monthAbbr = new Date(dt.y, dt.m - 1, dt.d).toLocaleString('en-US', { month: 'short' });
  const dayRe = new RegExp(`${monthAbbr}\\s*${dt.d}(?:st|nd|rd|th)?`, 'i');

  // Prefer: BUTTON containing a matching day-card
  let target = page
    .locator('button')
    .filter({ has: page.locator('[data-testid^="day-card"]') })
    .filter({ hasText: dayRe })
    .first();

  // Fallback: click the day-card div (or its button ancestor)
  if ((await target.count()) === 0) {
    const card = page.locator('[data-testid^="day-card"]').filter({ hasText: dayRe }).first();
    if ((await card.count()) > 0) {
      const btnAncestor = card.locator('xpath=ancestor::button[1]');
      target = (await btnAncestor.count()) > 0 ? btnAncestor.first() : card.first();
    }
  }

  // Page forward a bit if necessary
  for (let i = 0; (await target.count()) === 0 && i < 6; i++) {
    const moved =
      (await tryClick(page, [{ role: 'button', name: /next/i }], 'cal-next')) ||
      (await tryClick(page, ['[aria-label*="Next"]', 'button:has([data-testid*="ChevronRight"])'], 'cal-next2'));
    if (!moved) break;
    await page.waitForTimeout(200);
    target = page
      .locator('button')
      .filter({ has: page.locator('[data-testid^="day-card"]') })
      .filter({ hasText: dayRe })
      .first();
  }

  if ((await target.count()) === 0) {
    warn('Could not pick date; We dont know why.');
    return false;
  }

  await target.scrollIntoViewIfNeeded().catch(() => {});
  try {
    await target.click({ timeout: 3000 });
  } catch {
    const box = await target.boundingBox();
    if (box) {
      await page.mouse.click(box.x + box.width / 2, box.y + Math.min(box.height / 2, 40));
    } else {
      throw new Error('Could not click date target.');
    }
  }

  await page.waitForTimeout(200);
  return true;
}

async function selectTimeFrame(page, startTimeStr) {
  // First, strip " AM" or " PM" from the input string to get just the time.
  const timeOnlyStr = startTimeStr.replace(/\s*(?:AM|PM)$/i, '');

  // Now, create a flexible regular expression that looks for the time followed by a hyphen.
  // We use `\s*` to allow for any whitespace between the time and the hyphen.
  const re = new RegExp(`^\\s*${escRe(timeOnlyStr)}\\s*-`, 'i');

  const ok = await tryClick(
    page,
    [
      // Prioritize finding a button with the specific role and name.
      { role: 'button', name: re },
      // Fallback to finding any element containing the text.
      { text: re }
    ],
    'timeframe'
  );

  if (!ok) {
    warn(`Could not select time frame starting "${startTimeStr}"`);
  }
}

/** ======= New per-service finalize flow ======= */
async function finalizeThisService(page, payload, { isLast }) {
  log('Starting finalizeThisService function...');
  await closeCartDrawerIfOpen(page);

  // 1) Add to booking (if present)
  log('Attempting to add to booking...');
  const added =
    (await tryClick(page, [{ role: 'button', name: /^add to booking$/i }], 'add-to-booking1')) ||
    (await tryClick(page, [{ role: 'button', name: /add\s*to\s*booking/i }, { text: /add to booking/i }], 'add-to-booking2'));
  if (!added) warn('No "Add to booking" visible—may be auto-added.');
  log('Add to booking step complete.');

  await waitIdle(page, 850);
  await closeCartDrawerIfOpen(page);

  // 2) Click "Book Service" to reach contacts
  log('Attempting to click "Book Service" or similar...');
  const booked =
    (await tryClick(page, [{ role: 'button', name: /book service/i }, { text: /book service/i }], 'book-service')) ||
    (await tryClick(page, [{ role: 'button', name: /book now|book my appointment|proceed/i }], 'book-alt'));
  if (!booked) {
    const cont = await tryClick(page, [{ role: 'button', name: /^continue$/i }, { text: /^continue$/i }], 'book-continue');
    if (!cont) {
      log('Could not reach contact details after adding a service.');
      throw new Error('Could not reach contact details after adding a service.');
    }
  }
  log('Book Service step complete.');
  await randomDelay(1000, 4500);

  if (!isLast) {
    log('Not last service, attempting to go back...');
    const back =
      (await tryClick(page, [{ role: 'button', name: /^back$/i }, { text: /^back$/i }], 'contacts-back')) ||
      (await tryClick(page, [{ role: 'button', name: /close|arrow|chevron/i }], 'contacts-back2')) ||
      (await page.goBack({ timeout: 1500 }).then(() => true).catch(() => false));
    if (!back) warn('No Back control found from contacts page.');
    await randomDelay(1000, 4500);

    const more =
      (await tryClick(page, [{ role: 'button', name: /add more services/i }, { text: /add more services/i }], 'add-more')) ||
      (await tryClick(page, [{ role: 'button', name: /add services/i }], 'add-services'));
    if (!more) warn('Could not click "Add more services"; continuing.');
    await randomDelay(1000, 4500);
    return;
  }

  // Last: fill details and schedule
  log('Filling contact details...');
  await fillContactDetails(page, payload);
  await waitIdle(page, 600);
  await randomDelay(1000, 4500);

  log('Attempting to submit contact details...');
  const submitted =
    (await tryClick(page, [{ role: 'button', name: /^submit$/i }, { text: /^submit$/i }], 'contacts-submit')) ||
    (await tryClick(page, [{ role: 'button', name: /continue|next/i }, { text: /continue|next/i }], 'contacts-next'));
  if (!submitted) {
    log('Could not submit contact details.');
    throw new Error('Could not submit contact details.');
  }
  log('Contact details submitted successfully.');

  await waitIdle(page, 1300);
  await randomDelay(1000, 4500);

  log('Attempting to select date...');
  if (payload.appointment_date) await selectDate(page, payload.appointment_date);
  log('Date selection complete.');
  await randomDelay(1000, 4500);

  log('Attempting to select time frame...');
  let picked = true;
  if (payload.time_frame_start) {
    picked = await selectTimeFrame(page, payload.time_frame_start);
  }
  log('Time frame selection complete.');
  await randomDelay(600, 1600);

  await tryClick(page, [{ role: 'button', name: /^next$/i }, { text: /^next$/i }], 'schedule-next');
	log('Next button clicked.'); 
  await waitIdle(page, 500);

  const finalBook =
    (await tryClick(page, [{ role: 'button', name: /book my appointment/i }, { text: /book my appointment/i }], 'final-book')) ||
    (await tryClick(page, [{ role: 'button', name: /book now|confirm|finish/i }, { text: /book now|confirm|finish/i }], 'final-book2'));
  if (!finalBook) warn('Final booking button not found.');


log('Clicked on final book button');
 await randomDelay(1000, 2000);
 
 try {
    await page.getByText('Thank you').waitFor({ state: 'visible', timeout: 3000 });
    log('Successfully reached the "Thank you" confirmation page.');
    return true;
  } catch (e) {
    warn('Did not reach the "Thank you" confirmation page.');
    return false;
  }
 
 
}

/** ======= Service handlers ======= */
async function handleCarpetCleaning(page, bedrooms, payload, meta) {
  await clickService(page, 'Carpet Cleaning');
  const map = {
    2: /two\s*\(\s*2\s*\)\s*bedrooms\s*house/i,
    3: /three\s*\(\s*3\s*\)\s*bedrooms\s*house/i,
    4: /four\s*\(\s*4\s*\)\s*bedrooms\s*house/i,
  };
  const want = map[Number(bedrooms)] || map[4];

  const picked = await tryClick(
    page,
    [
      { text: want },
      { role: 'button', name: want },
      `button:has-text("${bedrooms}")`,
      `button:has-text("${want}")`,
    ]
  );

  if (!picked) {
    throw new Error('Could not click bedrooms option.');
  }

  await waitIdle(page, 250);
  await randomDelay(1000, 4500);
  await finalizeThisService(page, payload, meta);
}

async function handlePetStain(page, payload, meta) {
  await clickService(page, 'Pet Stain');
  await randomDelay(1000, 4500);
  const addon =
    (await tryClick(page, [{ role: 'button', name: /add[-\s]*on:\s*pet urine.*stain/i }], 'ps-add1')) ||
    (await tryClick(page, [{ text: /add[-\s]*on:\s*pet urine.*stain/i }], 'ps-add2')) ||
    (await tryClick(page, [{ role: 'button', name: /pet urine.*stain/i }, { text: /pet urine.*stain/i }], 'ps-add3')) ||
    (await tryClick(page, ['button:has-text("Pet Urine")'], 'ps-add4'));
  if (!addon) warn('Pet Stain add-on button not found; continuing.');

  await waitIdle(page, 250);
  await finalizeThisService(page, payload, meta);
}

async function handleUpholstery(page, label, qty, payload, meta) {
  await clickService(page, 'Upholstery');

  const raw = (label || 'Love Seat').trim();
  const base = raw.replace(/clean(?:ing)?$/i, '').trim();
  const titleRe = new RegExp(
    `(?:${base.replace(/\s+/g, '\\s*')}|loveseat)\\s*(?:clean(?:ing)?)?`,
    'i'
  );

  let card = null;
  for (let i = 0; i < 6; i++) {
    const loc = page.locator('[data-testid="service-card"]', { hasText: titleRe }).first();
    if ((await loc.count()) > 0) { card = loc; break; }
    await page.mouse.wheel(0, 900).catch(() => {});
    await page.waitForTimeout(200);
  }
  if (!card) {
    throw new Error(`Could not find service card for "${raw}" (searched with ${titleRe}).`);
  }

  await card.scrollIntoViewIfNeeded().catch(() => {});
  let clicked = await card.click({ timeout: 3500 }).then(() => true).catch(() => false);
  if (!clicked) {
    const heading = card.locator('h1,h2,h3,h4,h5,h6').filter({ hasText: titleRe }).first();
    clicked = await heading.click({ timeout: 2500 }).then(() => true).catch(() => false);
  }
  if (!clicked) {
    try {
      const box = await card.boundingBox();
      if (box) {
        await page.mouse.click(box.x + box.width / 2, box.y + Math.min(box.height / 2, 40));
        clicked = true;
      }
    } catch {}
  }
  if (!clicked) throw new Error(`Found card for "${raw}" but couldn't click it.`);

  if (qty && qty > 1) {
    try { await setQty(page, qty); } catch {}
  }

  await page.waitForTimeout(200);
  await finalizeThisService(page, payload, meta);
}

async function handleCarpetStretching(page, payload, meta) {
  await clickService(page, 'Carpet Repair');

  const ok =
    (await tryClick(page, [{ role: 'button', name: /carpet stretching/i }], 'stretch1')) ||
    (await tryClick(page, [{ text: /carpet re-stretching/i }], 'stretch2'));
  if (!ok) warn('Could not click "Carpet Stretching".');

  await randomDelay(1000, 4500);
  await waitIdle(page, 250);
  await finalizeThisService(page, payload, meta);
}

/** ======= Queue builder ======= */
function buildQueue(p) {
  const q = [];

  if (p.carpet_cleaning) q.push({ type: 'carpet_cleaning', bedrooms: Number(p.bedrooms || 4) });
  if (p.pet_stain) q.push({ type: 'pet_stain' });

  if (p.upholstery) {
    const map = {
      love_seat: 'Love Seat',
      couch: 'Couch',
      recliner: 'Recliner',
      small_sectional: 'Small Sectional',
      medium_sectional: 'Medium Sectional',
      large_sectional: 'Large Sectional',
    };
    for (const [key, label] of Object.entries(map)) {
      const qty = normInt(p[key]);
      if (qty > 0) q.push({ type: 'upholstery', itemKey: key, label, qty });
    }
  }

  if (p.carpet_stretching) q.push({ type: 'carpet_stretching' });
  return q;
}

/** ======= Main ======= */
async function main() {
  const payload = JSON.parse(PAYLOAD_JSON_STRING || '{}');
  log('[loader] Using payload from environment variable');

  // Enhanced browser configuration to avoid CloudFront blocking
  const browser = await chromium.launch({ 
    headless: HEADLESS, 
    slowMo: SLOWMO,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-features=TranslateUI',
      '--disable-ipc-flooding-protection',
      '--disable-features=VizDisplayCompositor',
      '--disable-extensions',
      '--disable-default-apps',
      '--disable-sync',
      '--disable-translate',
      '--hide-scrollbars',
      '--mute-audio',
      '--no-default-browser-check',
      '--no-pings',
      '--password-store=basic',
      '--use-mock-keychain',
      '--disable-blink-features=AutomationControlled',
      '--disable-web-security',
      '--disable-features=VizDisplayCompositor'
    ]
  });

  const context = await browser.newContext({
    viewport: { width: 1366, height: 768 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    locale: 'en-US',
    timezoneId: 'America/Los_Angeles',
    permissions: ['geolocation'],
    geolocation: { latitude: 45.5231, longitude: -122.6765 },
    extraHTTPHeaders: {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'DNT': '1',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
      'Cache-Control': 'max-age=0'
    }
  });

  const page = await context.newPage();

  // Additional stealth measures
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    const originalQuery = window.navigator.permissions.query;
    window.navigator.permissions.query = (parameters) => (
      parameters.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission })
        : originalQuery(parameters)
    );
  });

  try {
    log('[nav]', START_URL);

    await page.route('**/*', (route) => {
      route.continue();
    });

    page.on('response', async (response) => {
      const url = response.url();
      const status = response.status();
      if (url.includes('cloudfront') || url.includes('amazonaws')) {
        log('[cloudfront] Response:', status, url);
        if (status === 403 || status === 429) {
          warn('[cloudfront] Blocked by CloudFront! Status:', status);
          const body = await response.text().catch(() => '');
          if (body.includes('Access Denied') || body.includes('Forbidden')) {
            errLog('[cloudfront] Access Denied response detected');
          }
        }
      }
    });

    await page.goto(START_URL, { waitUntil: 'load', timeout: 45000 });

    const pageContent = await page.content();
    if (pageContent.includes('Access Denied') || 
        pageContent.includes('Forbidden') || 
        pageContent.includes('CloudFront') ||
        pageContent.includes('403') ||
        pageContent.includes('blocked')) {
      errLog('[cloudfront] Page appears to be blocked by CloudFront');
      throw new Error('CloudFront blocking detected');
    }

    await waitIdle(page, 600);
    await randomDelay(1000, 4500);

    const queue = buildQueue(payload);
    log('[queue]', queue);

    for (let i = 0; i < queue.length; i++) {
      const item = queue[i];
      const meta = { isLast: i === queue.length - 1 };
      log(`[task ${i + 1}/${queue.length}]`, item, meta);

      if (item.type === 'carpet_cleaning') {
        await handleCarpetCleaning(page, item.bedrooms, payload, meta);
      } else if (item.type === 'pet_stain') {
        await handlePetStain(page, payload, meta);
      } else if (item.type === 'upholstery') {
        await handleUpholstery(page, item.label, item.qty, payload, meta);
      } else if (item.type === 'carpet_stretching') {
        await handleCarpetStretching(page, payload, meta);
      } else {
        warn('Unknown task type', item.type);
      }
      await waitIdle(page, 350);
      await randomDelay(1000, 4500);
    }

    log('All tasks processed.');
    if (!KEEP_OPEN) {
      await context.close();
      await browser.close();
    } else {
      log('KEEP_OPEN=1 set: leaving browser open.');
    }
  } catch (e) {
    errLog('fatal', e);
    try {
      const fname = `error-${Date.now()}.png`;
      await page.screenshot({ path: fname, fullPage: true });
      log('Saved error screenshot:', fname);
    } catch {}
    if (!KEEP_OPEN) {
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
    } else {
      log('KEEP_OPEN=1 set: leaving browser open after error.');
    }
    process.exitCode = 1;
  }
}

main();
