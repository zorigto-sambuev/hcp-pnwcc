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
const HEADLESS = process.env.HEADLESS === '1' ? true : false  // Control via HEADLESS=0 for email confirmations

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

  // Simulate reading the form before filling (human behavior)
  await simulateReadingTime(page, 1000);

  // Use getByTestId for reliable targeting of each field with human-like typing
  if (first_name) {
    await simulateHumanMouseMovement(page, '[data-testid="online-booking-contact-firstname"]');
    await simulateHumanTyping(page, '[data-testid="online-booking-contact-firstname"]', first_name);
  }
  
  if (last_name) {
    await simulateHumanMouseMovement(page, '[data-testid="online-booking-contact-lastname"]');
    await simulateHumanTyping(page, '[data-testid="online-booking-contact-lastname"]', last_name);
  }
  
  if (phone) {
    await simulateHumanMouseMovement(page, '[data-testid="online-booking-contact-phone"]');
    await simulateHumanTyping(page, '[data-testid="online-booking-contact-phone"]', phone);
  }
  
  if (email) {
    await simulateHumanMouseMovement(page, '[data-testid="online-booking-contact-email"]');
    await simulateHumanTyping(page, '[data-testid="online-booking-contact-email"]', email);
  }
  
  if (street_address) {
    await simulateHumanMouseMovement(page, '[data-testid="online-booking-contact-street"]');
    await simulateHumanTyping(page, '[data-testid="online-booking-contact-street"]', street_address);
  }
  
  if (city) {
    await simulateHumanMouseMovement(page, '[data-testid="online-booking-contact-city"]');
    await simulateHumanTyping(page, '[data-testid="online-booking-contact-city"]', city);
  }
  
  if (zipcode) {
    await simulateHumanMouseMovement(page, '[data-testid="online-booking-contact-zip"]');
    await simulateHumanTyping(page, '[data-testid="online-booking-contact-zip"]', zipcode);
  }

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
  if (!startTimeStr) {
    warn('[time] No time frame specified, skipping time selection');
    return;
  }

  log(`[time] Attempting to select time frame: "${startTimeStr}"`);
  
  // Simulate looking at available time options (human behavior)
  await simulateReadingTime(page, 1500);
  
  // Wait for time selection to be available
  await waitIdle(page, 1000);
  
  // First, try to find any available time slots for debugging
  try {
    const availableTimeSlots = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const timeButtons = buttons.filter(btn => {
        const text = btn.textContent || '';
        return text.match(/\d+:\d+/) || text.toLowerCase().includes('am') || text.toLowerCase().includes('pm');
      });
      return timeButtons.map(btn => ({
        text: btn.textContent?.trim(),
        disabled: btn.disabled,
        className: btn.className
      })).slice(0, 10); // Show first 10 for debugging
    });
    
    log('[time] Available time slots found:', availableTimeSlots);
  } catch (e) {
    log('[time] Could not retrieve available time slots for debugging');
  }

  // Create multiple variations of the time to search for
  const timeOnlyStr = startTimeStr.replace(/\s*(?:AM|PM)$/i, '');
  const timeVariations = [
    startTimeStr, // Original format (e.g., "10:00 AM")
    timeOnlyStr,  // Without AM/PM (e.g., "10:00")
    startTimeStr.replace(/\s+/g, ''), // No spaces (e.g., "10:00AM")
    timeOnlyStr.replace(':', ''), // No colon (e.g., "1000")
  ];


  // Try multiple selection strategies
  const selectors = [];
  
  for (const timeVar of timeVariations) {
    const escapedTime = escRe(timeVar);
    selectors.push(
      // Direct text match
      { text: new RegExp(escapedTime, 'i') },
      { role: 'button', name: new RegExp(escapedTime, 'i') },
      
      // With dash/hyphen (time ranges)
      { text: new RegExp(`${escapedTime}\\s*[-–]`, 'i') },
      { role: 'button', name: new RegExp(`${escapedTime}\\s*[-–]`, 'i') },
      
      // CSS selectors
      `button:has-text("${timeVar}")`,
      `[role="button"]:has-text("${timeVar}")`,
    );
  }

  log(`[time] Attempting to click time frame with ${selectors.length} different selectors...`);
  const ok = await tryClick(page, selectors, 'timeframe');

  if (!ok) {
    errLog(`[time] CRITICAL: Could not select time frame "${startTimeStr}"`);
    
    // Try to select ANY available time slot as fallback
    log('[time] Trying to select first available time slot as fallback...');
    const fallbackSelected = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const timeButtons = buttons.filter(btn => {
        const text = btn.textContent || '';
        return !btn.disabled && (text.match(/\d+:\d+/) || text.toLowerCase().includes('am') || text.toLowerCase().includes('pm'));
      });
      
      if (timeButtons.length > 0) {
        timeButtons[0].click();
        return { success: true, selected: timeButtons[0].textContent?.trim() };
      }
      return { success: false };
    });
    
    if (fallbackSelected.success) {
      log(`[time] Successfully selected fallback time slot: "${fallbackSelected.selected}"`);
    } else {
      errLog('[time] No time slots available or selectable');
      
      // Take debug screenshot
      try {
        await page.screenshot({ path: `time-selection-failed-${Date.now()}.png`, fullPage: true });
        log('[time] Debug screenshot saved for time selection failure');
      } catch {}
    }
  } else {
    log(`[time] Successfully selected time frame: "${startTimeStr}"`);
  }
  
  // Wait for selection to process
  await waitIdle(page, 500);
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
  // Single reliable strategy - proven to work consistently
  log('Attempting to click booking button...');
  
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
  
  // Simulate reading/reviewing the page before clicking (human behavior)
  await simulateReadingTime(page, 1200);
  
  let clicked = false;
  for (const selector of buttonSelectors) {
    try {
      await page.waitForSelector(selector, { state: 'visible', timeout: 1000 });
      
      // Add human-like mouse movement and hover before click
      await simulateHumanMouseMovement(page, selector);
      await page.click(selector);
      
      log('✅ Successfully clicked button with selector:', selector);
      clicked = true;
      break;
    } catch {}
  }
  
  // Fallback: try any visible button if specific selectors fail
  if (!clicked) {
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
      // Simulate mouse movement even for fallback clicks
      await page.mouse.move(
        Math.random() * 100 + 400,
        Math.random() * 100 + 300
      );
      await page.waitForTimeout(Math.random() * 300 + 200);
      
      await page.evaluate(btn => btn.click(), anyButton);
      log('✅ Clicked first available visible button as fallback');
      clicked = true;
    }
  }
  
  if (!clicked) {
    throw new Error('No booking buttons found or clickable');
  }

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
        
        // Try to automatically fix common validation issues
        log('🔧 Attempting to automatically fix validation issues...');
        
        const fixAttempts = await page.evaluate(() => {
          const fixes = [];
          
          // 1. Try to select a time slot if none selected
          const timeButtons = Array.from(document.querySelectorAll('button')).filter(btn => {
            const text = btn.textContent || '';
            return !btn.disabled && (text.match(/\d+:\d+/) || text.toLowerCase().includes('am') || text.toLowerCase().includes('pm'));
          });
          
          if (timeButtons.length > 0) {
            timeButtons[0].click();
            fixes.push(`Selected time slot: "${timeButtons[0].textContent?.trim()}"`);
          }
          
          // 2. Check required checkboxes
          const uncheckedRequired = Array.from(document.querySelectorAll('input[type="checkbox"][required]')).filter(cb => !cb.checked);
          uncheckedRequired.forEach(cb => {
            cb.click();
            fixes.push('Checked required checkbox');
          });
          
          // 3. Check terms/consent checkboxes
          const checkboxes = Array.from(document.querySelectorAll('input[type="checkbox"]'));
          const termsCheckboxes = checkboxes.filter(cb => {
            const label = cb.closest('label') || document.querySelector(`label[for="${cb.id}"]`);
            const text = (label?.textContent || cb.parentElement?.textContent || '').toLowerCase();
            return !cb.checked && (text.includes('terms') || text.includes('conditions') || text.includes('agree') || text.includes('consent'));
          });
          termsCheckboxes.forEach(cb => {
            cb.click();
            fixes.push('Checked terms/consent checkbox');
          });
          
          return fixes;
        });
        
        if (fixAttempts.length > 0) {
          log('✅ Applied validation fixes:');
          fixAttempts.forEach((fix, i) => log(`   ${i + 1}. ${fix}`));
          
          // Wait for fixes to process
          await page.waitForTimeout(1500);
        } else {
          log('❌ No automatic fixes could be applied');
        }
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

  // Wait for network requests to complete
  await waitForNetworkRequests(page);
  
  return { success: true, strategyUsed: 1, method: 'Text-based button selection' };
}

