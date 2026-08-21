const TAB_SCHEDULE = 'Schedule';
const TAB_LABS = 'Labs';
const TAB_SIGNUPS = 'Signups';
const TAB_SETTINGS = 'Settings';
const TAB_LOG = 'Log';

const REMINDER_DAYS = [28, 14, 3];

/* Each date carries this many presenter slots, numbered from 1. */
const SLOTS = [1, 2];
const SLOT_LABELS = ['first', 'second'];

const DEFAULT_SETTINGS = [
  ['seriesName', 'Departmental Seminar Series'],
  ['tagline', 'Weekly research talks'],
  ['location', 'Room TBD'],
  ['startTime', '12:00'],
  ['endTime', '13:00'],
  ['seasonStart', ''],
  ['seasonEnd', ''],
  ['organizerName', ''],
  ['organizerEmail', ''],
  ['siteUrl', ''],
  ['adminPasscode', ''],
  ['remindersEnabled', 'yes'],
  ['copyOrganizer', 'yes']
];

/* ---------- entry points ---------- */

function doGet(e) {
  const p = (e && e.parameter) || {};
  const action = p.action || 'schedule';
  try {
    if (action === 'ics') {
      return ContentService.createTextOutput(buildIcs())
        .setMimeType(ContentService.MimeType.ICAL);
    }
    if (action === 'admin') return reply(adminPayload(p.code || ''), p.callback);
    return reply(publicPayload(), p.callback);
  } catch (err) {
    return reply({ ok: false, error: String(err && err.message || err) }, p.callback);
  }
}

function doPost(e) {
  const params = (e && e.parameter) || {};
  let body = {};
  try {
    if (e && e.postData && e.postData.contents) body = JSON.parse(e.postData.contents);
  } catch (_) { body = {}; }
  if ((!body || !body.action) && params.payload) {
    try { body = JSON.parse(params.payload); } catch (_) { body = {}; }
  }

  let out;
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
    out = route(body || {});
  } catch (err) {
    out = { ok: false, error: String(err && err.message || err) };
  } finally {
    try { lock.releaseLock(); } catch (_) {}
  }

  if (params.frame === '1') return frameReply(out);
  return reply(out, body && body.callback);
}

function route(b) {
  switch (b.action) {
    case 'unlock': return unlock(b);
    case 'signup': return submitSignup(b);
    case 'withdraw': return withdrawSignup(b);
    case 'admin': return adminPayload(b.code || '');
    default: return { ok: false, error: 'Unknown request.' };
  }
}

function reply(obj, callback) {
  const json = JSON.stringify(obj);
  if (callback && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(callback)) {
    return ContentService.createTextOutput(callback + '(' + json + ');')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}

function frameReply(obj) {
  const json = JSON.stringify(obj).replace(/</g, '\\u003c');
  return HtmlService.createHtmlOutput(
    '<!doctype html><meta charset="utf-8"><script>' +
    'parent.postMessage({source:"seminar-api",payload:' + json + '},"*");' +
    '<\/script>'
  ).setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/* ---------- sheet access ---------- */

function book() { return SpreadsheetApp.getActive(); }

function tab(name) {
  const s = book().getSheetByName(name);
  if (!s) throw new Error('Missing tab "' + name + '". Run Seminar \u2192 Set up this sheet.');
  return s;
}

function key(h) { return String(h).toLowerCase().replace(/[^a-z0-9]/g, ''); }

function table(name) {
  const sh = tab(name);
  const values = sh.getDataRange().getValues();
  if (values.length < 1) return { sheet: sh, keys: [], rows: [] };
  const keys = values[0].map(key);
  const rows = [];
  for (let i = 1; i < values.length; i++) {
    const raw = values[i];
    if (raw.every(function (c) { return c === '' || c === null; })) continue;
    const o = { _row: i + 1 };
    keys.forEach(function (k, j) { if (k) o[k] = raw[j]; });
    rows.push(o);
  }
  return { sheet: sh, keys: keys, rows: rows };
}

function colIndex(t, k) { return t.keys.indexOf(k) + 1; }

/* Build a row in the sheet's own column order, so a migrated sheet whose new
   columns were appended at the end is written correctly. */
function rowValues(t, obj) {
  return t.keys.map(function (k) {
    return Object.prototype.hasOwnProperty.call(obj, k) ? obj[k] : '';
  });
}

function tz() {
  return book().getSpreadsheetTimeZone() || Session.getScriptTimeZone() || 'America/Vancouver';
}

function fmtDate(d) { return Utilities.formatDate(d, tz(), 'yyyy-MM-dd'); }

function normDate(v) {
  if (v instanceof Date && !isNaN(v)) return fmtDate(v);
  const s = String(v == null ? '' : v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return m[1] + '-' + pad(m[2]) + '-' + pad(m[3]);
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return m[3] + '-' + pad(m[1]) + '-' + pad(m[2]);
  const d = new Date(s);
  return isNaN(d) ? '' : fmtDate(d);
}

function pad(n) { return ('0' + n).slice(-2); }
function text(v, max) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max || 500); }
function norm(v) { return String(v == null ? '' : v).replace(/\s+/g, '').toLowerCase(); }
function isEmail(v) { return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(v || '').trim()); }
function fail(msg) { return { ok: false, error: msg }; }

