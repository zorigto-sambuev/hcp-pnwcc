// A Playwright script to automate booking a service on Housecall Pro.

import { chromium } from 'playwright';
import fs from 'fs/promises';
import 'dotenv/config';

/**
 * Generates a random delay between min and max milliseconds.
 * @param {number} min - The minimum delay in milliseconds.
 * @param {number} max - The maximum delay in milliseconds.
 * @returns {Promise<void>}
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
    // Wait for the text "Thank you" to be visible on the page.
    await page.getByText('Thank you').waitFor({ state: 'visible', timeout: 10000 });
    // Also wait for the more specific confirmation message.
    await page.getByText('Your booking was successful.').waitFor({ state: 'visible', timeout: 10000 });
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
  // Destructure all the needed values from the payload parameter 'p'
  const { first_name, last_name, phone, email, street_address, city, state, zipcode } = p;

  log('[contact] Filling contact form...');

  // Use getByTestId for reliable targeting of each field
  if (first_name) await page.getByTestId('online-booking-contact-firstname').fill(first_name);
  if (last_name) await page.getByTestId('online-booking-contact-lastname').fill(last_name);
  if (phone) await page.getByTestId('online-booking-contact-phone').fill(phone);
  if (email) await page.getByTestId('online-booking-contact-email').fill(email);
  if (street_address) await page.getByTestId('online-booking-contact-street').fill(street_address);
  if (city) await page.getByTestId('online-booking-contact-city').fill(city);
  if (zipcode) await page.getByTestId('online-booking-contact-zip').fill(zipcode);

  // Special handling for the State autocomplete dropdown
  if (state) {
    log(`[contact] Selecting state: ${state}`);
    const stateInput = page.getByTestId('online-booking-contact-state');
    
    // Click the input to activate the dropdown list
    await stateInput.click(); 
    
    // Type the state to filter the options; a small delay helps reliability
    await stateInput.type(state, { delay: 1000 }); 
    
    // Find the option in the listbox that appears and click it
    const option = page.getByRole('option', { name: new RegExp(state, 'i') }).first();
    await option.click();
  }
  
  log('[contact] Form filled.');

  // Click the consent checkbox at the end
  await tryClick(page, [{ role: 'checkbox' }, 'input[type="checkbox"]'], 'consent');
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
  if (!dt) {
    warn('Bad appointment_date; skip date selection.');
    return;
  }

  // Get the three-letter month abbreviation (e.g., 'Sep')
  // We use `dt.m - 1` because JavaScript months are 0-indexed (0=Jan, 1=Feb, etc.).
  const monthAbbr = new Date(dt.y, dt.m - 1, dt.d).toLocaleString('en-US', { month: 'short' });

  // Create a flexible regular expression that looks for the month abbreviation
  // and the day number, ignoring everything after it.
  // The 'i' flag ensures the match is case-insensitive.
  const re = new RegExp(`${monthAbbr}\\s*${dt.d}`, 'i');

  const ok = await tryClick(
    page,
    [
      // Use the new, flexible regular expression to find the button by its text content.
      { role: 'button', name: re },
      { text: re },
    ],
    'calendar-day'
  );

  if (!ok) {
    warn('Could not pick date; you may need month navigation.');
  } else {
    await waitIdle(page, 250);
  }
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

/**
 * ============================================
 * COMPREHENSIVE FALLBACK STRATEGY FUNCTIONS
 * ============================================
 */

/**
 * Comprehensive fallback strategy for clicking the "Book my appointment" button
 */