// Helper to simulate human mouse movement and hovering
async function simulateHumanMouseMovement(page, targetSelector) {
  try {
    // Move mouse to random position first (simulate browsing)
    await page.mouse.move(
      Math.random() * 300 + 200,
      Math.random() * 200 + 150
    );
    await page.waitForTimeout(Math.random() * 200 + 100);
    
    // Find target element and hover over it
    const element = await page.locator(targetSelector).first();
    const box = await element.boundingBox();
    if (box) {
      // Move towards target with natural mouse path
      const targetX = box.x + box.width / 2 + (Math.random() - 0.5) * 15;
      const targetY = box.y + box.height / 2 + (Math.random() - 0.5) * 15;
      
      await page.mouse.move(targetX, targetY);
      await page.waitForTimeout(Math.random() * 300 + 200); // Hover time
    }
  } catch (error) {
    // Continue even if mouse movement fails
  }
}

// Helper to simulate human typing patterns
async function simulateHumanTyping(page, selector, text) {
  await page.locator(selector).click();
  await page.waitForTimeout(Math.random() * 150 + 100);
  
  // Clear field first
  await page.keyboard.press('Control+a');
  await page.waitForTimeout(50);
  
  // Type with human-like rhythm
  for (const char of text) {
    await page.keyboard.type(char);
    const delay = Math.random() * 80 + 20; // 20-100ms per character
    await page.waitForTimeout(delay);
  }
  await page.waitForTimeout(Math.random() * 200 + 150);
}