/* Presenter slot number. Anything unrecognised — including the blank cells on
   rows written before there were two presenters — is slot 1. */
function slotNum(v) {
  const n = Math.round(Number(v));
  return SLOTS.indexOf(n) >= 0 ? n : SLOTS[0];
}
function slotKey(date, n) { return date + '|' + slotNum(n); }

/* ---------- data ---------- */

function settings() {
  const t = table(TAB_SETTINGS);
  const o = {};
  t.rows.forEach(function (r) {
    const k = String(r.setting == null ? '' : r.setting).trim();
    if (k) o[k] = String(r.value == null ? '' : r.value).trim();
  });
  return o;
}

function labs() {
  return table(TAB_LABS).rows.map(function (r) {
    return {
      name: text(r.lab, 120),
      contactName: text(r.contactname, 120),
      emails: String(r.contactemails == null ? '' : r.contactemails)
        .split(/[,;\s]+/).map(function (s) { return s.trim(); }).filter(isEmail),
      passcode: text(r.passcode, 60)
    };
  }).filter(function (l) { return l.name; });
}

function labByName(name) {
  const n = norm(name);
  return labs().filter(function (l) { return norm(l.name) === n; })[0] || null;
}

function scheduleRows() {
  return table(TAB_SCHEDULE).rows.map(function (r) {
    const type = (text(r.type, 20) || 'talk').toLowerCase();
    return {
      _row: r._row,
      date: normDate(r.date),
      /* "Lab" is the pre-two-presenter header; it reads as the first slot. */
      labs: [text(r.lab1 != null && r.lab1 !== '' ? r.lab1 : r.lab, 120), text(r.lab2, 120)],
      type: ['talk', 'break', 'special'].indexOf(type) >= 0 ? type : 'talk',
      note: text(r.note, 300)
    };
  }).filter(function (r) { return r.date; })
    .sort(function (a, b) { return a.date < b.date ? -1 : 1; });
}

function labAt(row, n) { return row.labs[slotNum(n) - 1] || ''; }

function signupMap() {
  const t = table(TAB_SIGNUPS);
  const m = {};
  t.rows.forEach(function (r) {
    const d = normDate(r.date);
    if (!d) return;
    const n = slotNum(r.slot);
    m[slotKey(d, n)] = {
      _row: r._row,
      date: d,
      slot: n,
      lab: text(r.lab, 120),
      speaker: text(r.speaker, 120),
      email: text(r.email, 160),
      title: text(r.title, 300),
      updatedAt: r.updatedat instanceof Date ? r.updatedat.toISOString() : String(r.updatedat || '')
    };
  });
  return m;
}

/* One date, carrying every presenter slot on it. */
function dayView(row, signups, includeEmail) {
  const day = { date: row.date, type: row.type, note: row.note, talks: [] };
  SLOTS.forEach(function (n) {
    const signup = signups[slotKey(row.date, n)];
    const talk = {
      n: n,
      lab: labAt(row, n),
      speaker: signup ? signup.speaker : '',
      title: signup ? signup.title : '',
      filled: !!(signup && signup.speaker && signup.title)
    };
    if (includeEmail && signup) talk.email = signup.email;
    day.talks.push(talk);
  });
  return day;
}

function publicPayload() {
  const st = settings();
  const rows = scheduleRows();
  const signups = signupMap();
  return {
    ok: true,
    generated: new Date().toISOString(),
    settings: {
      seriesName: st.seriesName || 'Seminar Series',
      tagline: st.tagline || '',
      location: st.location || '',
      startTime: st.startTime || '',
      endTime: st.endTime || '',
      organizerName: st.organizerName || '',
      organizerEmail: st.organizerEmail || '',
      timezone: tz()
    },
    labs: labs().map(function (l) { return l.name; }),
    slots: rows.map(function (r) { return dayView(r, signups, false); })
  };
}

