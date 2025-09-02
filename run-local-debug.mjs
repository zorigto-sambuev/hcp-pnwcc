

// run-local-debug.mjs
import { chromium } from 'playwright';
import fs from 'fs/promises';
import path from 'path';
import { selectArrivalWindowByStart } from 'https://github.com/craigneil/hcp-pnwcc/blob/main/arrival-window-patch.mjs';


/** ======= Config ======= */
const START_URL =
  'https://book.housecallpro.com/book/Portland-NW-Carpet-Cleaning/f504201a0f8e45f5924aa530d018c8b0?v2=true';
const PAYLOAD_PATH = process.env.PAYLOAD || path.resolve('./payload.json');

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

async function run() {
  const bcatUrl = 'wss://api.browsercat.com/connect';
  const browser = await pw.chromium.connect(bcatUrl, {
    headers: {'Api-Key': '31H7FOtoqgQqRDXY16E8FOnDvMERngkVUxveZITLxJ0wyroLDInJxyVF7G4F3hDy'},
  });

// --- helpers for exact field targeting ---
async function fillByTestId(page, testId, value) {
  try {
    const input = page.getByTestId(testId).first();
    await input.waitFor({ timeout: 8000 });
    await input.scrollIntoViewIfNeeded().catch(() => {});
    await input.fill(String(value), { timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Select a value in an MUI Autocomplete input identified by data-testid.
 * Works with either 2-letter state code ("CA") or full name ("California").
 */
async function selectAutocompleteByTestId(page, testId, value) {
  if (!value) return false;
  const fullNameByCode = {
    AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado",
    CT: "Connecticut", DE: "Delaware", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho",
    IL: "Illinois", IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana",
    ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota",
    MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada",
    NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York",
    NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon",
    PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota",
    TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia",
    WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
    DC: "District of Columbia"
  };

  const code = String(value).trim().toUpperCase();
  const full = fullNameByCode[code] || value;

  try {
    const input = page.getByTestId(testId).first();
    await input.waitFor({ timeout: 8000 });
    await input.click({ timeout: 3000 });
    // Clear any previous content (MUI Autocomplete sometimes needs select+delete)
    await input.fill('');
    await input.type(String(code), { delay: 50 });

    // Wait for listbox and try to pick best match
    // First try exact code (e.g., "CA"), then full name.
    const optionByCode = page.getByRole('option', { name: new RegExp(`^\\s*${code}\\b`, 'i') }).first();
    const optionByFull = page.getByRole('option', { name: new RegExp(`^\\s*${full}\\b`, 'i') }).first();

    if (await optionByCode.count()) {
      await optionByCode.click({ timeout: 2500 });
      return true;
    }
    if (await optionByFull.count()) {
      await optionByFull.click({ timeout: 2500 });
      return true;
    }

    // Fallback: press Enter to accept top suggestion
    await page.keyboard.press('Enter');
    return true;
  } catch {
    // Last-ditch: just type the value and Enter.
    try {
      const input = page.getByTestId(testId).first();
      await input.type(String(full), { delay: 50 });
      await page.keyboard.press('Enter');
      return true;
    } catch {
      return false;
    }
  }
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
  // Wait until at least one of the main services renders as a button/card.
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

  // Debug dump
  const txts = await page.locator('button, [role="button"]').allInnerTexts().catch(() => []);
  warn('Clickable texts seen on page:', txts?.slice(0, 30));
  throw new Error(`Service button "${label}" not found`);
}

/** ======= Drawer/overlay handling ======= */
async function closeCartDrawerIfOpen(page) {
  // Try common close icons/labels
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

  // Wait for the contact form to be present — prefer the known testIds.
  const contactReady =
    await page.getByTestId('online-booking-contact-email').first().waitFor({ timeout: 10000 }).then(() => true).catch(() => false);
  if (!contactReady) {
    // Soft fallback: wait for an Email textbox if testId changed.
    await page.getByRole('textbox', { name: /email/i }).first().waitFor({ timeout: 8000 }).catch(() => {});
  }

  // Email, City via testId (then fallbacks)
  if (email) {
    const ok =
      (await fillByTestId(page, 'online-booking-contact-email', email)) ||
      (await fillByLabel(page, /email/i, email)) ||
      (await fillByPlaceholder(page, /email/i, email)) ||
      (await page.locator('input[name="email"], input[autocomplete="email"]').first().fill(String(email)).then(() => true).catch(() => false));
    if (!ok) console.warn('[contact] Could not set email');
  }

  if (first_name) {
    const ok =
      (await fillByLabel(page, /first name/i, first_name)) ||
      (await fillByPlaceholder(page, /first name/i, first_name)) ||
      (await page.locator('input[name="firstName"], input[name="first_name"]').first().fill(String(first_name)).then(() => true).catch(() => false));
    if (!ok) console.warn('[contact] Could not set first name');
  }

  if (last_name) {
    const ok =
      (await fillByLabel(page, /last name/i, last_name)) ||
      (await fillByPlaceholder(page, /last name/i, last_name)) ||
      (await page.locator('input[name="lastName"], input[name="last_name"]').first().fill(String(last_name)).then(() => true).catch(() => false));
    if (!ok) console.warn('[contact] Could not set last name');
  }

  if (phone) {
    const ok =
      (await fillByLabel(page, /phone/i, phone)) ||
      (await fillByPlaceholder(page, /phone/i, phone)) ||
      (await page.locator('input[name="phone"], input[autocomplete="tel"], input[type="tel"]').first().fill(String(phone)).then(() => true).catch(() => false));
    if (!ok) console.warn('[contact] Could not set phone');
  }

  if (street_address) {
    const ok =
      (await fillByLabel(page, /street|address/i, street_address)) ||
      (await fillByPlaceholder(page, /street|address/i, street_address)) ||
      (await page.locator('input[name="address"], input[name="street_address"], input[autocomplete="address-line1"]').first()
        .fill(String(street_address)).then(() => true).catch(() => false));
    if (!ok) console.warn('[contact] Could not set street address');
  }

  if (city) {
    const ok =
      (await fillByTestId(page, 'online-booking-contact-city', city)) ||
      (await fillByLabel(page, /^city$/i, city)) ||
      (await fillByPlaceholder(page, /^city$/i, city)) ||
      (await page.locator('input[name="city"], input[autocomplete="address-level2"]').first().fill(String(city)).then(() => true).catch(() => false));
    if (!ok) console.warn('[contact] Could not set city');
  }

  if (state) {
    const ok =
      (await selectAutocompleteByTestId(page, 'online-booking-contact-state', state)) ||
      (await fillByLabel(page, /^state$/i, state)) || // fallback if it ever becomes a normal input
      (await page.locator('input[name="state"], input[autocomplete="address-level1"]').first().fill(String(state)).then(() => true).catch(() => false));
    if (!ok) console.warn('[contact] Could not set state');
  }

  if (zipcode) {
    const ok =
      (await fillByLabel(page, /zip|postal/i, zipcode)) ||
      (await fillByPlaceholder(page, /zip|postal/i, zipcode)) ||
      (await page.locator('input[name="zip"], input[name="zipcode"], input[autocomplete="postal-code"]').first()
        .fill(String(zipcode)).then(() => true).catch(() => false));
    if (!ok) console.warn('[contact] Could not set zip');
  }

  // Consent checkbox — prefer testId if present, then generic fallbacks.
  const consentClicked =
    (await tryClick(page, ['[data-testid="online-booking-contact-consent"]'], 'consent-tid')) ||
    (await tryClick(page, [{ role: 'checkbox', name: /consent|agree|terms|text/i }], 'consent-role')) ||
    (await tryClick(page, ['input[type="checkbox"]'], 'consent-generic'));
  if (!consentClicked) console.warn('[contact] Consent checkbox not found (may be optional).');
}


async function fillByLabel(page, labelRe, value) {
  try {
    const loc = page.getByLabel(labelRe).first();
    if ((await loc.count()) > 0) {
      await loc.fill(String(value), { timeout: 3000 });
      return true;
    }
  } catch {}
  return false;
}
async function fillByPlaceholder(page, labelRe, value) {
  try {
    const ins = page.locator('input[placeholder]').first();
    const count = await page.locator('input[placeholder]').count();
    for (let i = 0; i < count; i++) {
      const el = page.locator('input[placeholder]').nth(i);
      const ph = (await el.getAttribute('placeholder')) || '';
      if (labelRe.test(ph)) {
        await el.fill(String(value), { timeout: 3000 });
        return true;
      }
    }
  } catch {}
  return false;
}
async function fillByTextSibling(page, labelRe, value) {
  try {
    const lab = page.getByText(labelRe).first();
    if (await lab.count()) {
      const input = lab.locator('xpath=following::input[1]').first();
      if (await input.count()) {
        await input.fill(String(value), { timeout: 3000 });
        return true;
      }
    }
  } catch {}
  return false;
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
  if (!dt) return warn('Bad appointment_date; skip date selection.');
  const dayRe = new RegExp(`^\\s*${dt.d}\\s*$`);
  const clicks = [
    { role: 'button', name: dayRe },
    { text: dayRe },
    'button[aria-label*="Choose"]',
  ];
  if (!(await tryClick(page, clicks, 'calendar-day'))) {
    warn('Could not pick date; you may need month navigation.');
  } else {
    await waitIdle(page, 250);
  }
}
async function selectTimeFrame(page, startTimeStr) {
  const re = new RegExp(`^\\s*${escRe(startTimeStr)}\\s*-`, 'i');
  const ok =
    (await tryClick(page, [{ role: 'button', name: re }, { text: re }], 'timeframe')) ||
    (await tryClick(page, [{ role: 'button', name: new RegExp(escRe(startTimeStr), 'i') }], 'timeframe2'));
  if (!ok) warn(`Could not select time frame starting "${startTimeStr}"`);
}

/** ======= New per-service finalize flow ======= */
async function finalizeThisService(page, payload, { isLast }) {
  // Some items auto-open a cart drawer—close it to avoid overlay issues.
  await closeCartDrawerIfOpen(page);

  // 1) Add to booking (if present)
  const added =
    (await tryClick(page, [{ role: 'button', name: /^add to booking$/i }], 'add-to-booking1')) ||
    (await tryClick(page, [{ role: 'button', name: /add\s*to\s*booking/i }, { text: /add to booking/i }], 'add-to-booking2'));
  if (!added) warn('No "Add to booking" visible—may be auto-added.');

  await waitIdle(page, 350);
  await closeCartDrawerIfOpen(page);

  // 2) Click "Book Service" to reach contacts
  const booked =
    (await tryClick(page, [{ role: 'button', name: /book service/i }, { text: /book service/i }], 'book-service')) ||
    (await tryClick(page, [{ role: 'button', name: /book now|book my appointment|proceed/i }], 'book-alt'));
  if (!booked) {
    // Occasionally the UI uses "Continue"
    const cont = await tryClick(page, [{ role: 'button', name: /^continue$/i }, { text: /^continue$/i }], 'book-continue');
    if (!cont) throw new Error('Could not reach contact details after adding a service.');
  }
  await waitIdle(page, 500);

  if (!isLast) {
    // Not last: go back to add more services
    const back =
      (await tryClick(page, [{ role: 'button', name: /^back$/i }, { text: /^back$/i }], 'contacts-back')) ||
      (await tryClick(page, [{ role: 'button', name: /close|arrow|chevron/i }], 'contacts-back2')) ||
      (await page.goBack({ timeout: 1500 }).then(() => true).catch(() => false));
    if (!back) warn('No Back control found from contacts page.');
    await waitIdle(page, 300);

    const more =
      (await tryClick(page, [{ role: 'button', name: /add more services/i }, { text: /add more services/i }], 'add-more')) ||
      (await tryClick(page, [{ role: 'button', name: /add services/i }], 'add-services'));
    if (!more) warn('Could not click "Add more services"; continuing.');
    await waitIdle(page, 350);
    return;
  }

  // Last: fill details and schedule
  await fillContactDetails(page, payload);
  await waitIdle(page, 300);

  const submitted =
    (await tryClick(page, [{ role: 'button', name: /^submit$/i }, { text: /^submit$/i }], 'contacts-submit')) ||
    (await tryClick(page, [{ role: 'button', name: /continue|next/i }, { text: /continue|next/i }], 'contacts-next'));
  if (!submitted) throw new Error('Could not submit contact details.');

  await waitIdle(page, 600);

if (payload.appointment_date) {
  await selectDate(page, payload.appointment_date);
}
if (payload.time_frame_start) {
  await selectArrivalWindowByStart(page, payload.time_frame_start);
}

  await tryClick(page, [{ role: 'button', name: /^next$/i }, { text: /^next$/i }], 'schedule-next');
  await waitIdle(page, 300);

  const finalBook =
    (await tryClick(page, [{ role: 'button', name: /book my appointment/i }, { text: /book my appointment/i }], 'final-book')) ||
    (await tryClick(page, [{ role: 'button', name: /book now|confirm|finish/i }, { text: /book now|confirm|finish/i }], 'final-book2'));
  if (!finalBook) warn('Final booking button not found.');
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

  const picked =
    (await tryClick(page, [{ text: want }], 'bedrooms-pick')) ||
    (await tryClick(page, [{ role: 'button', name: want }], 'bedrooms-pick-role'));
  if (!picked) warn('Could not click bedrooms option; continuing.');

  await waitIdle(page, 250);
  await finalizeThisService(page, payload, meta);
}

async function handlePetStain(page, payload, meta) {
  await clickService(page, 'Pet Stain');

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

  const picked =
    (await tryClick(
      page,
      [
        { role: 'button', name: new RegExp(`^\\s*${escRe(label)}\\s*$`, 'i') },
        { text: new RegExp(`^\\s*${escRe(label)}\\s*$`, 'i') },
        `button:has-text("${label}")`,
      ],
      'upholstery-item'
    )) || (await tryClick(page, [{ text: new RegExp(escRe(label), 'i') }], 'upholstery-text'));
  if (!picked) warn(`Could not click upholstery item "${label}".`);

  if (qty && qty > 1) await setQty(page, qty);

  await waitIdle(page, 250);
  await finalizeThisService(page, payload, meta);
}

async function handleCarpetStretching(page, payload, meta) {
  await clickService(page, 'Carpet Repair');

  const ok =
    (await tryClick(page, [{ role: 'button', name: /carpet stretching/i }], 'stretch1')) ||
    (await tryClick(page, [{ text: /carpet re-stretching/i }], 'stretch2'));
  if (!ok) warn('Could not click "Carpet Stretching".');

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
  const raw = await fs.readFile(PAYLOAD_PATH, 'utf8');
  const payload = JSON.parse(raw);
  log('[loader] Using payload from', PAYLOAD_PATH);

  const browser = await chromium.connect({ headless: HEADLESS, slowMo: SLOWMO });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    log('[nav]', START_URL);
    await page.goto(START_URL, { waitUntil: 'load', timeout: 45000 });
    await waitIdle(page, 600);

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
}