async function clickBookAppointmentButtonWithFallbacks(page) {
  const strategies = [
    // Strategy 1: Text-based selector (most reliable)
    async () => {
      log('Strategy 1: Clicking by text content');
      await page.waitForSelector('button:has-text("Book my appointment")', { state: 'visible', timeout: 5000 });
      await page.click('button:has-text("Book my appointment")');
    },
    
    // Strategy 2: Primary Material-UI class
    async () => {
      log('Strategy 2: Clicking by primary MUI class');
      await page.waitForSelector('.MuiButton-containedPrimary-338', { state: 'visible', timeout: 5000 });
      await page.click('.MuiButton-containedPrimary-338');
    },
    
    // Strategy 3: Full class combination
    async () => {
      log('Strategy 3: Clicking by full class selector');
      await page.click('button.MuiButtonBase-root-73.MuiButton-root-329.MuiButton-contained-337');
    },
    
    // Strategy 4: Click the inner span with text
    async () => {
      log('Strategy 4: Clicking inner span with text');
      await page.click('span:has-text("Book my appointment")');
    },
    
    // Strategy 5: Force click (ignores intercepted clicks)
    async () => {
      log('Strategy 5: Force clicking button');
      await page.click('button:has-text("Book my appointment")', { force: true });
    },
    
    // Strategy 6: JavaScript evaluation click
    async () => {
      log('Strategy 6: JavaScript evaluation click');
      await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        const button = buttons.find(btn => btn.textContent.includes('Book my appointment')) ||
                     document.querySelector('.MuiButton-containedPrimary-338');
        if (button) button.click();
      });
    },
    
    // Strategy 7: Dispatch click event
    async () => {
      log('Strategy 7: Dispatching click event');
      await page.evaluate(() => {
        const button = Array.from(document.querySelectorAll('button')).find(btn => 
          btn.textContent.includes('Book my appointment'));
        if (button) {
          button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        }
      });
    },
    
    // Strategy 8: Focus and press Enter
    async () => {
      log('Strategy 8: Focus and press Enter');
      const button = await page.$('button:has-text("Book my appointment")');
      if (button) {
        await button.focus();
        await page.keyboard.press('Enter');
      }
    },
    
    // Strategy 9: Focus and press Space
    async () => {
      log('Strategy 9: Focus and press Space');
      const button = await page.$('button:has-text("Book my appointment")');
      if (button) {
        await button.focus();
        await page.keyboard.press('Space');
      }
    },
    
    // Strategy 10: Coordinates-based click
    async () => {
      log('Strategy 10: Coordinates-based click');
      const button = await page.$('button:has-text("Book my appointment")');
      if (button) {
        const box = await button.boundingBox();
        if (box) {
          await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        }
      }
    },
    
    // Strategy 11: Scroll into view and click
    async () => {
      log('Strategy 11: Scroll into view and click');
      await page.evaluate(() => {
        const button = Array.from(document.querySelectorAll('button')).find(btn => 
          btn.textContent.includes('Book my appointment'));
        if (button) {
          button.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      });
      await page.waitForTimeout(1000);
      await page.click('button:has-text("Book my appointment")');
    },
    
    // Strategy 12: Remove overlays and click
    async () => {
      log('Strategy 12: Remove potential overlays and click');
      await page.evaluate(() => {
        // Remove potential overlays
        const overlays = document.querySelectorAll('[class*="overlay"], [class*="backdrop"], [class*="modal-backdrop"]');
        overlays.forEach(overlay => overlay.remove());
      });
      await page.click('button:has-text("Book my appointment")');
    }
  ];

  // Pre-checks and setup
  try {
    log('Setting up for button click...');
    
    // Wait for dialog to be fully loaded
    await page.waitForSelector('[role="dialog"]', { state: 'visible', timeout: 15000 });
    log('Dialog is visible');
    
    // Wait for booking confirmation text
    await page.waitForSelector('h5:has-text("Booking confirmation")', { state: 'visible', timeout: 10000 });
    log('Booking confirmation page loaded');
    
    // Wait a bit for any animations to complete
    await page.waitForTimeout(2000);
    
    // Check if button exists
    const buttonExists = await page.$('button:has-text("Book my appointment")') !== null;
    if (!buttonExists) {
      throw new Error('Book my appointment button not found in DOM');
    }
    log('Button exists in DOM');

  } catch (setupError) {
    errLog('Setup failed:', setupError.message);
    await page.screenshot({ path: `setup-error-${Date.now()}.png`, fullPage: true });
    throw new Error(`Setup failed: ${setupError.message}`);
  }

  // Try each strategy with proper error handling
  let lastError = null;
  let strategyIndex = 0;

  for (const strategy of strategies) {
    try {
      strategyIndex++;
      log(`--- Attempting Strategy ${strategyIndex} ---`);
      
      // Execute the strategy
      await strategy();
      
      // Wait a moment to see if click was successful
      await page.waitForTimeout(1500);
      
      // Check for success indicators
      const success = await checkClickSuccess(page);
      
      if (success) {
        log(`✅ SUCCESS! Strategy ${strategyIndex} worked!`);
        
        // Wait for any network requests to complete
        await waitForNetworkRequests(page);
        
        return { success: true, strategyUsed: strategyIndex, method: `Strategy ${strategyIndex}` };
      } else {
        log(`❌ Strategy ${strategyIndex} didn't trigger expected response`);
      }
      
    } catch (error) {
      log(`❌ Strategy ${strategyIndex} failed:`, error.message);
      lastError = error;
      
      // Take screenshot for debugging failed strategy
      await page.screenshot({ 
        path: `strategy-${strategyIndex}-error-${Date.now()}.png`, 
        fullPage: true 
      }).catch(() => {});
      
      // Brief pause before trying next strategy
      await page.waitForTimeout(500);
    }
  }

  // If all strategies failed
  errLog('🚨 ALL STRATEGIES FAILED!');
  await page.screenshot({ path: `all-strategies-failed-${Date.now()}.png`, fullPage: true });
  
  throw new Error(`All ${strategies.length} strategies failed. Last error: ${lastError?.message || 'Unknown error'}`);
}