function adminPayload(code) {
  const st = settings();
  if (!st.adminPasscode || norm(code) !== norm(st.adminPasscode)) {
    return fail('That organizer code was not recognised.');
  }
  const rows = scheduleRows();
  const signups = signupMap();
  const base = publicPayload();
  base.admin = true;
  base.slots = rows.map(function (r) { return dayView(r, signups, true); });
  base.labDetail = labs().map(function (l) {
    return { name: l.name, contactName: l.contactName, emails: l.emails, passcode: l.passcode };
  });
  return base;
}

/* ---------- authorisation ---------- */

function authorize(code, labName) {
  const st = settings();
  const given = norm(code);
  if (!given) return fail('Enter your lab access code.');
  if (st.adminPasscode && given === norm(st.adminPasscode)) return { ok: true, lab: labName || '', admin: true };
  const all = labs();
  const match = all.filter(function (l) { return l.passcode && norm(l.passcode) === given; })[0];
  if (!match) return fail('That access code was not recognised.');
  if (labName && norm(match.name) !== norm(labName)) {
    return fail('That code belongs to ' + match.name + ', which is not scheduled for this date.');
  }
  return { ok: true, lab: match.name, admin: false };
}

function unlock(b) {
  if (b.website) return fail('Rejected.');
  const auth = authorize(b.passcode, '');
  if (!auth.ok) return auth;
  const rows = scheduleRows();
  const mine = auth.admin ? rows.map(function (r) { return r.date; })
    : rows.filter(function (r) {
      return r.labs.some(function (l) { return l && norm(l) === norm(auth.lab); });
    }).map(function (r) { return r.date; });
  return { ok: true, lab: auth.lab, admin: auth.admin, dates: mine };
}

/* ---------- signups ---------- */

function submitSignup(b) {
  if (b.website) return fail('Rejected.');
  const date = normDate(b.date);
  const n = slotNum(b.slot);
  const rows = scheduleRows();
  const day = rows.filter(function (r) { return r.date === date; })[0];
  if (!day) return fail('That date is not part of the schedule.');
  if (day.type !== 'talk') return fail('That date is not open for a talk.');
  const lab = labAt(day, n);
  if (!lab) return fail('No lab has been assigned to the ' + SLOT_LABELS[n - 1] + ' presenter slot on that date yet.');

  const auth = authorize(b.passcode, lab);
  if (!auth.ok) return auth;

  const speaker = text(b.speaker, 120);
  const email = text(b.email, 160);
  const title = text(b.title, 300);
  if (!speaker) return fail('Please add the presenter\u2019s name.');
  if (!isEmail(email)) return fail('Please add a valid email address.');
  if (title.length < 4) return fail('Please add a talk title.');

  const t = table(TAB_SIGNUPS);
  const existing = t.rows.filter(function (r) {
    return normDate(r.date) === date && slotNum(r.slot) === n;
  })[0];
  const now = new Date();
  const record = {
    timestamp: existing && existing.timestamp instanceof Date ? existing.timestamp : now,
    date: date, slot: n, lab: lab, speaker: speaker, email: email, title: title, updatedat: now
  };

  if (existing) {
    t.sheet.getRange(existing._row, 1, 1, t.keys.length).setValues([rowValues(t, record)]);
  } else {
    t.sheet.appendRow(rowValues(t, record));
  }

  sendConfirmation(day, n, lab, { speaker: speaker, email: email, title: title }, !!existing);
  const view = dayView(day, signupMap(), false);
  return { ok: true, updated: !!existing, slot: view, talk: view.talks[n - 1] };
}

function withdrawSignup(b) {
  const date = normDate(b.date);
  const n = slotNum(b.slot);
  const day = scheduleRows().filter(function (r) { return r.date === date; })[0];
  if (!day) return fail('That date is not part of the schedule.');
  const auth = authorize(b.passcode, labAt(day, n));
  if (!auth.ok) return auth;
  const t = table(TAB_SIGNUPS);
  const existing = t.rows.filter(function (r) {
    return normDate(r.date) === date && slotNum(r.slot) === n;
  })[0];
  if (existing) t.sheet.deleteRow(existing._row);
  const view = dayView(day, signupMap(), false);
  return { ok: true, slot: view, talk: view.talks[n - 1] };
}

/* ---------- calendar feed ---------- */

