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

// ---- Quick search --------------------------------------------------------

const MAX_RESULTS = 6;

function renderResults(term) {
  const box = $('quickResults');
  const hint = $('quickHint');
  box.textContent = '';

  const q = term.trim().toLowerCase();
  if (!q) {
    hint.textContent = 'Type a name to open that conversation in Messenger.';
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

  for (const c of matches) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pop-result';
    btn.setAttribute('role', 'option');
    btn.setAttribute('aria-selected', 'false');

    const name = document.createElement('span');
    name.className = 'pop-result-name';
    name.textContent = c.participantName || 'Unknown';

    const sub = document.createElement('span');
    sub.className = 'pop-result-sub';
    // No chat URL means this contact was imported or never opened, so there is
    // nowhere to send them — say so rather than opening a dead tab.
    sub.textContent = c.chatUrl ? (c.lastMessage || 'Open conversation') : 'No saved chat link';

    btn.appendChild(name);
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

    box.appendChild(btn);
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
      loadStoreThen(() => { renderStatus(); renderResults($('quickSearch').value); });
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
setInterval(() => {
  if (signedIn) loadStoreThen(renderStatus);
}, 5000);
