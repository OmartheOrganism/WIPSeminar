(function () {
  'use strict';

  var CFG = window.SEMINAR_CONFIG || {};
  var STORE = 'seminar.session';
  var CACHE = 'seminar.cache';

  var state = {
    settings: {},
    slots: [],
    labs: [],
    admin: null,
    session: null,
    loaded: false,
    demo: false
  };

  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December'];
  var DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function el(tag, cls, txt) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (txt != null) n.textContent = txt;
    return n;
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function parseDate(s) {
    var p = String(s).split('-');
    return new Date(+p[0], +p[1] - 1, +p[2]);
  }
  function todayKey() {
    var d = new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function pad(n) { return ('0' + n).slice(-2); }
  function longDate(k) {
    var d = parseDate(k);
    return DAYS[d.getDay()] + ' ' + d.getDate() + ' ' + MONTHS[d.getMonth()] + ' ' + d.getFullYear();
  }
  function shortDate(k) {
    var d = parseDate(k);
    return d.getDate() + ' ' + MONTHS[d.getMonth()].slice(0, 3);
  }
  function monthKey(k) { return k.slice(0, 7); }
  function monthLabel(mk) {
    var p = mk.split('-');
    return MONTHS[+p[1] - 1] + ' ' + p[0];
  }

  function configured() {
    var u = String(CFG.apiUrl || '').trim();
    return /^https?:\/\/\S+$/.test(u) && u.indexOf('PASTE_YOUR') < 0;
  }

  var API = {
    get: function (params) {
      if (!configured()) return Promise.reject(new Error('NOT_CONFIGURED'));
      var url = CFG.apiUrl + '?' + qs(params);
      return fetch(url, { method: 'GET', redirect: 'follow' })
        .then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.json();
        })
        .catch(function () { return API.jsonp(params); });
    },

    jsonp: function (params) {
      return new Promise(function (resolve, reject) {
        var cb = 'sem_cb_' + Math.random().toString(36).slice(2);
        var s = document.createElement('script');
        var done = false;
        var timer = setTimeout(function () { finish(new Error('The schedule service did not respond.')); }, 20000);
        function finish(err, data) {
          if (done) return;
          done = true;
          clearTimeout(timer);
          delete window[cb];
          if (s.parentNode) s.parentNode.removeChild(s);
          err ? reject(err) : resolve(data);
        }
        window[cb] = function (data) { finish(null, data); };
        s.onerror = function () { finish(new Error('Could not reach the schedule service.')); };
        var p = {};
        for (var k in params) p[k] = params[k];
        p.callback = cb;
        s.src = CFG.apiUrl + '?' + qs(p);
        document.head.appendChild(s);
      });
    },

    post: function (payload) {
      if (!configured()) return Promise.reject(new Error('NOT_CONFIGURED'));
      return fetch(CFG.apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(payload),
        redirect: 'follow'
      })
        .then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.json();
        })
        .catch(function () { return API.framePost(payload); });
    },

    framePost: function (payload) {
      return new Promise(function (resolve, reject) {
        var name = 'sem_f_' + Math.random().toString(36).slice(2);
        var frame = document.createElement('iframe');
        frame.name = name;
        frame.style.display = 'none';
        document.body.appendChild(frame);

        var form = document.createElement('form');
        form.method = 'POST';
        form.action = CFG.apiUrl + '?frame=1';
        form.target = name;
        form.style.display = 'none';
        var input = document.createElement('input');
        input.type = 'hidden';
        input.name = 'payload';
        input.value = JSON.stringify(payload);
        form.appendChild(input);
        document.body.appendChild(form);

        var done = false;
        var timer = setTimeout(function () { finish(new Error('The request timed out. Please try again.')); }, 30000);
        function onMsg(e) {
          if (!e.data || e.data.source !== 'seminar-api') return;
          finish(null, e.data.payload);
        }
        function finish(err, data) {
          if (done) return;
          done = true;
          clearTimeout(timer);
          window.removeEventListener('message', onMsg);
          setTimeout(function () {
            if (frame.parentNode) frame.parentNode.removeChild(frame);
            if (form.parentNode) form.parentNode.removeChild(form);
          }, 300);
          err ? reject(err) : resolve(data);
        }
        window.addEventListener('message', onMsg);
        form.submit();
      });
    }
  };

  function qs(o) {
    return Object.keys(o).filter(function (k) { return o[k] != null && o[k] !== ''; })
      .map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(o[k]); }).join('&');
  }

  function loadSession() {
    try { state.session = JSON.parse(localStorage.getItem(STORE) || 'null'); } catch (e) { state.session = null; }
    return state.session;
  }
  function saveSession(s) {
    state.session = s;
    try { s ? localStorage.setItem(STORE, JSON.stringify(s)) : localStorage.removeItem(STORE); } catch (e) {}
    paintSession();
  }
  function myLab() { return state.session && state.session.lab ? state.session.lab : ''; }

  function absorb(data) {
    state.settings = data.settings || {};
    state.slots = data.slots || [];
    state.labs = data.labs || [];
    state.loaded = true;
    try { localStorage.setItem(CACHE, JSON.stringify({ at: Date.now(), data: data })); } catch (e) {}
    paintBranding();
  }

  function cached() {
    try {
      var c = JSON.parse(localStorage.getItem(CACHE) || 'null');
      return c && c.data ? c.data : null;
    } catch (e) { return null; }
  }

  function load() {
    if (!configured()) {
      state.demo = true;
      absorb(demoData());
      return Promise.resolve(state);
    }
    var c = cached();
    if (c) { absorb(c); render(); }
    return API.get({ action: 'schedule' }).then(function (data) {
      if (data && data.ok) { absorb(data); render(); }
      return state;
    });
  }

  function slotAt(date) {
    for (var i = 0; i < state.slots.length; i++) if (state.slots[i].date === date) return state.slots[i];
    return null;
  }

  function replaceSlot(s) {
    for (var i = 0; i < state.slots.length; i++) {
      if (state.slots[i].date === s.date) { state.slots[i] = s; return; }
    }
  }

  function talksOf(s) { return (s && s.talks) || []; }
  function filledTalks(s) { return talksOf(s).filter(function (t) { return t.filled; }); }
  function assignedTalks(s) { return talksOf(s).filter(function (t) { return t.lab; }); }
  function labsOf(s) {
    return talksOf(s).map(function (t) { return t.lab; }).filter(Boolean);
  }
  function hasLab(s, name) {
    return !!name && labsOf(s).indexOf(name) >= 0;
  }
  function ordinal(n) { return n === 1 ? 'First presenter' : 'Second presenter'; }

  function statusOf(s) {
    if (s.type === 'break') return 'break';
    if (s.type === 'special') return 'special';
    var all = talksOf(s);
    var f = filledTalks(s).length;
    if (all.length && f === all.length) return 'filled';
    if (f > 0) return 'partial';
    if (!assignedTalks(s).length) return 'open';
    return 'needs';
  }

  function talkStatus(s, t) {
    if (s.type === 'break') return 'break';
    if (s.type === 'special') return 'special';
    if (t.filled) return 'filled';
    return t.lab ? 'needs' : 'open';
  }

  var LABELS = {
    filled: 'Confirmed', partial: 'Part confirmed', needs: 'Awaiting speakers',
    open: 'Unassigned', 'break': 'No seminar', special: 'Special'
  };

  var TALK_LABELS = {
    filled: 'Confirmed', needs: 'Awaiting speaker', open: 'Unassigned',
    'break': 'No seminar', special: 'Special'
  };

  function labelFor(s) {
    var st = statusOf(s);
    if (st !== 'partial') return LABELS[st] || '';
    return filledTalks(s).length + ' of ' + talksOf(s).length + ' confirmed';
  }

  function isPast(k) { return k < todayKey(); }

  function upcoming() {
    var t = todayKey();
    return state.slots.filter(function (s) { return s.date >= t && s.type !== 'break'; });
  }

  function paintBranding() {
    var name = state.settings.seriesName || CFG.seriesName || 'Seminar Series';
    $$('[data-bind="seriesName"]').forEach(function (n) { n.textContent = name; });
    $$('[data-bind="tagline"]').forEach(function (n) {
      var v = state.settings.tagline || CFG.tagline || '';
      n.textContent = v; n.hidden = !v;
    });
    document.title = document.title.replace(/^[^—]*—\s*/, '').trim();
    document.title = name + (document.title ? ' — ' + document.title : '');

    var meta = $('#hero-meta');
    if (meta) {
      var bits = [];
      var t = state.settings.startTime ? state.settings.startTime + (state.settings.endTime ? '–' + state.settings.endTime : '') : '';
      if (t) bits.push('Fridays, ' + t);
      else bits.push('Every Friday');
      if (state.settings.location) bits.push(state.settings.location);
      if (state.settings.organizerEmail) {
        bits.push('<a href="mailto:' + esc(state.settings.organizerEmail) + '">' +
          esc(state.settings.organizerName || state.settings.organizerEmail) + '</a>');
      }
      meta.innerHTML = bits.map(function (b) { return '<span>' + b + '</span>'; }).join('');
    }
  }

  function paintSession() {
    var host = $('#session-slot');
    if (!host) return;
    host.innerHTML = '';
    var s = state.session;
    if (s && s.lab) {
      var b = el('button', 'session');
      b.appendChild(el('span', 'dot'));
      b.appendChild(el('span', null, s.admin ? 'Organizer' : s.lab));
      var x = el('span', 'x', '×');
      x.title = 'Sign out';
      b.appendChild(x);
      b.addEventListener('click', function (e) {
        if (e.target === x) { saveSession(null); render(); }
        else openUnlock();
      });
      host.appendChild(b);
    } else {
      var a = el('button', 'session');
      a.appendChild(el('span', null, 'Sign in'));
      a.addEventListener('click', function () { openUnlock(); });
      host.appendChild(a);
    }
  }

  function chrome() {
    var here = (location.pathname.split('/').pop() || 'index.html').toLowerCase();
    $$('.nav a').forEach(function (a) {
      var href = (a.getAttribute('href') || '').toLowerCase();
      if (href === here || (here === '' && href === 'index.html')) a.setAttribute('aria-current', 'page');
    });
    var mb = $('.menu-btn');
    if (mb) mb.addEventListener('click', function () { $('.nav').classList.toggle('open'); });
    if (state.demo) {
      var host = $('#banner-slot');
      if (host) {
        host.innerHTML = '<div class="banner">Showing sample data. Paste your Apps Script web app URL into ' +
          '<code>assets/config.js</code> to connect this site to your schedule.</div>';
      }
    }
    paintSession();
  }

  function monthsInSeason() {
    var seen = [], map = {};
    state.slots.forEach(function (s) {
      var mk = monthKey(s.date);
      if (!Object.prototype.hasOwnProperty.call(map, mk)) { map[mk] = 0; seen.push(mk); }
      if (s.type !== 'break') map[mk]++;
    });
    seen.sort();
    return seen.map(function (mk) { return { key: mk, count: map[mk] }; });
  }

  var currentMonth = null;

  function renderMonthNav(host) {
    var months = monthsInSeason();
    if (!months.length) return;
    if (!currentMonth || months.map(function (m) { return m.key; }).indexOf(currentMonth) < 0) {
      var t = monthKey(todayKey());
      var pick = months.filter(function (m) { return m.key >= t; })[0] || months[0];
      currentMonth = pick.key;
    }
    host.innerHTML = '';
    months.forEach(function (m) {
      var b = el('button');
      b.innerHTML = esc(monthLabel(m.key).replace(/ \d{4}$/, '')) + '<span class="n">' + m.count + '</span>';
      b.setAttribute('aria-pressed', m.key === currentMonth ? 'true' : 'false');
      b.addEventListener('click', function () { currentMonth = m.key; render(); });
      host.appendChild(b);
    });
  }

  function renderCalendar(host) {
    if (!currentMonth) return;
    var p = currentMonth.split('-');
    var year = +p[0], month = +p[1] - 1;
    var first = new Date(year, month, 1);
    var start = new Date(year, month, 1 - first.getDay());
    var grid = el('div', 'cal-grid');
    var today = todayKey();

    for (var i = 0; i < 42; i++) {
      var d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      var key = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
      var cell = el('div', 'cell' + (d.getMonth() !== month ? ' out' : '') + (key === today ? ' today' : ''));
      cell.appendChild(el('span', 'num', String(d.getDate())));
      var s = slotAt(key);
      if (s && d.getMonth() === month) cell.appendChild(slotChip(s));
      grid.appendChild(cell);
      if (i >= 34 && d.getMonth() !== month && (i + 1) % 7 === 0) break;
    }
    host.innerHTML = '';
    var head = el('div', 'cal-head');
    ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].forEach(function (n) { head.appendChild(el('div', null, n)); });
    host.appendChild(head);
    host.appendChild(grid);
  }

  function slotChip(s) {
    var st = statusOf(s);
    var b = el('button', 'slot ' + st + (isPast(s.date) ? ' past' : '') +
      (hasLab(s, myLab()) ? ' mine' : ''));
    if (st === 'break') {
      b.appendChild(el('span', 'lab', s.note || 'No seminar'));
      b.disabled = true;
      return b;
    }
    if (st === 'special') {
      b.appendChild(el('span', 'lab', s.note || 'Special session'));
    } else {
      talksOf(s).forEach(function (t) {
        var line = el('span', 'talk');
        line.appendChild(el('span', 'lab', t.lab || 'Unassigned'));
        if (t.speaker) line.appendChild(el('span', 'who', t.speaker));
        b.appendChild(line);
      });
      b.appendChild(el('span', 'tag',
        isPast(s.date) && !filledTalks(s).length ? 'Not recorded' : labelFor(s)));
    }
    b.addEventListener('click', function () { openSlot(s.date); });
    return b;
  }

  function renderList(host, slots, opts) {
    opts = opts || {};
    host.innerHTML = '';
    if (!slots.length) {
      host.appendChild(emptyBlock(opts.emptyTitle || 'Nothing here yet',
        opts.emptyBody || 'Dates appear as soon as they are added to the schedule.'));
      return;
    }
    var lastMonth = '';
    slots.forEach(function (s) {
      var mk = monthKey(s.date);
      if (opts.group !== false && mk !== lastMonth) {
        lastMonth = mk;
        host.appendChild(el('div', 'month-label', monthLabel(mk)));
      }
      host.appendChild(rowFor(s, opts));
    });
  }

  function rowFor(s, opts) {
    var st = statusOf(s);
    var past = isPast(s.date);
    var row = el('button', 'row ' + st + (past ? ' past' : ''));
    var d = parseDate(s.date);

    var date = el('div', 'date');
    date.appendChild(el('span', 'dow', DAYS[d.getDay()].slice(0, 3)));
    date.appendChild(document.createElement('br'));
    date.appendChild(el('span', 'dm', d.getDate() + ' ' + MONTHS[d.getMonth()].slice(0, 3)));
    row.appendChild(date);

    var body = el('div', 'body');
    if (st === 'break') {
      body.appendChild(el('h3', null, s.note || 'No seminar'));
    } else if (st === 'special') {
      body.appendChild(el('h3', null, s.note || 'Special session'));
    } else {
      talksOf(s).forEach(function (t) { body.appendChild(talkBlock(t, past)); });
    }
    row.appendChild(body);

    var pill = el('span', 'pill ' + (st === 'special' ? 'open' : st),
      past && !filledTalks(s).length && st !== 'break' ? 'Past' : labelFor(s));
    row.appendChild(pill);

    if (st === 'break') row.disabled = true;
    else row.addEventListener('click', function () { openSlot(s.date); });
    if (opts && opts.mineFirst && hasLab(s, myLab())) row.classList.add('mine');
    return row;
  }

  function talkBlock(t, past) {
    var d = el('div', 'talk');
    if (t.filled) {
      d.appendChild(el('h3', null, t.title));
      d.appendChild(el('p', null, t.speaker + ' · ' + t.lab));
    } else {
      d.appendChild(el('h3', null, t.lab || 'No lab assigned yet'));
      d.appendChild(el('p', 'untitled', t.lab
        ? (past ? 'No presenter was recorded' : 'Speaker and title still needed')
        : 'This presenter slot has not been allocated'));
    }
    return d;
  }

  function emptyBlock(title, body) {
    var d = el('div', 'empty');
    d.appendChild(el('h3', null, title));
    d.appendChild(el('p', null, body));
    return d;
  }

  var veil, modalBody, modalHead, lastFocus;

  function ensureModal() {
    if (veil) return;
    veil = el('div', 'veil');
    veil.hidden = true;
    var m = el('div', 'modal');
    m.setAttribute('role', 'dialog');
    m.setAttribute('aria-modal', 'true');
    modalHead = el('div', 'modal-head');
    modalBody = el('div', 'modal-body');
    m.appendChild(modalHead);
    m.appendChild(modalBody);
    veil.appendChild(m);
    document.body.appendChild(veil);
    veil.addEventListener('click', function (e) { if (e.target === veil) closeModal(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !veil.hidden) closeModal(); });
  }

  function openModal(eyebrow, title, sub) {
    ensureModal();
    lastFocus = document.activeElement;
    modalHead.innerHTML = '';
    var g = el('div', 'grow');
    if (eyebrow) g.appendChild(el('div', 'eyebrow', eyebrow));
    g.appendChild(el('h2', null, title));
    if (sub) g.appendChild(el('p', null, sub));
    modalHead.appendChild(g);
    var x = el('button', 'close', '×');
    x.setAttribute('aria-label', 'Close');
    x.addEventListener('click', closeModal);
    modalHead.appendChild(x);
    modalBody.innerHTML = '';
    veil.hidden = false;
    document.body.style.overflow = 'hidden';
    return modalBody;
  }

  function closeModal() {
    if (!veil) return;
    veil.hidden = true;
    document.body.style.overflow = '';
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  function note(kind, text) { return el('div', 'note ' + kind, text); }

  function field(label, name, type, value, hint, autoc, idp) {
    var id = 'f_' + (idp || '') + name;
    var w = el('div', 'f');
    var l = el('label', 'lbl', label);
    l.setAttribute('for', id);
    w.appendChild(l);
    var i = el('input', 'inp');
    i.id = id;
    i.name = name;
    i.type = type || 'text';
    i.value = value || '';
    if (autoc) i.autocomplete = autoc;
    w.appendChild(i);
    if (hint) w.appendChild(el('p', 'hint', hint));
    return w;
  }

  function openUnlock() {
    var body = openModal('Access', 'Sign in to your lab',
      'Enter the access code your seminar organizer emailed you. It unlocks the Fridays assigned to your lab.');
    var msg = el('div');
    body.appendChild(msg);
    var f = document.createElement('form');
    f.appendChild(field('Lab access code', 'passcode', 'text', state.session ? state.session.code : '', null, 'off'));
    var hp = el('input', 'hp');
    hp.name = 'website'; hp.tabIndex = -1; hp.setAttribute('aria-hidden', 'true'); hp.autocomplete = 'off';
    f.appendChild(hp);
    var act = el('div', 'actions');
    var go = el('button', 'btn', 'Sign in');
    go.type = 'submit';
    act.appendChild(go);
    var cancel = el('button', 'btn ghost', 'Cancel');
    cancel.type = 'button';
    cancel.addEventListener('click', closeModal);
    act.appendChild(cancel);
    f.appendChild(act);
    body.appendChild(f);
    setTimeout(function () { var n = $('#f_passcode'); if (n) n.focus(); }, 30);

    f.addEventListener('submit', function (e) {
      e.preventDefault();
      msg.innerHTML = '';
      var code = f.passcode.value.trim();
      if (!code) { msg.appendChild(note('err', 'Enter your access code.')); return; }
      if (state.demo) {
        saveSession({ lab: state.labs[0] || 'Demo Lab', code: code, admin: false });
        closeModal(); render(); return;
      }
      go.disabled = true; go.textContent = 'Checking…';
      API.post({ action: 'unlock', passcode: code, website: f.website.value })
        .then(function (r) {
          go.disabled = false; go.textContent = 'Sign in';
          if (!r || !r.ok) { msg.appendChild(note('err', (r && r.error) || 'That code was not recognised.')); return; }
          saveSession({ lab: r.lab, code: code, admin: !!r.admin, dates: r.dates || [] });
          closeModal();
          render();
        })
        .catch(function (err) {
          go.disabled = false; go.textContent = 'Sign in';
          msg.appendChild(note('err', friendly(err)));
        });
    });
  }

  function friendly(err) {
    var m = String(err && err.message || err);
    if (m === 'NOT_CONFIGURED') return 'This site is not connected to a schedule yet.';
    return 'Could not reach the schedule service. Check your connection and try again.';
  }

  function openSlot(date) {
    var s = slotAt(date);
    if (!s) return;
    var st = statusOf(s);
    var d = parseDate(date);
    var names = labsOf(s);
    var sub = st === 'special' ? (s.note || 'Special session')
      : (names.length ? names.join(' & ') : 'No labs assigned yet');
    var body = openModal(DAYS[d.getDay()], d.getDate() + ' ' + MONTHS[d.getMonth()] + ' ' + d.getFullYear(), sub);

    var where = [];
    if (state.settings.startTime) where.push(state.settings.startTime + (state.settings.endTime ? '–' + state.settings.endTime : ''));
    if (state.settings.location) where.push(state.settings.location);
    if (where.length) body.appendChild(note('info', where.join(' · ')));

    if (st === 'break' || st === 'special') {
      if (s.note) body.appendChild(el('p', null, s.note));
      var a1 = el('div', 'actions');
      var c1 = el('button', 'btn ghost', 'Close');
      c1.addEventListener('click', closeModal);
      a1.appendChild(c1);
      body.appendChild(a1);
      return;
    }

    if (!assignedTalks(s).length) {
      body.appendChild(el('p', null, 'Neither presenter slot on this Friday has been allocated to a lab yet.'));
      if (state.settings.organizerEmail) {
        var p = el('p', 'hint');
        p.innerHTML = 'If your lab would like one, email <a href="mailto:' + esc(state.settings.organizerEmail) + '">' +
          esc(state.settings.organizerName || state.settings.organizerEmail) + '</a>.';
        body.appendChild(p);
      }
      return;
    }

    var panels = talksOf(s).map(function (t) {
      var panel = talkPanel(s, t);
      body.appendChild(panel.node);
      return panel;
    });

    var foot = el('div', 'actions');
    var close = el('button', 'btn ghost', 'Close');
    close.addEventListener('click', closeModal);
    foot.appendChild(close);
    body.appendChild(foot);

    var mine = panels.filter(function (panel) {
      return !panel.talk.filled && panel.talk.lab && myLab() && panel.talk.lab === myLab();
    });
    if (mine.length === 1) mine[0].expand();
  }

  function talkPanel(day, t) {
    var node = el('div', 'talk-panel');
    node.appendChild(el('div', 'eyebrow', ordinal(t.n)));
    var host = el('div');
    node.appendChild(host);

    function show() {
      host.innerHTML = '';
      if (!t.lab) {
        host.appendChild(el('p', 'hint', 'No lab has been allocated to this presenter slot yet.'));
        return;
      }
      if (t.filled) {
        var det = el('div', 'talk-detail');
        det.appendChild(el('div', 't', t.title));
        det.appendChild(el('div', 's', t.speaker + ' · ' + t.lab));
        host.appendChild(det);
      } else {
        host.appendChild(el('p', 'hint', t.lab + ' — speaker and title still needed.'));
      }
      var acts = el('div', 'actions');
      var go = el('button', 'btn' + (t.filled ? ' ghost' : ''),
        t.filled ? 'Update these details' : 'Add your details');
      go.addEventListener('click', expand);
      acts.appendChild(go);
      host.appendChild(acts);
    }

    function expand() {
      if (!t.lab) return;
      host.innerHTML = '';
      signupForm(host, day, t, show);
    }

    show();
    return { node: node, talk: t, expand: expand };
  }

  function signupForm(host, day, t, onCancel) {
    host.innerHTML = '';
    var sess = state.session;
    var needCode = !(sess && sess.code && (sess.admin || sess.lab === t.lab));

    var msg = el('div');
    host.appendChild(msg);

    if (!needCode) {
      host.appendChild(note('good', 'Signed in as ' + (sess.admin ? 'organizer' : sess.lab) + '.'));
    }

    var idp = 's' + t.n + '_';
    var f = document.createElement('form');
    if (needCode) {
      f.appendChild(field('Lab access code', 'passcode', 'text', '',
        'The code emailed to ' + t.lab + ' by the organizer.', 'off', idp));
    }
    f.appendChild(field('Presenter name', 'speaker', 'text', t.speaker || '', null, 'name', idp));
    f.appendChild(field('Email address', 'email', 'email', t.email || '',
      'Used only for reminders about this talk.', 'email', idp));
    f.appendChild(field('Talk title', 'title', 'text', t.title || '',
      'A working title is fine — you can change it later.', 'off', idp));

    var hp = el('input', 'hp');
    hp.name = 'website'; hp.tabIndex = -1; hp.setAttribute('aria-hidden', 'true'); hp.autocomplete = 'off';
    f.appendChild(hp);

    if (needCode) {
      var rem = el('label', 'hint');
      var cb = document.createElement('input');
      cb.type = 'checkbox'; cb.checked = true; cb.name = 'remember';
      cb.style.marginRight = '7px';
      rem.appendChild(cb);
      rem.appendChild(document.createTextNode('Stay signed in on this device'));
      f.appendChild(rem);
    }

    var acts = el('div', 'actions');
    var label = t.filled ? 'Save changes' : 'Confirm this talk';
    var go = el('button', 'btn', label);
    go.type = 'submit';
    acts.appendChild(go);
    var cancel = el('button', 'btn ghost', 'Cancel');
    cancel.type = 'button';
    cancel.addEventListener('click', function () { onCancel ? onCancel() : closeModal(); });
    acts.appendChild(cancel);
    if (t.filled) {
      var rm = el('button', 'btn danger spacer', 'Remove');
      rm.type = 'button';
      rm.addEventListener('click', function () { withdraw(day, t, msg, go); });
      acts.appendChild(rm);
    }
    f.appendChild(acts);
    host.appendChild(f);

    setTimeout(function () {
      var first = f.querySelector('input:not(.hp)');
      if (first) first.focus();
    }, 30);

    f.addEventListener('submit', function (e) {
      e.preventDefault();
      msg.innerHTML = '';
      var code = needCode ? f.passcode.value.trim() : sess.code;
      var payload = {
        action: 'signup',
        date: day.date,
        slot: t.n,
        lab: t.lab,
        passcode: code,
        speaker: f.speaker.value.trim(),
        email: f.email.value.trim(),
        title: f.title.value.trim(),
        website: f.website.value
      };
      if (!payload.speaker || !payload.email || !payload.title) {
        msg.appendChild(note('err', 'Please fill in all three fields.')); return;
      }
      if (state.demo) {
        msg.appendChild(note('info', 'Sample mode — nothing was saved. Connect the site to your sheet to accept real sign-ups.'));
        return;
      }
      go.disabled = true; go.textContent = 'Saving…';
      API.post(payload).then(function (r) {
        go.disabled = false; go.textContent = label;
        if (!r || !r.ok) { msg.appendChild(note('err', (r && r.error) || 'Something went wrong.')); return; }
        if (needCode && f.remember && f.remember.checked) saveSession({ lab: t.lab, code: code, admin: false });
        replaceSlot(r.slot);
        render();
        confirmed(r.slot, r.talk || talkIn(r.slot, t.n), payload.email);
      }).catch(function (err) {
        go.disabled = false; go.textContent = label;
        msg.appendChild(note('err', friendly(err)));
      });
    });
  }

  function talkIn(day, n) {
    return talksOf(day).filter(function (t) { return t.n === n; })[0] || { n: n, lab: '', speaker: '', title: '' };
  }

  function withdraw(day, t, msg, go) {
    if (!confirm('Remove ' + t.speaker + ' from ' + longDate(day.date) + '?')) return;
    var code = state.session && state.session.code;
    go.disabled = true;
    API.post({ action: 'withdraw', date: day.date, slot: t.n, passcode: code }).then(function (r) {
      go.disabled = false;
      if (!r || !r.ok) { msg.appendChild(note('err', (r && r.error) || 'Could not remove that entry.')); return; }
      replaceSlot(r.slot);
      render();
      closeModal();
    }).catch(function (err) {
      go.disabled = false;
      msg.appendChild(note('err', friendly(err)));
    });
  }

  function confirmed(day, talk, email) {
    var body = openModal('Confirmed', 'You are on the schedule', longDate(day.date));
    var det = el('div', 'talk-detail');
    det.appendChild(el('div', 't', talk.title));
    det.appendChild(el('div', 's', talk.speaker + ' · ' + talk.lab + ' · ' + ordinal(talk.n).toLowerCase()));
    body.appendChild(det);
    var other = talkIn(day, talk.n === 1 ? 2 : 1);
    if (other.lab) {
      body.appendChild(el('p', 'hint', other.filled
        ? 'The other talk that day is ' + other.speaker + ' (' + other.lab + ').'
        : 'The other talk that day is from ' + other.lab + ', still to be confirmed.'));
    }
    body.appendChild(el('p', null, 'A confirmation has gone to ' + email +
      ', and a reminder will follow a few days before your talk.'));
    var acts = el('div', 'actions');
    var c = el('button', 'btn', 'Done');
    c.addEventListener('click', closeModal);
    acts.appendChild(c);
    body.appendChild(acts);
  }

  function icsUrl() {
    return configured() ? CFG.apiUrl + '?action=ics' : '';
  }

  function downloadIcs() {
    var lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Seminar Series//EN', 'CALSCALE:GREGORIAN'];
    var name = state.settings.seriesName || 'Seminar Series';
    lines.push('X-WR-CALNAME:' + name);
    state.slots.forEach(function (s) {
      if (s.type === 'break') return;
      var heads = [], desc = [];
      talksOf(s).forEach(function (t) {
        if (t.filled) {
          heads.push(t.speaker + (t.lab ? ' (' + t.lab + ')' : ''));
          desc.push(t.speaker + (t.lab ? ' (' + t.lab + ')' : '') + ': ' + t.title);
        } else if (t.lab) {
          heads.push(t.lab + ' — title TBA');
          desc.push(t.lab + ': speaker and title still to be confirmed');
        }
      });
      var summary = s.type === 'special' ? (s.note || name)
        : (heads.length ? heads.join(' & ') : 'Speakers TBA');
      var dk = s.date.replace(/-/g, '');
      lines.push('BEGIN:VEVENT');
      lines.push('UID:' + s.date + '@seminar-series');
      lines.push('DTSTAMP:' + dk + 'T000000Z');
      lines.push('DTSTART;VALUE=DATE:' + dk);
      lines.push('DTEND;VALUE=DATE:' + nextDayKey(s.date).replace(/-/g, ''));
      lines.push('SUMMARY:' + summary.replace(/,/g, '\\,'));
      if (s.type !== 'special' && desc.length) {
        lines.push('DESCRIPTION:' + desc.join('\\n').replace(/,/g, '\\,'));
      }
      if (state.settings.location) lines.push('LOCATION:' + state.settings.location.replace(/,/g, '\\,'));
      lines.push('END:VEVENT');
    });
    lines.push('END:VCALENDAR');
    var blob = new Blob([lines.join('\r\n')], { type: 'text/calendar' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'seminar-series.ics';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  function nextDayKey(k) {
    var d = parseDate(k);
    d.setDate(d.getDate() + 1);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  var renderers = [];
  function onRender(fn) { renderers.push(fn); }
  function render() { renderers.forEach(function (fn) { try { fn(state); } catch (e) {} }); }

  function demoData() {
    var labNames = ['Okonjo Lab', 'Marchetti Lab', 'Devereux Lab', 'Sato Lab', 'Bennett Lab', 'Ferreira Lab'];
    var titles = [
      'Hippocampal replay during quiet wakefulness in juvenile rats',
      'A tunable optogenetic switch for cortical interneurons',
      'Mapping RNA velocity across regenerating zebrafish fin',
      'Do gut microbiota shape social preference in voles?'
    ];
    var speakers = ['Aditi Raman', 'Tomás Iglesias', 'Nour El-Amin', 'Wren Halliday',
      'Petra Lindqvist', 'Kofi Mensah'];
    var now = new Date();
    var year = now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1;
    var d = new Date(year, 8, 1);
    while (d.getDay() !== 5) d.setDate(d.getDate() + 1);
    var end = new Date(year + 1, 5, 30);
    var slots = [], i = 0;
    while (d <= end) {
      var key = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
      var day = { date: key, type: 'talk', note: '', talks: [] };
      var winter = d.getMonth() === 11 && d.getDate() > 18;
      if (winter) { day.type = 'break'; day.note = 'Winter break'; }
      [1, 2].forEach(function (n) {
        var k = i * 2 + n - 1;
        var talk = { n: n, lab: labNames[k % labNames.length], speaker: '', title: '', filled: false };
        if (winter) talk.lab = '';
        else if (k % 11 === 4) talk.lab = '';
        else if (key < todayKey() || k % 5 !== 2) {
          talk.speaker = speakers[k % speakers.length];
          talk.title = titles[k % titles.length];
          talk.filled = true;
        }
        day.talks.push(talk);
      });
      slots.push(day);
      d.setDate(d.getDate() + 7);
      i++;
    }
    return {
      ok: true,
      settings: {
        seriesName: CFG.seriesName || 'Departmental Seminar Series',
        tagline: CFG.tagline || 'Weekly research talks, September to June',
        location: CFG.location || 'Lecture Theatre B, Life Sciences',
        startTime: '12:00', endTime: '13:00',
        organizerName: 'the seminar organizer', organizerEmail: 'organizer@example.edu',
        timezone: 'America/Vancouver'
      },
      labs: labNames,
      slots: slots
    };
  }

  window.SEM = {
    state: state, load: load, render: render, onRender: onRender, chrome: chrome,
    renderCalendar: renderCalendar, renderMonthNav: renderMonthNav, renderList: renderList,
    openSlot: openSlot, openUnlock: openUnlock, openModal: openModal, closeModal: closeModal,
    statusOf: statusOf, labels: LABELS, isPast: isPast, upcoming: upcoming,
    talksOf: talksOf, filledTalks: filledTalks, assignedTalks: assignedTalks, labsOf: labsOf,
    hasLab: hasLab, talkStatus: talkStatus, talkLabels: TALK_LABELS, labelFor: labelFor,
    ordinal: ordinal,
    longDate: longDate, shortDate: shortDate, monthLabel: monthLabel, parseDate: parseDate,
    todayKey: todayKey, monthKey: monthKey, esc: esc, el: el, $: $, $$: $$, note: note,
    field: field, icsUrl: icsUrl, downloadIcs: downloadIcs, api: API, configured: configured,
    session: function () { return state.session; }, saveSession: saveSession, emptyBlock: emptyBlock,
    setMonth: function (m) { currentMonth = m; }, getMonth: function () { return currentMonth; },
    friendly: friendly
  };

  loadSession();

  document.addEventListener('DOMContentLoaded', function () {
    chrome();
    load().then(function () { chrome(); render(); })
      .catch(function () {
        state.demo = true;
        absorb(demoData());
        chrome();
        render();
      });
  });
})();