function buildIcs() {
  const st = settings();
  const rows = scheduleRows();
  const signups = signupMap();
  const name = st.seriesName || 'Seminar Series';
  const out = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Seminar Series//EN',
    'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'X-WR-CALNAME:' + esc(name), 'X-WR-TIMEZONE:' + tz(),
    'REFRESH-INTERVAL;VALUE=DURATION:PT6H', 'X-PUBLISHED-TTL:PT6H'
  ];
  const stamp = Utilities.formatDate(new Date(), 'UTC', "yyyyMMdd'T'HHmmss'Z'");

  rows.forEach(function (r) {
    if (r.type === 'break') return;

    /* One event per date, covering both presenters. */
    const heads = [];
    const lines = [];
    SLOTS.forEach(function (n) {
      const s = signups[slotKey(r.date, n)];
      const lab = labAt(r, n);
      if (s && s.speaker) {
        heads.push(s.speaker + (lab ? ' (' + lab + ')' : ''));
        lines.push(s.speaker + (lab ? ' (' + lab + ')' : '') + (s.title ? ': ' + s.title : ''));
      } else if (lab) {
        heads.push(lab + ' \u2014 title TBA');
        lines.push(lab + ': speaker and title still to be confirmed');
      }
    });

    let summary;
    if (r.type === 'special') summary = r.note || name;
    else summary = heads.length ? heads.join(' & ') : 'Speakers TBA';

    const desc = (r.type === 'special' ? [] : lines)
      .concat([r.note || '', st.siteUrl ? st.siteUrl : ''])
      .filter(Boolean).join('\n');

    out.push('BEGIN:VEVENT');
    out.push('UID:' + r.date + '@seminar-series');
    out.push('DTSTAMP:' + stamp);
    out.push('LAST-MODIFIED:' + stamp);
    if (st.startTime && /^\d{1,2}:\d{2}$/.test(st.startTime)) {
      out.push('DTSTART:' + utcStamp(r.date, st.startTime));
      out.push('DTEND:' + utcStamp(r.date, st.endTime && /^\d{1,2}:\d{2}$/.test(st.endTime) ? st.endTime : addHour(st.startTime)));
    } else {
      out.push('DTSTART;VALUE=DATE:' + r.date.replace(/-/g, ''));
      out.push('DTEND;VALUE=DATE:' + nextDay(r.date).replace(/-/g, ''));
    }
    out.push('SUMMARY:' + esc(summary));
    if (desc) out.push('DESCRIPTION:' + esc(desc));
    if (st.location) out.push('LOCATION:' + esc(st.location));
    if (st.siteUrl) out.push('URL:' + esc(st.siteUrl));
    out.push('END:VEVENT');
  });

  out.push('END:VCALENDAR');
  return out.map(fold).join('\r\n') + '\r\n';
}

function esc(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

function fold(line) {
  if (line.length <= 73) return line;
  const parts = [line.slice(0, 73)];
  let rest = line.slice(73);
  while (rest.length > 72) { parts.push(' ' + rest.slice(0, 72)); rest = rest.slice(72); }
  if (rest) parts.push(' ' + rest);
  return parts.join('\r\n');
}

function utcStamp(dateStr, hm) {
  const p = dateStr.split('-');
  const t = hm.split(':');
  const provisional = Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2]), Number(t[0]), Number(t[1]), 0);
  let mins = 0;
  try {
    const off = Utilities.formatDate(new Date(provisional), tz(), 'Z');
    const m = String(off).match(/^([+-])(\d{2})(\d{2})$/);
    if (m) mins = (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
  } catch (_) { mins = 0; }
  return Utilities.formatDate(new Date(provisional - mins * 60000), 'UTC', "yyyyMMdd'T'HHmmss'Z'");
}

function addHour(hm) {
  const t = hm.split(':');
  return pad((Number(t[0]) + 1) % 24) + ':' + t[1];
}

function nextDay(dateStr) {
  const p = dateStr.split('-');
  const d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]) + 1);
  return fmtDate(d);
}

/* ---------- reminders ---------- */

function sendReminders() {
  const st = settings();
  if (String(st.remindersEnabled || 'yes').toLowerCase() === 'no') return;

  const rows = scheduleRows();
  const signups = signupMap();
  const today = normDate(new Date());

  REMINDER_DAYS.forEach(function (days) {
    const target = shiftDate(today, days);
    rows.forEach(function (r) {
      if (r.date !== target || r.type !== 'talk') return;
      SLOTS.forEach(function (n) {
        const lab = labAt(r, n);
        const s = signups[slotKey(r.date, n)];
        if (!lab) {
          if (days >= 14) notifyOrganizer('unassigned-' + days, r, n, '', days, st);
          return;
        }
        if (s && s.speaker && s.title) {
          if (days === 3) mailSpeaker(r, n, s, days, st);
        } else {
          mailLab(r, n, lab, days, st);
        }
      });
    });
  });
}

