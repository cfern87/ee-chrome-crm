// Popup for Not Another Social CRM.
//
// This is deliberately not a second CRM. It used to re-implement the contact
// list, the tag editor and a settings panel — a weaker copy of three dashboard
// screens, with its own styling, its own bugs, and no reason to prefer it. All
// of that now lives in the dashboard only.
//
// What is left is what a toolbar popup is actually good at: open the app, say
// whether anything needs attention, and jump straight to one conversation.

// chrome.storage.local's session key from license.ts, and the platform origin.
// Hardcoded because popup.js is a plain script and cannot import the module —
// keep these in step with license.ts.
const SESSION_KEY = 'crm_account_session';
const PLATFORM_URL = 'https://notanothersocialcrm.com';

/** null = not yet known, so neither the gate nor the app flashes up first. */
let signedIn = null;
let store = null;

const $ = (id) => document.getElementById(id);

function show(el, visible) {
  if (el) el.hidden = !visible;
}

function applyGate(next) {
  signedIn = next;
  show($('signInGate'), next === false);
  show($('popMain'), next === true);
}

applyGate(null);

// ---- Launcher ------------------------------------------------------------

$('openDashboardBtn').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
  window.close();
});

// ---- Status --------------------------------------------------------------

function send(msg, cb) {
  try {
    chrome.runtime.sendMessage(msg, (res) => {
      void chrome.runtime.lastError; // a sleeping worker is not an error here
      cb(res || null);
    });
  } catch (e) {
    cb(null);
  }
}

function renderStatus() {
  const contacts = store && store.conversations ? Object.keys(store.conversations).length : 0;
  $('statContacts').textContent = String(contacts);

  // Counted by the background worker, which can use the real helpers from
  // campaigns.ts. Doing it here meant two different definitions of "queued"
  // and "failed" — and this surface had the wrong one of each.
  send({ type: 'GET_NOTIFICATIONS' }, (res) => {
    if (!res || typeof res.queued !== 'number') {
      // An older worker that predates this message. Say nothing rather than
      // show a number that might be wrong.
      $('statQueue').textContent = '—';
      show($('statFailedRow'), false);
      return;
    }

    $('statQueue').textContent = res.queued === 0
      ? 'Nothing queued'
      : res.paused ? `${res.queued} (paused)` : String(res.queued);

    // Only failures the user has not already dismissed or cleared. Once they
    // clear them, the report is finished — showing them again would make the
    // clearing look broken.
    show($('statFailedRow'), res.failures > 0);
    $('statFailed').textContent = String(res.failures);
  });

  send({ type: 'GET_DEVICES' }, (res) => {
    const warn = $('statusWarning');
    if (!res) { $('statSync').textContent = 'Unknown'; show(warn, false); return; }

    if (!res.syncEnabled) {
      $('statSync').textContent = 'This machine only';
      show(warn, false);
      return;
    }

    const hold = res.sync && res.sync.hold;
    const health = res.sync && res.sync.health;
    const unreachable = health && health.kind && health.kind !== 'ok';

    if (hold) {
      $('statSync').textContent = 'On hold';
      warn.textContent = 'Sending is on hold until this machine can reach Google Drive again. Nothing is lost — the queue resumes on its own.';
      show(warn, true);
    } else if (unreachable) {
      $('statSync').textContent = 'Reconnecting';
      warn.textContent = 'Google Drive is unreachable. Sending pauses automatically rather than risk messaging anybody twice.';
      show(warn, true);
    } else {
      $('statSync').textContent = 'Up to date';
      show(warn, false);
    }
  });
}

// ---- Contact rows --------------------------------------------------------

const MAX_RESULTS = 6;

// Mirrors MAX_PINNED_CONTACTS in storage.ts. Hardcoded for the same reason
// SESSION_KEY above is: this is a plain script and cannot import the module.
// The background enforces the real cap; this only decides what to grey out.
const MAX_PINNED = 5;
const PINNED_KEY = 'pinnedContacts';

function pinnedIds() {
  const raw = store && store.settings ? store.settings[PINNED_KEY] : null;
  if (!Array.isArray(raw)) return [];
  return raw.filter((id) => typeof id === 'string' && store.conversations && store.conversations[id]).slice(0, MAX_PINNED);
}

/**
 * The tags worth drawing on a preview row: the ones that aren't marked "hide
 * in previews". Same rule as previewTags in the dashboard and as the chips the
 * content script injects into Messenger's own sidebar — a tag that sits on
 * nearly every contact is noise in a four-line list, which is exactly why the
 * user hid it in the first place.
 */
function visibleTagsFor(conv) {
  const tags = (store && store.tags) || {};
  const out = [];
  for (const id of conv.tags || []) {
    const t = tags[id];
    if (t && !t.hideInSidebar) out.push(t);
  }
  return out;
}