// Helper function to check if click was successful
async function checkClickSuccess(page) {
  try {
    // Check for common success indicators
    const indicators = await page.evaluate(() => {
      return {
        // Check for loading states
        hasLoadingSpinner: !!document.querySelector('[class*="loading"], [class*="spinner"], [class*="progress"]'),
        
        // Check for navigation/page changes
        urlChanged: window.location.href !== window.initialUrl,
        
        // Check for new modals or success messages
        hasSuccessModal: !!document.querySelector('[class*="success"], [role="alert"], [class*="confirmation"]'),
        
        // Check if button is now disabled (common after successful submission)
        buttonDisabled: (() => {
          const buttons = document.querySelectorAll('button');
          const bookButton = Array.from(buttons).find(btn => btn.textContent.includes('Book my appointment'));
          return bookButton ? bookButton.disabled : false;
        })(),
        
        // Fix: Check for "Thank you" text properly
        hasThankYou: document.body.textContent.includes('Thank you') ||
                     document.body.textContent.includes('booking was successful') ||
                     document.body.textContent.includes('Your booking was successful') ||
                     !!document.querySelector('h1, h2, h3, h4, h5, h6, p, div, span').textContent?.includes('Thank you')
      };
    });
    
    // Return true if any success indicator is found
    return indicators.hasLoadingSpinner || 
           indicators.urlChanged || 
           indicators.hasSuccessModal || 
           indicators.buttonDisabled ||
           indicators.hasThankYou;
           
  } catch (error) {
    log('Could not check success indicators:', error.message);
    return false;
  }
}


// Helper function to wait for network requests
async function waitForNetworkRequests(page) {
  try {
    log('Waiting for network requests to complete...');
    
    // Wait for potential webhook calls or API requests
    await Promise.race([
      // Wait for specific responses
      page.waitForResponse(response => {
        const url = response.url();
        return url.includes('webhook') || 
               url.includes('booking') || 
               url.includes('appointment') ||
               url.includes('api') ||
               url.includes('housecall');
      }, { timeout: 10000 }),
      
      // Or wait for network to be idle
      page.waitForLoadState('networkidle', { timeout: 10000 }),
      
      // Or timeout after 10 seconds
      page.waitForTimeout(10000)
    ]);
    
    log('Network requests completed');
    
  } catch (error) {
    log('Network wait completed with timeout or error:', error.message);
  }
}

