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
// const HEADLESS =
//   process.env.HEADLESS === '1' ? true : process.env.HEADLESS === '0' ? false : false;
const HEADLESS = true

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
    log('[verify] Starting success verification...');
    
    // Wait longer and try multiple success indicators
    const successFound = await Promise.race([
      // Primary success indicators
      page.getByText('Thank you').waitFor({ state: 'visible', timeout: 15000 }).then(() => 'thank-you'),
      page.getByText('Your booking was successful.').waitFor({ state: 'visible', timeout: 15000 }).then(() => 'booking-successful'),
      
      // Alternative success indicators
      page.getByText('Confirmation').waitFor({ state: 'visible', timeout: 10000 }).then(() => 'confirmation'),
      page.getByText('We\'ll send you an email').waitFor({ state: 'visible', timeout: 10000 }).then(() => 'email-confirmation'),
      
      // Page title changes
      page.waitForFunction(() => document.title.toLowerCase().includes('thank') || document.title.toLowerCase().includes('confirm'), { timeout: 10000 }).then(() => 'title-change'),
      
      // URL changes  
      page.waitForFunction(() => window.location.href.includes('success') || window.location.href.includes('confirm') || window.location.href.includes('thank'), { timeout: 10000 }).then(() => 'url-change'),
      
      // Timeout fallback
      page.waitForTimeout(20000).then(() => 'timeout')
    ]).catch(() => 'none');
    
    log('[verify] Success indicator found:', successFound);
    
    if (successFound !== 'none' && successFound !== 'timeout') {
      log('Successfully reached confirmation page via:', successFound);
      return true;
    }
    
    // If no success indicators found, check what page we're actually on
    const currentUrl = await page.url();
    const pageTitle = await page.title();
    const pageContent = await page.evaluate(() => document.body.textContent.substring(0, 500));
    
    log('[verify] No success indicators found.');
    log('[verify] Current URL:', currentUrl);
    log('[verify] Page title:', pageTitle);
    log('[verify] Page content preview:', pageContent);
    
    return false;
    
  } catch (e) {
    errLog('[verify] Verification error:', e.message);
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
    // Strategy 1: Flexible text-based selector (most reliable)
    async () => {
      log('Strategy 1: Clicking by flexible text content');
      const buttonSelectors = [
        'button:has-text("Book my appointment")',
        'button:has-text("Book now")', 
        'button:has-text("Confirm booking")',
        'button:has-text("Submit")',
        'button:has-text("Continue")',
        'button:has-text("Finish")',
        'button:has-text("Complete")',
        'button:has-text("Next")',
        'button:has-text("Proceed")',
        'button:has-text("Pay")',
        'button:has-text("Reserve")'
      ];
      
      for (const selector of buttonSelectors) {
        try {
          await page.waitForSelector(selector, { state: 'visible', timeout: 1000 });
          await page.click(selector);
          log('Successfully clicked button with selector:', selector);
          return;
        } catch {}
      }
      
      // If no expected buttons found, try to click any visible button as last resort
      log('No expected buttons found, trying any visible button...');
      const anyButton = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        const visibleButtons = buttons.filter(btn => 
          btn.offsetParent !== null && // is visible
          !btn.disabled && // not disabled
          btn.textContent?.trim().length > 0 // has text content
        );
        return visibleButtons.length > 0 ? visibleButtons[0] : null;
      });
      
      if (anyButton) {
        await page.evaluate(btn => btn.click(), anyButton);
        log('Clicked first available visible button as fallback');
        return;
      }
      
      throw new Error('No booking buttons found with expected text and no fallback buttons available');
    },
    
    // Strategy 2: Primary Material-UI classes (flexible)
    async () => {
      log('Strategy 2: Clicking by primary MUI classes');
      const classSelectors = [
        '.MuiButton-containedPrimary-338',
        '.MuiButton-containedPrimary',
        '.MuiButton-contained[class*="Primary"]',
        'button[class*="contained"][class*="Primary"]'
      ];
      
      for (const selector of classSelectors) {
        try {
          await page.waitForSelector(selector, { state: 'visible', timeout: 2000 });
          await page.click(selector);
          return;
        } catch {}
      }
      throw new Error('No primary buttons found');
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
    
    // Strategy 6: JavaScript evaluation click with validation check
    async () => {
      log('Strategy 6: JavaScript evaluation click with validation check');
      const result = await page.evaluate(() => {
        // First, try to handle any validation requirements
        
        // 1. Check and accept terms/conditions if needed
        const checkboxes = Array.from(document.querySelectorAll('input[type="checkbox"]'));
        const termsCheckboxes = checkboxes.filter(cb => {
          const label = cb.closest('label') || document.querySelector(`label[for="${cb.id}"]`);
          const text = (label?.textContent || cb.parentElement?.textContent || '').toLowerCase();
          return text.includes('terms') || text.includes('conditions') || text.includes('agree') || text.includes('consent');
        });
        
        termsCheckboxes.forEach(cb => {
          if (!cb.checked) {
            cb.click();
            console.log('[Strategy 6] Checked terms/conditions checkbox');
          }
        });
        
        // 2. Try to find and click the best button
        const buttons = Array.from(document.querySelectorAll('button'));
        const bookingKeywords = ['book', 'confirm', 'submit', 'continue', 'finish', 'complete'];
        
        // Priority 1: Enabled buttons with booking keywords
        let button = buttons.find(btn => {
          const text = btn.textContent.toLowerCase();
          return !btn.disabled && bookingKeywords.some(keyword => text.includes(keyword));
        });
        
        // Priority 2: Primary buttons (even if disabled, we'll try to force click)
        if (!button) {
          button = buttons.find(btn => 
            btn.className.includes('Primary') || btn.className.includes('contained')
          );
        }
        
        // Priority 3: Any button with booking keywords (even disabled)
        if (!button) {
          button = buttons.find(btn => {
            const text = btn.textContent.toLowerCase();
            return bookingKeywords.some(keyword => text.includes(keyword));
          });
        }
        
        if (button) {
          // Force click even if disabled
          button.click();
          return { success: true, buttonText: button.textContent?.trim(), wasDisabled: button.disabled };
        }
        
        return { success: false, availableButtons: buttons.length };
      });
      
      if (result.success) {
        log('Successfully clicked button:', result.buttonText, result.wasDisabled ? '(was disabled but forced)' : '(was enabled)');
      } else {
        throw new Error(`No suitable button found. Available buttons: ${result.availableButtons}`);
      }
    },
    
    // Strategy 7: Dispatch click event (flexible)
    async () => {
      log('Strategy 7: Dispatching click event');
      await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        const bookingKeywords = ['book', 'confirm', 'submit', 'continue', 'finish', 'complete'];
        
        const button = buttons.find(btn => {
          const text = btn.textContent.toLowerCase();
          return bookingKeywords.some(keyword => text.includes(keyword));
        }) || buttons.find(btn => btn.className.includes('Primary') || btn.className.includes('contained'));
        
        if (button) {
          button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        }
      });
    },
    
    // Strategy 8: Dynamic button discovery with exhaustive search
    async () => {
      log('Strategy 8: Dynamic button discovery with exhaustive search');
      const result = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        const visibleButtons = buttons.filter(btn => 
          btn.offsetParent !== null && // is visible
          !btn.disabled // not disabled
        );
        
        // Priority 1: Buttons with booking-related keywords
        const bookingButtons = visibleButtons.filter(btn => {
          const text = btn.textContent?.toLowerCase() || '';
          return text.includes('book') || text.includes('confirm') || text.includes('submit') || 
                 text.includes('continue') || text.includes('finish') || text.includes('complete') ||
                 text.includes('proceed') || text.includes('pay') || text.includes('reserve');
        });
        
        // Priority 2: Primary/contained buttons (likely action buttons)
        const primaryButtons = visibleButtons.filter(btn => 
          btn.className.includes('Primary') || btn.className.includes('contained')
        );
        
        // Priority 3: Any visible button with text
        const anyButtons = visibleButtons.filter(btn => 
          btn.textContent?.trim().length > 0
        );
        
        const buttonToClick = bookingButtons[0] || primaryButtons[0] || anyButtons[0];
        
        if (buttonToClick) {
          buttonToClick.click();
          return { success: true, buttonText: buttonToClick.textContent?.trim() };
        }
        return { success: false, availableButtons: visibleButtons.length };
      });
      
      if (result.success) {
        log('Successfully clicked button with text:', result.buttonText);
      } else {
        throw new Error(`No clickable button found. Available buttons: ${result.availableButtons}`);
      }
    },
    
    // Strategy 9: Focus and press Enter (flexible)
    async () => {
      log('Strategy 9: Focus and press Enter');
      const buttonSelectors = [
        'button:has-text("Book my appointment")',
        'button:has-text("Book now")',
        'button:has-text("Confirm")',
        'button[class*="Primary"]'
      ];
      
      for (const selector of buttonSelectors) {
        try {
          const button = await page.$(selector);
          if (button) {
            await button.focus();
            await page.keyboard.press('Enter');
            return;
          }
        } catch {}
      }
    },
    
    // Strategy 10: Focus and press Space (flexible)
    async () => {
      log('Strategy 10: Focus and press Space');
      const buttonSelectors = [
        'button:has-text("Book my appointment")',
        'button:has-text("Book now")',
        'button:has-text("Confirm")',
        'button[class*="Primary"]'
      ];
      
      for (const selector of buttonSelectors) {
        try {
          const button = await page.$(selector);
          if (button) {
            await button.focus();
            await page.keyboard.press('Space');
            return;
          }
        } catch {}
      }
    },
    
    // Strategy 11: Coordinates-based click (flexible)
    async () => {
      log('Strategy 11: Coordinates-based click');
      const button = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        return buttons.find(btn => {
          const text = btn.textContent?.toLowerCase() || '';
          return text.includes('book') || text.includes('confirm') || text.includes('submit');
        });
      });
      
      if (button) {
        const box = await button.boundingBox();
        if (box) {
          await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        }
      }
    },
    
    // Strategy 12: Scroll into view and click (flexible)
    async () => {
      log('Strategy 12: Scroll into view and click');
      await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        const button = buttons.find(btn => {
          const text = btn.textContent?.toLowerCase() || '';
          return text.includes('book') || text.includes('confirm') || text.includes('submit');
        });
        if (button) {
          button.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      });
      await page.waitForTimeout(1000);
      
      // Try multiple button selectors after scrolling
      const buttonSelectors = [
        'button:has-text("Book my appointment")',
        'button:has-text("Book now")',
        'button:has-text("Confirm")',
        'button[class*="Primary"]'
      ];
      
      for (const selector of buttonSelectors) {
        try {
          await page.click(selector, { timeout: 2000 });
          return;
        } catch {}
      }
    },
    
    // Strategy 13: Remove overlays and click (flexible)
    async () => {
      log('Strategy 13: Remove potential overlays and click');
      await page.evaluate(() => {
        // Remove potential overlays
        const overlays = document.querySelectorAll('[class*="overlay"], [class*="backdrop"], [class*="modal-backdrop"]');
        overlays.forEach(overlay => overlay.remove());
      });
      
      const buttonSelectors = [
        'button:has-text("Book my appointment")',
        'button:has-text("Book now")', 
        'button:has-text("Confirm")',
        'button[class*="Primary"]'
      ];
      
      for (const selector of buttonSelectors) {
        try {
          await page.click(selector, { timeout: 2000 });
          return;
        } catch {}
      }
    }
  ];

  // Pre-checks and setup
  try {
    log('Setting up for button click...');
    
    // Wait for page to be ready (more flexible approach)
    await page.waitForLoadState('domcontentloaded', { timeout: 15000 });
    
    // Wait for one of several possible confirmation indicators
    const confirmationFound = await Promise.race([
      // Wait for dialog
      page.waitForSelector('[role="dialog"]', { state: 'visible', timeout: 10000 }).then(() => 'dialog'),
      
      // Wait for various confirmation text variations
      page.waitForSelector('h5:has-text("Booking confirmation")', { state: 'visible', timeout: 5000 }).then(() => 'booking-confirmation'),
      page.waitForSelector('h1:has-text("confirmation"), h2:has-text("confirmation"), h3:has-text("confirmation"), h4:has-text("confirmation"), h5:has-text("confirmation"), h6:has-text("confirmation")', { state: 'visible', timeout: 5000 }).then(() => 'general-confirmation'),
      page.waitForSelector('*:has-text("Review your booking")', { state: 'visible', timeout: 5000 }).then(() => 'review-booking'),
      page.waitForSelector('*:has-text("Appointment details")', { state: 'visible', timeout: 5000 }).then(() => 'appointment-details'),
      
      // Wait for the booking button itself
      page.waitForSelector('button:has-text("Book my appointment"), button:has-text("Book now"), button:has-text("Confirm booking")', { state: 'visible', timeout: 5000 }).then(() => 'book-button'),
      
      // Timeout fallback
      page.waitForTimeout(8000).then(() => 'timeout')
    ]).catch(() => 'none');
    
    log('Confirmation indicator found:', confirmationFound);
    
    // Wait a bit for any animations to complete
    await page.waitForTimeout(1500);
    
    // Check ALL available buttons for debugging (don't filter yet)
    const allButtons = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      return buttons.map(btn => ({
        text: btn.textContent?.trim() || '',
        className: btn.className || '',
        disabled: btn.disabled || false,
        visible: btn.offsetParent !== null
      })).filter(btn => btn.text.length > 0); // Only filter out empty buttons
    });
    
    // Now check for potential booking buttons with more flexible criteria
    const potentialBookingButtons = allButtons.filter(btn => {
      const text = btn.text.toLowerCase();
      // More flexible keywords including common variations
      return text.includes('book') || 
             text.includes('confirm') || 
             text.includes('submit') || 
             text.includes('continue') ||
             text.includes('next') ||
             text.includes('finish') ||
             text.includes('complete') ||
             text.includes('proceed') ||
             text.includes('pay') ||
             text.includes('reserve') ||
             btn.className.includes('Primary') || // Material-UI primary buttons
             btn.className.includes('contained'); // Material-UI contained buttons
    });
    
    log('Potential booking buttons found:', potentialBookingButtons);
    
    if (allButtons.length === 0) {
      throw new Error('No buttons found on page at all');
    }
    
    if (potentialBookingButtons.length === 0) {
      log('No obvious booking buttons found, but proceeding to try all available buttons...');
      // Don't fail here - let the strategies try all available buttons
    }
    
    // Check for disabled primary buttons (common issue)
    const disabledButtons = allButtons.filter(btn => btn.disabled);
    if (disabledButtons.length > 0) {
      log('⚠️  Found disabled buttons (may indicate missing required fields):');
      disabledButtons.forEach((btn, i) => {
        log(`   ${i + 1}. "${btn.text}" (${btn.className.includes('Primary') ? 'PRIMARY BUTTON - likely the target' : 'secondary'})`);
      });
      
      // Check for common validation issues
      const commonIssues = await page.evaluate(() => {
        const issues = [];
        
        // Check for required fields
        const requiredInputs = document.querySelectorAll('input[required], textarea[required], select[required]');
        const emptyRequired = Array.from(requiredInputs).filter(input => !input.value.trim());
        if (emptyRequired.length > 0) {
          issues.push(`${emptyRequired.length} required fields are empty`);
        }
        
        // Check for unchecked required checkboxes
        const requiredCheckboxes = document.querySelectorAll('input[type="checkbox"][required]');
        const uncheckedRequired = Array.from(requiredCheckboxes).filter(cb => !cb.checked);
        if (uncheckedRequired.length > 0) {
          issues.push(`${uncheckedRequired.length} required checkboxes are unchecked`);
        }
        
        // Check for validation errors
        const errorElements = document.querySelectorAll('.error, .MuiFormHelperText-root.Mui-error, [class*="error"]');
        if (errorElements.length > 0) {
          issues.push(`${errorElements.length} validation errors visible`);
        }
        
        return issues;
      });
      
      if (commonIssues.length > 0) {
        log('🚨 Potential validation issues preventing booking:');
        commonIssues.forEach((issue, i) => log(`   ${i + 1}. ${issue}`));
      }
    }
    
    log('Page setup complete, proceeding with booking...');

  } catch (setupError) {
    errLog('Setup failed:', setupError.message);
    
    // Enhanced debugging
    try {
      const currentUrl = await page.url();
      const pageTitle = await page.title();
      log('Debug - Current URL:', currentUrl);
      log('Debug - Page title:', pageTitle);
      
      await page.screenshot({ path: `setup-error-${Date.now()}.png`, fullPage: true });
    } catch {}
    
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
      }, { timeout: 30000 }),
      
      // Or wait for network to be idle
      page.waitForLoadState('networkidle', { timeout: 30000 }),
      
      // Or timeout after 10 seconds
      page.waitForTimeout(30000)
    ]);
    
    log('Network requests completed');
    
  } catch (error) {
    log('Network wait completed with timeout or error:', error.message);
  }
}