function previewReminders() {
  const rows = scheduleRows();
  const signups = signupMap();
  const today = normDate(new Date());
  const lines = [];
  REMINDER_DAYS.forEach(function (days) {
    const target = shiftDate(today, days);
    rows.forEach(function (r) {
      if (r.date !== target || r.type !== 'talk') return;
      SLOTS.forEach(function (n) {
        const lab = labAt(r, n);
        const s = signups[slotKey(r.date, n)];
        const at = days + 'd \u2014 ' + r.date + ' \u2014 presenter ' + n + ' \u2014 ';
        if (!lab) lines.push(at + 'organizer alert (no lab assigned)');
        else if (s && s.speaker && s.title) { if (days === 3) lines.push(at + 'speaker reminder to ' + s.email); }
        else lines.push(at + 'chase ' + lab);
      });
    });
  });
  const msg = lines.length ? lines.join('\n') : 'Nothing would be sent today.';
  try { SpreadsheetApp.getUi().alert('Reminder preview', msg, SpreadsheetApp.getUi().ButtonSet.OK); } catch (_) {}
  Logger.log(msg);
  return msg;
}

function shiftDate(dateStr, days) {
  const p = dateStr.split('-');
  const d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]) + days);
  return fmtDate(d);
}

/* Keyed per presenter slot, so the two labs sharing a date are chased separately. */
function logKey(kind, date, n) { return kind + '|' + date + '|' + slotNum(n); }

function alreadySent(kind, date, n) {
  const t = table(TAB_LOG);
  const k = logKey(kind, date, n);
  return t.rows.some(function (r) { return String(r.key || '').trim() === k; });
}

function logSent(kind, date, n, to) {
  tab(TAB_LOG).appendRow([new Date(), logKey(kind, date, n), kind, date, to]);
}

function longDate(dateStr) {
  const p = dateStr.split('-');
  const d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  return Utilities.formatDate(d, tz(), 'EEEE d MMMM yyyy');
}

/* Two labs share each date, so every message below names the presenter slot
   it is about and is logged against that slot. */
function slotPhrase(n) { return 'the ' + SLOT_LABELS[slotNum(n) - 1] + ' of the two talks'; }

function mailLab(day, n, labName, days, st) {
  const kind = 'lab-' + days;
  if (alreadySent(kind, day.date, n)) return;
  const lab = labByName(labName);
  if (!lab || !lab.emails.length) { notifyOrganizer('nocontact-' + days, day, n, labName, days, st); return; }

  const when = days === 28 ? 'in four weeks' : (days === 14 ? 'in two weeks' : 'in three days');
  const urgency = days === 3 ? 'This is now urgent \u2014 ' : '';
  const subject = (days === 3 ? '[Urgent] ' : '') + st.seriesName + ': ' + labName +
    ' presents on ' + longDate(day.date) + ' \u2014 we still need a name';

  const other = labAt(day, n === 1 ? 2 : 1);
  const body =
    p('Hello' + (lab.contactName ? ' ' + lab.contactName : '') + ',') +
    p(urgency + '<strong>' + escapeHtml(labName) + '</strong> is scheduled to give ' + slotPhrase(n) +
      ' at ' + escapeHtml(st.seriesName) + ' on <strong>' + longDate(day.date) + '</strong>, ' + when +
      ', and we do not yet have a presenter and title.') +
    (other ? p('The other talk that day is from ' + escapeHtml(other) + '.') : '') +
    p('Whoever is presenting can add their name, email and talk title on the seminar site using your lab access code:') +
    button(st.siteUrl, 'Add your presenter') +
    p('Your lab access code is <strong>' + escapeHtml(lab.passcode) + '</strong>.') +
    detailBlock(st, day);

  const recipients = lab.emails.join(',');
  MailApp.sendEmail({
    to: recipients,
    cc: days >= 14 ? '' : (st.organizerEmail || ''),
    subject: subject,
    htmlBody: wrap(st, body),
    body: stripHtml(body),
    name: st.seriesName || 'Seminar Series',
    replyTo: st.organizerEmail || undefined
  });
  logSent(kind, day.date, n, recipients);
}

function mailSpeaker(day, n, signup, days, st) {
  const kind = 'speaker-' + days;
  if (alreadySent(kind, day.date, n)) return;
  const subject = st.seriesName + ': you are presenting on ' + longDate(day.date);
  const other = labAt(day, n === 1 ? 2 : 1);
  const body =
    p('Hello ' + escapeHtml(signup.speaker.split(' ')[0]) + ',') +
    p('A reminder that you are giving ' + slotPhrase(n) + ' at ' + escapeHtml(st.seriesName) +
      ' on <strong>' + longDate(day.date) + '</strong>.') +
    p('Your title is recorded as:') +
    quote(escapeHtml(signup.title)) +
    (other ? p('The other talk that day is from ' + escapeHtml(other) + '.') : '') +
    p('If anything has changed, you can update it on the seminar site with your lab access code.') +
    button(st.siteUrl, 'View the schedule') +
    detailBlock(st, day);

  MailApp.sendEmail({
    to: signup.email,
    cc: String(st.copyOrganizer || 'yes').toLowerCase() === 'yes' ? (st.organizerEmail || '') : '',
    subject: subject,
    htmlBody: wrap(st, body),
    body: stripHtml(body),
    name: st.seriesName || 'Seminar Series',
    replyTo: st.organizerEmail || undefined
  });
  logSent(kind, day.date, n, signup.email);
}