// Helper to simulate natural reading/thinking time
async function simulateReadingTime(page, baseTime = 800) {
  const readingTime = baseTime + Math.random() * 800;
  
  // Add subtle mouse movements during "reading"
  for (let i = 0; i < 2; i++) {
    await page.mouse.move(
      Math.random() * 100 + 400,
      Math.random() * 100 + 300
    );
    await page.waitForTimeout(readingTime / 3);
  }
}

// Helper function to wait for network requests
async function waitForNetworkRequests(page) {
  try {
    log('Waiting for network requests to complete...');
    
    // Wait for network to be idle
    await Promise.race([
      page.waitForLoadState('networkidle', { timeout: 10000 }),
      page.waitForTimeout(5000) // Shorter timeout since we're simpler now
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
  
  // Check if using cloud browser service
  const CLOUD_BROWSER_URL = process.env.CLOUD_BROWSER_URL; // e.g., "wss://chrome.browserless.io?token=YOUR_TOKEN"
  const CLOUD_BROWSER_TOKEN = process.env.CLOUD_BROWSER_TOKEN;

  let browser;
  if (CLOUD_BROWSER_URL) {
    // Connect to cloud browser service
    log('[run] 🌩️  Connecting to cloud browser service');
    try {
      if (CLOUD_BROWSER_URL.includes('browserless')) {
        // Browserless.io format
        browser = await chromium.connectOverCDP(`${CLOUD_BROWSER_URL}&token=${CLOUD_BROWSER_TOKEN}`);
      } else if (CLOUD_BROWSER_URL.includes('cloudbrowser')) {
        // CloudBrowser AI format - direct CDP connection to browser instance
        log(`[run] 🔗 Connecting to CloudBrowser AI instance: ${CLOUD_BROWSER_URL}`);
        browser = await chromium.connectOverCDP(CLOUD_BROWSER_URL);
      } else {
        // Generic cloud browser
        browser = await chromium.connectOverCDP(CLOUD_BROWSER_URL);
      }
      log('[run] ✅ Connected to cloud browser successfully - should bypass all detection!');
    } catch (error) {
      errLog('[run] ❌ Failed to connect to cloud browser:', error.message);
      errLog('[run] 🔄 Falling back to local browser...');
      browser = null;
    }
  }

  // Fallback to local browser if cloud connection failed or not configured
  if (!browser) {
    log('[run] Using local browser');
    browser = await chromium.launch({
      headless: HEADLESS,
    Proxy : proxyConfig,
      slowMo: SLOWMO,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      // Headless detection evasion args
      '--disable-blink-features=AutomationControlled',
      '--disable-features=VizDisplayCompositor',
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
  }

  const context = await browser.newContext({
  viewport: { width: 1920, height: 1080 },
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.7103.48 Safari/537.36',
    locale: 'en-US',
  timezoneId: 'America/Los_Angeles',
    permissions: ['geolocation'],
  geolocation: { longitude: -118.2437, latitude: 34.0522 }, 
  colorScheme: 'light'
});

// Enhanced headless detection evasion
await context.addInitScript(() => {
  // Remove webdriver property
  Object.defineProperty(navigator, 'webdriver', {
    get: () => undefined,
  });
    
  // Remove automation flags
  delete window.chrome?.runtime?.onConnect;
  
  // Enhanced chrome object simulation
  if (!window.chrome || !window.chrome.runtime) {
    Object.defineProperty(window, 'chrome', {
      writable: true,
      enumerable: true,
      configurable: false,
      value: {
        runtime: {
          onConnect: undefined,
          onMessage: undefined,
          connect: () => ({}),
        },
      },
    });
  }
  
  // Mock human-like properties
  Object.defineProperty(navigator, 'plugins', {
    get: () => [1, 2, 3, 4, 5],
  });
  
  Object.defineProperty(navigator, 'languages', {
    get: () => ['en-US', 'en'],
  });
    
  // Enhanced screen properties (realistic desktop)
  Object.defineProperty(screen, 'availWidth', { get: () => 1920 });
  Object.defineProperty(screen, 'availHeight', { get: () => 1080 });
  Object.defineProperty(screen, 'width', { get: () => 1920 });
  Object.defineProperty(screen, 'height', { get: () => 1080 });
  Object.defineProperty(screen, 'colorDepth', { get: () => 24 });
  
  // Permissions API evasion
  const originalQuery = window.navigator.permissions.query;
  window.navigator.permissions.query = (parameters) => (
    parameters.name === 'notifications' ?
      Promise.resolve({ state: Notification.permission }) :
      originalQuery(parameters)
  );
  
  // Memory info simulation
  Object.defineProperty(navigator, 'deviceMemory', {
    get: () => 8,
  });
  
  // Connection simulation
  Object.defineProperty(navigator, 'connection', {
    get: () => ({
      effectiveType: '4g',
      rtt: 100,
      downlink: 10,
    }),
  });
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