// Legible label over an arbitrary user-chosen tag colour. The dashboard and the
// content script both compute this properly (ui/contrast.ts); this is the same
// idea at the fidelity a plain script can manage — relative luminance of the
// hex, then black or white.
function tagTextColor(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return '#ffffff';
  const n = parseInt(m[1], 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return lum > 0.45 ? '#1c1e21' : '#ffffff';
}

/** The clickable part of a contact row: name, tag chips, and a sub-line. */
function contactButton(c) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'pop-result';
  btn.setAttribute('role', 'option');
  btn.setAttribute('aria-selected', 'false');

  const name = document.createElement('span');
  name.className = 'pop-result-name';
  name.textContent = c.participantName || 'Unknown';
  btn.appendChild(name);

  const tags = visibleTagsFor(c);
  if (tags.length > 0) {
    const row = document.createElement('span');
    row.className = 'pop-result-tags';
    for (const t of tags) {
      const chip = document.createElement('span');
      chip.className = 'pop-tag';
      chip.textContent = t.name;
      chip.style.background = t.color || '#8a8d91';
      chip.style.color = tagTextColor(t.color);
      row.appendChild(chip);
    }
    btn.appendChild(row);
  }

  const sub = document.createElement('span');
  sub.className = 'pop-result-sub';
  // No chat URL means this contact was imported or never opened, so there is
  // nowhere to send them — say so rather than opening a dead tab.
  sub.textContent = c.chatUrl ? (c.lastMessage || 'Open conversation') : 'No saved chat link';
  btn.appendChild(sub);

  if (!c.chatUrl) {
    btn.disabled = true;
    btn.style.opacity = '0.55';
    btn.style.cursor = 'not-allowed';
  } else {
    btn.addEventListener('click', () => {
      chrome.tabs.create({ url: c.chatUrl });
      window.close();
    });
  }
  return btn;
}

/**
 * The pin toggle. Writes through the background's mutation channel rather than
 * saving a store: this popup's snapshot is up to 5s old (it polls), and writing
 * that back wholesale is precisely the clobber the mutation layer exists to
 * prevent — a tag added in Messenger a second ago would be undone by a pin.
 */
function pinButton(c, isPinned) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'pop-pin-btn';
  btn.textContent = isPinned ? '★' : '☆';
  btn.setAttribute('aria-pressed', String(isPinned));
  const atCap = !isPinned && pinnedIds().length >= MAX_PINNED;
  btn.title = isPinned
    ? 'Unpin from the top of this popup'
    : atCap
      ? `Pin — the oldest of your ${MAX_PINNED} pins drops off`
      : 'Pin to the top of this popup';

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    btn.disabled = true;
    send({
      type: 'MUTATE_STORE',
      payload: { mutations: [{ op: 'setPinned', conversationId: c.id, pinned: !isPinned }] },
    }, (res) => {
      btn.disabled = false;
      // The response carries the post-mutation store, so the popup repaints
      // from what actually landed rather than from an optimistic guess.
      if (res && res.store) store = res.store;
      renderPinned();
      renderResults($('quickSearch').value);
    });
  });
  return btn;
}

/**
 * The pinned list: one small chip per contact, name only.
 *
 * Compact on purpose. This sits above the search box in a 340px popup, so it
 * competes directly with the reason people opened it — rendering five pinned
 * contacts as full result rows (name, tags, last message) filled most of the
 * window with things the user already knows. A pinned contact is one you
 * recognize by name, which is the only thing worth showing.
 */
function renderPinned() {
  const block = $('pinnedBlock');
  const list = $('pinnedList');
  list.textContent = '';

  const ids = pinnedIds();
  show(block, ids.length > 0);
  if (ids.length === 0) return;

  for (const id of ids) {
    const c = store.conversations[id];

    const chip = document.createElement('div');
    chip.className = 'pop-pin-chip';

    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'pop-pin-name';
    open.textContent = c.participantName || 'Unknown';
    if (c.chatUrl) {
      open.title = `Open chat with ${c.participantName || 'this contact'}`;
      open.addEventListener('click', () => {
        chrome.tabs.create({ url: c.chatUrl });
        window.close();
      });
    } else {
      // Pinned but unreachable — imported, or never opened in Messenger. Say so
      // on hover rather than opening a dead tab.
      open.disabled = true;
      open.title = 'No saved chat link for this contact yet';
    }

    const unpin = document.createElement('button');
    unpin.type = 'button';
    unpin.className = 'pop-pin-x';
    unpin.textContent = '✕';
    unpin.title = `Unpin ${c.participantName || 'this contact'}`;
    unpin.setAttribute('aria-label', `Unpin ${c.participantName || 'this contact'}`);
    unpin.addEventListener('click', (e) => {
      e.stopPropagation();
      unpin.disabled = true;
      send({
        type: 'MUTATE_STORE',
        payload: { mutations: [{ op: 'setPinned', conversationId: c.id, pinned: false }] },
      }, (res) => {
        if (res && res.store) store = res.store;
        renderPinned();
        renderResults($('quickSearch').value);
      });
    });

    chip.appendChild(open);
    chip.appendChild(unpin);
    list.appendChild(chip);
  }
}