function sendConfirmation(day, n, labName, signup, isUpdate) {
  const st = settings();
  const subject = st.seriesName + ': ' + (isUpdate ? 'updated \u2014 ' : 'confirmed \u2014 ') +
    longDate(day.date);
  const other = labAt(day, n === 1 ? 2 : 1);
  const body =
    p('Hello ' + escapeHtml(signup.speaker.split(' ')[0]) + ',') +
    p('You are down to give ' + slotPhrase(n) + ' at ' + escapeHtml(st.seriesName) + ' on <strong>' +
      longDate(day.date) + '</strong> for ' + escapeHtml(labName) + '.') +
    quote(escapeHtml(signup.title)) +
    (other ? p('The other talk that day is from ' + escapeHtml(other) + '.') : '') +
    p('We will send you a reminder a few days beforehand. You can change your title any time on the seminar site.') +
    button(st.siteUrl, 'View the schedule') +
    detailBlock(st, day);

  MailApp.sendEmail({
    to: signup.email,
    cc: String(st.copyOrganizer || 'yes').toLowerCase() === 'yes' ? (st.organizerEmail || '') : '',
    subject: subject,
    htmlBody: wrap(st, body),
    body: stripHtml(body),
    name: st.seriesName || 'Seminar Series',
    replyTo: st.organizerEmail || undefined
  });
}

function notifyOrganizer(kind, day, n, labName, days, st) {
  if (!st.organizerEmail) return;
  if (alreadySent(kind, day.date, n)) return;
  const body = p('Heads up \u2014 ' + longDate(day.date) + ' is ' + days + ' days away and ' +
    (labName ? 'no contact email is set for ' + escapeHtml(labName) + ', who are down for ' + slotPhrase(n)
      : 'no lab is assigned to ' + slotPhrase(n)) + '.') +
    button(st.siteUrl, 'Open the schedule');
  MailApp.sendEmail({
    to: st.organizerEmail,
    subject: st.seriesName + ': action needed for ' + longDate(day.date),
    htmlBody: wrap(st, body),
    body: stripHtml(body),
    name: st.seriesName || 'Seminar Series'
  });
  logSent(kind, day.date, n, st.organizerEmail);
}

/* ---------- email chrome ---------- */

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function p(html) { return '<p style="margin:0 0 14px;">' + html + '</p>'; }
function quote(html) {
  return '<p style="margin:0 0 14px;padding:12px 16px;border-left:3px solid #17457a;background:#f4f6f9;font-size:16px;">' + html + '</p>';
}
function button(url, label) {
  if (!url) return '';
  return '<p style="margin:0 0 18px;"><a href="' + escapeHtml(url) +
    '" style="display:inline-block;padding:11px 18px;background:#17457a;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:600;">' +
    escapeHtml(label) + '</a></p>';
}
function detailBlock(st, slot) {
  const bits = [];
  if (st.startTime) bits.push(st.startTime + (st.endTime ? '\u2013' + st.endTime : ''));
  if (st.location) bits.push(st.location);
  if (slot && slot.note) bits.push(slot.note);
  if (!bits.length) return '';
  return '<p style="margin:22px 0 0;color:#5b6270;font-size:14px;">' + escapeHtml(bits.join(' \u00b7 ')) + '</p>';
}
function wrap(st, inner) {
  return '<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#16181d;max-width:560px;">' +
    '<p style="margin:0 0 20px;font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#5b6270;">' +
    escapeHtml(st.seriesName || 'Seminar Series') + '</p>' + inner +
    '<p style="margin:26px 0 0;padding-top:14px;border-top:1px solid #e5e2dc;color:#8a8f99;font-size:13px;">' +
    'Sent automatically by the seminar scheduler' +
    (st.organizerName ? ' \u00b7 organised by ' + escapeHtml(st.organizerName) : '') + '.</p></div>';
}
function stripHtml(html) {
  return String(html).replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n').trim();
}

/* ---------- setup ---------- */

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Seminar')
    .addItem('Set up this sheet', 'setupSheet')
    .addItem('Generate Friday dates\u2026', 'generateFridaysPrompt')
    .addSeparator()
    .addItem('Turn on automatic reminders', 'installTrigger')
    .addItem('Preview today\u2019s reminders', 'previewReminders')
    .addItem('Send today\u2019s reminders now', 'sendReminders')
    .addSeparator()
    .addItem('Show organizer code', 'showAdminCode')
    .addItem('Give every lab a new code', 'regenerateLabCodes')
    .addToUi();
}