/** ======= New per-service finalize flow ======= */
async function finalizeThisService(page, payload, { isLast }) {
  log('Starting finalizeThisService function...');
  // Some items auto-open a cart drawer—close it to avoid overlay issues.
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
    // Occasionally the UI uses "Continue"
    const cont = await tryClick(page, [{ role: 'button', name: /^continue$/i }, { text: /^continue$/i }], 'book-continue');
    if (!cont) {
      log('Could not reach contact details after adding a service.');
      throw new Error('Could not reach contact details after adding a service.');
    }
  }
  log('Book Service step complete.');
  await randomDelay(1000, 4500); // Add delay here

  if (!isLast) {
    log('Not last service, attempting to go back...');
    // Not last: go back to add more services
    const back =
      (await tryClick(page, [{ role: 'button', name: /^back$/i }, { text: /^back$/i }], 'contacts-back')) ||
      (await tryClick(page, [{ role: 'button', name: /close|arrow|chevron/i }], 'contacts-back2')) ||
      (await page.goBack({ timeout: 1500 }).then(() => true).catch(() => false));
    if (!back) warn('No Back control found from contacts page.');
   await randomDelay(1000, 4500); // Add delay here

    const more =
      (await tryClick(page, [{ role: 'button', name: /add more services/i }, { text: /add more services/i }], 'add-more')) ||
      (await tryClick(page, [{ role: 'button', name: /add services/i }], 'add-services'));
    if (!more) warn('Could not click "Add more services"; continuing.');
    await randomDelay(1000, 4500); // Add delay here
    return;
  }

  // Last: fill details and schedule
  log('Filling contact details...');
  await fillContactDetails(page, payload);
  await waitIdle(page, 600);
  await randomDelay(1000, 4500); // Add delay here

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
  await randomDelay(1000, 4500); // Add delay here

  log('Attempting to select date...');
  if (payload.appointment_date) await selectDate(page, payload.appointment_date);
  log('Date selection complete.');
  await randomDelay(1000, 4500); // Add delay here

  log('Attempting to select time frame...');
  if (payload.time_frame_start) await selectTimeFrame(page, payload.time_frame_start);
  log('Time frame selection complete.');
  await randomDelay(1000, 4500); // Add delay here

  log('Attempting to click Next on schedule page...');
  await tryClick(page, [{ role: 'button', name: /^next$/i }, { text: /^next$/i }], 'schedule-next');
  log('Clicked Next on schedule page.');
  await waitIdle(page, 300);
  await randomDelay(1000, 4500); // Add delay here

  log('Attempting to click final book button with comprehensive fallbacks...');
  try {
    const result = await clickBookAppointmentButtonWithFallbacks(page);
    log('🎉 Final booking completed successfully!');
    log('📊 Result:', result);
  } catch (error) {
    errLog('❌ Final booking failed with all fallback strategies:', error.message);
    
    // Additional debugging info
    const currentUrl = await page.url();
    log('Current URL:', currentUrl);
    
    // Save page content for debugging
    const content = await page.content();
    await fs.writeFile(`failed-page-content-${Date.now()}.html`, content).catch(() => {});
    
    throw new Error(`Final booking failed: ${error.message}`);
  }
  
  // Add the call to the existing verifySuccess function
  await verifySuccess(page);
}

/** ======= Service handlers ======= */
// Service handler for Carpet Cleaning.
async function handleCarpetCleaning(page, bedrooms, payload, meta) {
  await clickService(page, 'Carpet Cleaning');
  const map = {
    2: /two\s*\(\s*2\s*\)\s*bedrooms\s*house/i,
    3: /three\s*\(\s*3\s*\)\s*bedrooms\s*house/i,
    4: /four\s*\(\s*4\s*\)\s*bedrooms\s*house/i,
  };
  const want = map[Number(bedrooms)] || map[4];
  
  // Use a more robust set of selectors to find the bedrooms option
  const picked = await tryClick(
    page,
    [
      { text: want },
      { role: 'button', name: want },
      `button:has-text("${bedrooms}")`,
      `button:has-text("${want}")`,
    ]
  );
  
  // Throw an error if the button is not found to prevent silent failures
  if (!picked) {
    throw new Error('Could not click bedrooms option.');
  }
  
  await waitIdle(page, 250);
  await randomDelay(1000, 4500); // Add delay here
  await finalizeThisService(page, payload, meta);
}

async function handlePetStain(page, payload, meta) {
  await clickService(page, 'Pet Stain');
  await randomDelay(1000, 4500); // Add delay here
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
  await randomDelay(1000, 4500); // Add delay here
  await finalizeThisService(page, payload, meta);
}

async function handleCarpetStretching(page, payload, meta) {
  await clickService(page, 'Carpet Repair');

  const ok =
    (await tryClick(page, [{ role: 'button', name: /carpet stretching/i }], 'stretch1')) ||
    (await tryClick(page, [{ text: /carpet re-stretching/i }], 'stretch2'));
  if (!ok) warn('Could not click "Carpet Stretching".');

  await randomDelay(1000, 4500); // Add delay here
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

  const browser = await chromium.launch({ headless: HEADLESS, slowMo: SLOWMO });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    log('[nav]', START_URL);
    await page.goto(START_URL, { waitUntil: 'load', timeout: 45000 });
    await waitIdle(page, 600);
    await randomDelay(1000, 4500); // Add delay here

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
      await randomDelay(1000, 4500); // Add delay here
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