/** ======= New per-service finalize flow ======= */
async function finalizeThisService(page, payload, { isLast }) {
  log(`[finalize] Starting finalizeThisService function... (isLast: ${isLast})`);
  
  // Some items auto-open a cart drawer—close it to avoid overlay issues.
  await closeCartDrawerIfOpen(page);
  await waitIdle(page, 1000);

  // 1) Add to booking (if present)
  log('[finalize] Attempting to add to booking...');
  
  // Enhanced selectors for "Add to booking" button
  const addToBookingSelectors = [
    { role: 'button', name: /^add to booking$/i },
    { role: 'button', name: /add\s*to\s*booking/i },
    { text: /add to booking/i },
    `button:has-text("Add to booking")`,
    `button:has-text("Add to Booking")`,
    `.MuiButton-root:has-text("Add to booking")`,
    `[role="button"]:has-text("Add to booking")`,
  ];
  
  const added = await tryClick(page, addToBookingSelectors, 'add-to-booking');
  
  if (!added) {
    // Debug what buttons are available
    try {
      const availableButtons = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
        return buttons.map(btn => btn.textContent?.trim() || '').filter(text => text.length > 0).slice(0, 10);
      });
      log('[finalize] Available buttons:', availableButtons);
    } catch {}
    
    warn('[finalize] No "Add to booking" visible—may be auto-added or service not selected properly.');
    } else {
    log('[finalize] Successfully added to booking.');
  }

  await waitIdle(page, 1200);
  await closeCartDrawerIfOpen(page);

  // 2) Click "Book Service" to reach contacts
  log('[finalize] Attempting to click "Book Service" or similar...');
  
  // Enhanced selectors for "Book Service" button
  const bookServiceSelectors = [
    { role: 'button', name: /book service/i },
    { text: /book service/i },
      { role: 'button', name: /book now/i },
    { role: 'button', name: /book my appointment/i },
    { role: 'button', name: /proceed/i },
    { role: 'button', name: /continue$/i },
    { text: /continue$/i },
    `button:has-text("Book Service")`,
    `button:has-text("Book Now")`,
    `button:has-text("Continue")`,
    `.MuiButton-root:has-text("Book")`,
    `.MuiButton-containedPrimary`,
  ];
  
  const booked = await tryClick(page, bookServiceSelectors, 'book-service');
  
  if (!booked) {
    // Enhanced debugging
    try {
      log('[finalize] Taking debug screenshot for book service failure...');
      await page.screenshot({ path: `book-service-failed-${Date.now()}.png`, fullPage: true });
      
      const availableButtons = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
        return buttons.map(btn => ({
          text: btn.textContent?.trim() || '',
          className: btn.className || '',
          disabled: btn.disabled || false
        })).filter(item => item.text.length > 0);
      });
      log('[finalize] All available buttons:', JSON.stringify(availableButtons, null, 2));
    } catch (debugError) {
      warn('[finalize] Debug capture failed:', debugError.message);
    }
    
    errLog('[finalize] CRITICAL: Could not reach contact details after adding a service.');
    errLog('[finalize] This usually means the service was not properly selected or added to cart.');
    throw new Error('Could not reach contact details after adding a service. Check if service was properly selected.');
  }
  
  log('[finalize] Successfully clicked Book Service.');
  await randomDelay(1000, 3000);

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
  log(`[upholstery] Starting upholstery handling for: ${label}, qty: ${qty}`);
  
  await clickService(page, 'Upholstery');

  // Wait longer for upholstery options to load
  await waitIdle(page, 1500);
  await randomDelay(1000, 2000);
  

  // Enhanced selectors for upholstery items (handles pricing text)
  const selectors = [
    // Exact text matches
    { role: 'button', name: new RegExp(`^\\s*${escRe(label)}\\s*$`, 'i') },
    { text: new RegExp(`^\\s*${escRe(label)}\\s*$`, 'i') },
    
    // Button with text
    `button:has-text("${label}")`,
    
    // Material-UI card components (primary buttons for this site)
    `.MuiCardActionArea-root:has-text("${label}")`,
    `.MuiButtonBase-root:has-text("${label}")`,
    
    // Flexible text matching
    { text: new RegExp(escRe(label), 'i') },
    
    // CSS selector variations
    `[role="button"]:has-text("${label}")`,
    `div:has-text("${label}")[role="button"]`,
    
    // Last resort - any clickable element with the text
    `*:has-text("${label}")`,
  ];

  log(`[upholstery] Attempting to click upholstery item: "${label}"`);
  const picked = await tryClick(page, selectors, 'upholstery-item');
  
  if (!picked) {
    errLog(`[upholstery] CRITICAL: Could not click upholstery item "${label}". This will cause cascade failures.`);
    
    // Take debug screenshot
    try {
      await page.screenshot({ path: `upholstery-selection-failed-${Date.now()}.png`, fullPage: true });
      log('[upholstery] Debug screenshot saved');
    } catch {}
    
    // Stop execution to prevent cascade failures
    throw new Error(`Failed to select upholstery item "${label}". Cannot continue with empty cart.`);
  }

  log(`[upholstery] Successfully selected: ${label}`);

  // Handle quantity if needed
  if (qty && qty > 1) {
    log(`[upholstery] Setting quantity to: ${qty}`);
    const qtySet = await setQty(page, qty);
    if (!qtySet) {
      warn(`[upholstery] Could not set quantity to ${qty}, continuing with default`);
    }
  }

  await waitIdle(page, 500);
  await randomDelay(1000, 3000);
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

  log('[queue] Building queue from payload:', JSON.stringify(p, null, 2));

  if (p.carpet_cleaning && (p.carpet_cleaning === true || p.carpet_cleaning === 'True')) {
    q.push({ type: 'carpet_cleaning', bedrooms: Number(p.bedrooms || 4) });
    log('[queue] Added carpet cleaning for', Number(p.bedrooms || 4), 'bedrooms');
  }
  
  if (p.pet_stain && (p.pet_stain === true || p.pet_stain === 'True')) {
    q.push({ type: 'pet_stain' });
    log('[queue] Added pet stain service');
  }

  if (p.upholstery && (p.upholstery === true || p.upholstery === 'True')) {
    const map = {
      love_seat: 'Loveseat',
      couch: 'Couch',
      recliner: 'Recliner',
      small_sectional: 'Small Sectional',
      medium_sectional: 'Medium Sectional',
      large_sectional: 'Large Sectional',
    };
    
    let upholsteryItemsAdded = 0;
    for (const [key, label] of Object.entries(map)) {
      const qty = normInt(p[key]);
      if (qty > 0) {
        q.push({ type: 'upholstery', itemKey: key, label, qty });
        log(`[queue] Added upholstery: ${label} (qty: ${qty})`);
        upholsteryItemsAdded++;
      }
    }
    
    if (upholsteryItemsAdded === 0) {
      warn('[queue] WARNING: Upholstery service is enabled but no upholstery items have quantity > 0');
      log('[queue] Current upholstery quantities:', Object.fromEntries(
        Object.keys(map).map(key => [key, p[key] || 0])
      ));
    }
  }

  if (p.carpet_stretching && (p.carpet_stretching === true || p.carpet_stretching === 'True')) {
    q.push({ type: 'carpet_stretching' });
    log('[queue] Added carpet stretching service');
  }
  
  log(`[queue] Final queue contains ${q.length} items:`, q);
  return q;
}