function setupSheet() {
  const b = book();
  ensure(b, TAB_SCHEDULE, ['Date', 'Lab 1', 'Lab 2', 'Type', 'Note'], { lab: 'Lab 1' });
  ensure(b, TAB_LABS, ['Lab', 'Contact name', 'Contact emails', 'Passcode']);
  ensure(b, TAB_SIGNUPS, ['Timestamp', 'Date', 'Slot', 'Lab', 'Speaker', 'Email', 'Title', 'Updated at']);
  ensure(b, TAB_SETTINGS, ['Setting', 'Value']);
  ensure(b, TAB_LOG, ['Timestamp', 'Key', 'Kind', 'Date', 'To']);
  backfillSlots();

  const st = tab(TAB_SETTINGS);
  if (st.getLastRow() < 2) {
    st.getRange(2, 1, DEFAULT_SETTINGS.length, 2).setValues(DEFAULT_SETTINGS);
  }
  const current = settings();
  if (!current.adminPasscode) setSetting('adminPasscode', makeCode());
  if (!current.seasonStart) setSetting('seasonStart', defaultSeasonStart());
  if (!current.seasonEnd) setSetting('seasonEnd', defaultSeasonEnd());

  tab(TAB_SCHEDULE).setColumnWidths(1, 5, 160);
  tab(TAB_LABS).setColumnWidths(1, 4, 200);
  tab(TAB_SETTINGS).setColumnWidths(1, 2, 240);
  applyValidation();

  SpreadsheetApp.getUi().alert(
    'Sheet ready',
    'Next:\n\n1. Fill in the Settings tab.\n2. Add your labs (and their contact emails) on the Labs tab.\n3. Run Seminar \u2192 Generate Friday dates.\n4. Put two lab names next to each Friday on the Schedule tab \u2014 one in Lab 1, one in Lab 2. Each supplies one presenter.\n5. Run Seminar \u2192 Turn on automatic reminders.',
    SpreadsheetApp.getUi().ButtonSet.OK
  );
}

/* Creates the tab if missing. On a tab that already exists, renames any header
   in `renames` and appends any expected header that is not there yet, so a
   sheet built before there were two presenters picks up the new columns
   without disturbing the data already in it. Everything else reads columns by
   header name, so appending at the end is safe. */
function ensure(b, name, headers, renames) {
  let sh = b.getSheetByName(name);
  if (!sh) sh = b.insertSheet(name);
  if (sh.getLastRow() === 0 || String(sh.getRange(1, 1).getValue()).trim() === '') {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
  } else {
    const last = sh.getLastColumn();
    const keys = sh.getRange(1, 1, 1, last).getValues()[0].map(key);
    if (renames) {
      Object.keys(renames).forEach(function (from) {
        const at = keys.indexOf(from);
        if (at >= 0 && keys.indexOf(key(renames[from])) < 0) {
          sh.getRange(1, at + 1).setValue(renames[from]);
          keys[at] = key(renames[from]);
        }
      });
    }
    const missing = headers.filter(function (h) { return keys.indexOf(key(h)) < 0; });
    if (missing.length) sh.getRange(1, last + 1, 1, missing.length).setValues([missing]);
  }
  const width = Math.max(headers.length, sh.getLastColumn() || headers.length);
  sh.getRange(1, 1, 1, width).setFontWeight('bold').setBackground('#eef1f5');
  sh.setFrozenRows(1);
  return sh;
}

/* Sign-ups recorded before there were two presenters belong to slot 1. */
function backfillSlots() {
  const t = table(TAB_SIGNUPS);
  const col = colIndex(t, 'slot');
  if (col < 1) return;
  t.rows.forEach(function (r) {
    if (normDate(r.date) && String(r.slot == null ? '' : r.slot).trim() === '') {
      t.sheet.getRange(r._row, col).setValue(SLOTS[0]);
    }
  });
}

function setSetting(k, v) {
  const t = table(TAB_SETTINGS);
  const row = t.rows.filter(function (r) { return String(r.setting).trim() === k; })[0];
  if (row) t.sheet.getRange(row._row, 2).setValue(v);
  else t.sheet.appendRow([k, v]);
}