function renderResults(term) {
  const box = $('quickResults');
  const hint = $('quickHint');
  const pinHint = $('pinHint');
  box.textContent = '';
  show(pinHint, false);

  const q = term.trim().toLowerCase();
  if (!q) {
    hint.textContent = 'Type a name to open that conversation in Messenger.';
    if (pinnedIds().length === 0) {
      pinHint.textContent = `Search for someone and press ☆ to keep them at the top (up to ${MAX_PINNED}).`;
      show(pinHint, true);
    }
    return;
  }

  const all = store && store.conversations ? Object.values(store.conversations) : [];
  const matches = all
    .filter((c) => (c.participantName || '').toLowerCase().includes(q))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .slice(0, MAX_RESULTS);

  if (matches.length === 0) {
    hint.textContent = `No contact matches "${term.trim()}".`;
    return;
  }

  hint.textContent = matches.length === 1 ? '1 match' : `${matches.length} matches`;

  const pinned = new Set(pinnedIds());
  for (const c of matches) {
    // The fuller row — name, tags, last message — unlike the pinned chips
    // above. You are scanning unfamiliar names here, so those details are what
    // tell two similar results apart; a pinned contact needs none of it.
    const row = document.createElement('div');
    row.className = 'pop-pin-row';
    row.appendChild(contactButton(c));
    row.appendChild(pinButton(c, pinned.has(c.id)));
    box.appendChild(row);
  }
}

$('quickSearch').addEventListener('input', (e) => renderResults(e.target.value));

// ---- Account -------------------------------------------------------------

function renderAccount(info) {
  const ent = (info && info.entitlement) || { signedIn: false };
  if (!ent.signedIn) return;

  $('acctEmailLabel').textContent = ent.email || (info && info.email) || 'Signed in';

  let plan;
  if (ent.isPro) {
    plan = ent.status === 'trialing' ? 'Pro — free trial' : 'Pro — unlimited contacts and Drive sync';
  } else {
    const limit = ent.contactsLimit == null ? 25 : ent.contactsLimit;
    plan = `Free — up to ${limit} contacts, no Drive sync`;
  }
  if (ent.stale) plan += ' (offline — showing your last known plan)';
  $('acctPlanLabel').textContent = plan;

  $('acctUpgradeBtn').textContent = ent.isPro ? 'Manage plan' : 'Upgrade';
}

function loadStoreThen(cb) {
  send({ type: 'GET_STORE' }, (s) => {
    if (s) store = s;
    if (cb) cb();
  });
}

function loadAccount() {
  send({ type: 'GET_ACCOUNT' }, (info) => {
    if (!info) return;
    renderAccount(info);

    const ent = info.entitlement || {};
    const isIn = typeof info.signedIn === 'boolean' ? info.signedIn : !!ent.signedIn;
    const was = signedIn;
    applyGate(isIn);

    if (isIn && was !== true) {
      loadStoreThen(() => { renderStatus(); renderPinned(); renderResults($('quickSearch').value); });
    }
  });
}

// ---- Sign-in -------------------------------------------------------------

function setGateError(msg) {
  const el = $('gateError');
  el.textContent = msg || '';
  show(el, !!msg);
}

$('gateGoogleBtn').addEventListener('click', () => {
  // Google sign-in runs on the website and hands the session back to the
  // extension. Close the popup so the new tab has focus.
  send({ type: 'ACCOUNT_SIGN_IN_WEB' }, () => window.close());
});

$('gateSignInBtn').addEventListener('click', () => {
  const email = $('gateEmail').value.trim();
  const password = $('gatePassword').value;
  if (!email || !password) { setGateError('Enter your email and password.'); return; }

  setGateError('');
  const btn = $('gateSignInBtn');
  btn.disabled = true;
  btn.textContent = 'Signing in…';
  send({ type: 'ACCOUNT_SIGN_IN', payload: { email, password } }, (res) => {
    btn.disabled = false;
    btn.textContent = 'Sign in';
    if (!res) { setGateError('Could not reach the extension worker.'); return; }
    if (!res.ok) { setGateError(res.error || 'Sign-in failed.'); return; }
    $('gatePassword').value = '';
    loadAccount();
  });
});

$('gateCreateLink').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: PLATFORM_URL + '/auth' });
});

$('acctSignOutBtn').addEventListener('click', () => {
  send({ type: 'ACCOUNT_SIGN_OUT' }, () => loadAccount());
});

$('acctUpgradeBtn').addEventListener('click', () => {
  chrome.tabs.create({ url: PLATFORM_URL + '/account/billing' });
});

// ---- Wiring --------------------------------------------------------------

loadAccount();

// Signed in or out elsewhere (the website's hand-off, another surface).
try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && SESSION_KEY in changes) loadAccount();
  });
} catch (e) {
  /* no storage events — loadAccount on open is the fallback */
}

// The popup is short-lived, so this only ticks while it is actually open.
// The pinned list is repainted too: a contact deleted or renamed elsewhere
// shouldn't sit here stale for as long as the popup stays open.
setInterval(() => {
  if (signedIn) loadStoreThen(() => { renderStatus(); renderPinned(); });
}, 5000);