const proxyConfig = {
  server: 'http://gw.dataimpulse.com:823',  
  username: 'd7ddd6e520257dcceaaa__cr.us',              
  password: '5c5ee764922cde9f'               
};

/** ======= Main ======= */
async function main() {
  const payload = JSON.parse(PAYLOAD_JSON_STRING || '{}');
  log('[loader] Using payload from environment variable');
  
  const browser = await chromium.launch({
    headless: HEADLESS,
  Proxy : proxyConfig,
    slowMo: SLOWMO,
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-accelerated-2d-canvas',
      '--no-first-run',
    '--no-zygote',
    '--single-process',
    '--disable-gpu',
    
    // Anti-bot detection
    '--disable-blink-features=AutomationControlled',
    '--disable-features=VizDisplayCompositor',
      '--disable-web-security',
    '--disable-features=TranslateUI',
    '--disable-ipc-flooding-protection',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--disable-background-timer-throttling',
    '--disable-hang-monitor',
    '--disable-client-side-phishing-detection',
    '--disable-popup-blocking',
    '--disable-default-apps',
    '--disable-extensions',
    '--disable-component-extensions-with-background-pages',
    '--disable-sync',
    
    // Make it look more human
    '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.7103.48 Safari/537.36',
    '--window-size=1920,1080'
  ]
});

  const context = await browser.newContext({
  viewport: { width: 1920, height: 1080 },
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.7103.48 Safari/537.36',
    locale: 'en-US',
  timezoneId: 'America/Los_Angeles',
    permissions: ['geolocation'],
  geolocation: { longitude: -118.2437, latitude: 34.0522 }, 
  colorScheme: 'light'
});

// Remove webdriver detection
await context.addInitScript(() => {
  // Remove webdriver property
        Object.defineProperty(navigator, 'webdriver', {
    get: () => undefined,
        });
    
  // Remove automation flags
  delete window.chrome.runtime.onConnect;
  
  // Mock human-like properties
    Object.defineProperty(navigator, 'plugins', {
    get: () => [1, 2, 3, 4, 5],
  });
  
    Object.defineProperty(navigator, 'languages', {
      get: () => ['en-US', 'en'],
    });
    
    // Add realistic screen properties
  Object.defineProperty(screen, 'availWidth', { get: () => 1920 });
  Object.defineProperty(screen, 'availHeight', { get: () => 1080 });
});


  // const context = await browser.newContext();
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