function applyValidation() {
  const t = table(TAB_SCHEDULE);
  const sch = t.sheet;
  const typeCol = colIndex(t, 'type');
  if (typeCol > 0) {
    const typeRule = SpreadsheetApp.newDataValidation()
      .requireValueInList(['talk', 'break', 'special'], true).setAllowInvalid(false).build();
    sch.getRange(2, typeCol, 400, 1).setDataValidation(typeRule);
  }

  const names = labs().map(function (l) { return l.name; });
  if (names.length) {
    const labRule = SpreadsheetApp.newDataValidation()
      .requireValueInList(names, true).setAllowInvalid(true).build();
    ['lab1', 'lab2'].forEach(function (k) {
      const c = colIndex(t, k);
      if (c > 0) sch.getRange(2, c, 400, 1).setDataValidation(labRule);
    });
  }
  const dateCol = colIndex(t, 'date');
  if (dateCol > 0) sch.getRange(2, dateCol, 400, 1).setNumberFormat('yyyy-mm-dd');
}

function defaultSeasonStart() {
  const now = new Date();
  const year = now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1;
  return fmtDate(firstFriday(year, 8));
}

function defaultSeasonEnd() {
  const now = new Date();
  const year = now.getMonth() >= 6 ? now.getFullYear() + 1 : now.getFullYear();
  return fmtDate(lastFriday(year, 5));
}

function firstFriday(year, month) {
  const d = new Date(year, month, 1);
  while (d.getDay() !== 5) d.setDate(d.getDate() + 1);
  return d;
}

function lastFriday(year, month) {
  const d = new Date(year, month + 1, 0);
  while (d.getDay() !== 5) d.setDate(d.getDate() - 1);
  return d;
}

function generateFridaysPrompt() {
  const ui = SpreadsheetApp.getUi();
  const st = settings();
  const res = ui.prompt('Generate Friday dates',
    'Season start and end, as yyyy-mm-dd,yyyy-mm-dd\n\nCurrently: ' + (st.seasonStart || '?') + ',' + (st.seasonEnd || '?'),
    ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return;
  const parts = res.getResponseText().split(',').map(function (s) { return s.trim(); });
  const from = normDate(parts[0] || st.seasonStart);
  const to = normDate(parts[1] || st.seasonEnd);
  if (!from || !to) { ui.alert('Could not read those dates.'); return; }
  setSetting('seasonStart', from);
  setSetting('seasonEnd', to);
  const added = generateFridays(from, to);
  ui.alert('Added ' + added + ' Friday' + (added === 1 ? '' : 's') + ' to the Schedule tab.');
}

function generateFridays(from, to) {
  const t = table(TAB_SCHEDULE);
  const sh = t.sheet;
  const have = {};
  scheduleRows().forEach(function (r) { have[r.date] = true; });
  const p = from.split('-');
  const end = to;
  const d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  while (d.getDay() !== 5) d.setDate(d.getDate() + 1);
  const rows = [];
  while (fmtDate(d) <= end) {
    const dk = fmtDate(d);
    if (!have[dk]) rows.push(rowValues(t, { date: dk, lab1: '', lab2: '', type: 'talk', note: '' }));
    d.setDate(d.getDate() + 7);
  }
  if (rows.length) sh.getRange(sh.getLastRow() + 1, 1, rows.length, t.keys.length).setValues(rows);
  const dateCol = Math.max(colIndex(t, 'date'), 1);
  sh.getRange(2, dateCol, Math.max(sh.getLastRow() - 1, 1), 1).setNumberFormat('yyyy-mm-dd');
  sh.sort(dateCol);
  applyValidation();
  return rows.length;
}

function installTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'sendReminders') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('sendReminders').timeBased().atHour(8).everyDays(1).inTimezone(tz()).create();
  try {
    SpreadsheetApp.getUi().alert('Automatic reminders are on. They run every morning around 8am ' + tz() + '.');
  } catch (_) {}
}

function makeCode() {
  const words = ['amber', 'basalt', 'cedar', 'delta', 'ember', 'fjord', 'garnet', 'harbour',
    'indigo', 'juniper', 'kelp', 'lichen', 'marram', 'nimbus', 'onyx', 'quartz',
    'ripple', 'sable', 'tundra', 'umber', 'verdant', 'willow'];
  const w = words[Math.floor(Math.random() * words.length)];
  return w + '-' + Math.floor(1000 + Math.random() * 9000);
}

function regenerateLabCodes() {
  const t = table(TAB_LABS);
  const col = colIndex(t, 'passcode');
  if (col < 1) { SpreadsheetApp.getUi().alert('No Passcode column found on the Labs tab.'); return; }
  t.rows.forEach(function (r) {
    if (String(r.lab || '').trim()) t.sheet.getRange(r._row, col).setValue(makeCode());
  });
  SpreadsheetApp.getUi().alert('Every lab has a fresh code. Email each lab its new code from the Labs tab.');
}

function showAdminCode() {
  const st = settings();
  SpreadsheetApp.getUi().alert('Organizer code', st.adminPasscode || '(not set)', SpreadsheetApp.getUi().ButtonSet.OK);
}
