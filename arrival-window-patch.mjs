// arrival-window-patch.mjs
// Selects a 2-hour arrival window by matching the *start* time only
// e.g. "10:00 AM" -> clicks "10:00 - 12:00pm" (or "10:00-12:00 pm", etc.)

function startKeyFromTimeString(s) {
  if (!s) return null;
  const m = String(s).trim().match(/(\d{1,2})(?::(\d{2}))?/i);
  if (!m) return null;
  const h = String(parseInt(m[1], 10));      // strip leading zero
  const mm = m[2] ? m[2] : "00";
  return `${h}:${mm}`;                        // "10:00", "9:30"
}

function startKeyFromSlotLabel(label) {
  if (!label) return null;
  // Examples: "10:00 - 12:00pm", "9:30-11:30 am"
  const m = String(label).trim().match(/^\s*(\d{1,2})(?::(\d{2}))?\s*(?:am|pm)?\s*[-–]/i);
  if (!m) return null;
  const h = String(parseInt(m[1], 10));
  const mm = m[2] ? m[2] : "00";
  return `${h}:${mm}`;
}

export async function selectArrivalWindowByStart(page, startStr) {
  const wantKey = startKeyFromTimeString(startStr);
  if (!wantKey) throw new Error(`[time] Invalid time_frame_start: ${startStr}`);

  // Give the grid a moment to render
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(250);

  const allButtons = await page.getByRole('button').all();
  const seen = [];
  let clicked = false;

  for (const btn of allButtons) {
    const raw = (await btn.innerText()).replace(/\s+/g, ' ').trim();

    // keep only items that look like a time range
    if (!/(\d{1,2})(?::\d{2})?\s*(?:am|pm)?\s*[-–]\s*(\d{1,2})(?::\d{2})?\s*(?:am|pm)/i.test(raw)) {
      continue;
    }

    const key = startKeyFromSlotLabel(raw);
    if (key) seen.push(raw);

    if (key === wantKey) {
      await btn.scrollIntoViewIfNeeded().catch(() => {});
      await btn.click({ timeout: 5000 });
      clicked = true;
      break;
    }
  }

  // Fallback: direct regex search by the start fragment (handles odd spacing/labels)
  if (!clicked) {
    const safe = wantKey.replace(':', '\\:');
    const rx = new RegExp(`^\\s*${safe}\\s*(?:am|pm)?\\s*[-–]`, 'i');
    const cand = page.getByRole('button', { name: rx }).first();
    if (await cand.count()) {
      await cand.scrollIntoViewIfNeeded().catch(() => {});
      await cand.click({ timeout: 5000 });
      clicked = true;
    }
  }

  if (!clicked) {
    console.error(`[time] Wanted start="${startStr}" -> key="${wantKey}". Slots seen: ${JSON.stringify(seen)}`);
    throw new Error(`Could not find a time slot starting at ${startStr}`);
  }

  // Click NEXT (wait until it becomes enabled)
  const nextBtn = page.getByRole('button', { name: /^next$/i }).first();
  await nextBtn.waitFor({ timeout: 8000 });

  // Wait until not disabled (handles UI that enables after selection)
  const deadline = Date.now() + 7000;
  while (Date.now() < deadline) {
    if (!(await nextBtn.isDisabled().catch(() => true))) break;
    await page.waitForTimeout(150);
  }

  await nextBtn.click({ timeout: 5000 });
}
