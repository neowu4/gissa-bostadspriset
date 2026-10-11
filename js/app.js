/* Gissa bostadspriset – spellogik, nätverk (PeerJS) och vyer. */
(() => {
  'use strict';

  // ---------- Konstanter & hjälpare ----------
  const PEER_PREFIX = 'gissa-bostadspriset-v1-';
  const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const MIN_PRICE = 100_000;
  const MAX_PRICE = 60_000_000;
  const COLORS = ['#0b6b47', '#c0392b', '#2471a3', '#8e44ad', '#d68910', '#16a085', '#a04000', '#2e4053', '#c2185b', '#5d6d7e', '#7d6608', '#1f618d'];

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (n) => (n == null || !Number.isFinite(n) ? '–' : Math.round(n).toLocaleString('sv-SE'));
  const kr = (n) => `${fmt(n)} kr`;
  const pct = (x) => `${x > 0 ? '+' : ''}${(x * 100).toFixed(1).replace('.', ',')} %`;
  const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  const store = {
    get(k, d) { try { const v = localStorage.getItem('gbp:' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('gbp:' + k, JSON.stringify(v)); } catch { /* privat läge */ } },
  };
  const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const initials = (name) => (name || '?').trim().split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  const avatar = (p) => `<span class="avatar" style="background:${COLORS[p.color % COLORS.length]}">${esc(initials(p.name))}</span>`;
  const MONTHS = ['januari', 'februari', 'mars', 'april', 'maj', 'juni', 'juli', 'augusti', 'september', 'oktober', 'november', 'december'];
  const monthYear = (d) => { const m = /^(\d{4})-(\d{2})/.exec(d || ''); return m ? `${MONTHS[Number(m[2]) - 1]} ${m[1]}` : null; };

  function imgUrl(id, w = 1200) {
    if (/^https?:/.test(id)) return id;
    return `https://bcdn.se/images/cache/${id}_${w}x0.jpg`;
  }

  // Poäng: 1000 för exakt, linjärt ner till 0 när man är en faktor 1,75 fel (åt något håll).
  function scoreFor(guess, actual) {
    if (!guess || !actual) return 0;
    const err = Math.abs(Math.log(guess / actual));
    return Math.max(0, Math.round(1000 * (1 - err / Math.log(1.75))));
  }

  // Avrundar till "snygga" belopp: 3 värdesiffror, men minst jämna 5 000.
  function nicePrice(v) {
    if (!Number.isFinite(v) || v <= 0) return 0;
    const mag = Math.pow(10, Math.max(3, Math.floor(Math.log10(v)) - 2));
    const step = Math.max(5000, mag);
    return Math.round(v / step) * step;
  }

  let toastTimer;
  function toast(msg, ms = 2600) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), ms);
  }

  // ---------- Bostadsdata ----------
  let listingsPromise = null;
  function loadListings() {
    if (!listingsPromise) {
      listingsPromise = fetch('data/listings.json', { cache: 'no-cache' })
        .then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
        .then((d) => normalizeListings(d))
        .catch(() => []);
    }
    return listingsPromise;
  }
  function normalizeListings(d) {
    const arr = Array.isArray(d) ? d : (d && d.listings) || [];
    return arr.filter((l) => l && l.id && Number(l.soldPrice) > 0 && Array.isArray(l.images) && l.images.length);
  }

  function countyOf(l) { return l.county || 'Okänt län'; }
  function typeOf(l) { return l.objectType || 'Bostad'; }

  // Det spelarna får se under rundan – inget som avslöjar priset.
  function publicListing(l, settings) {
    const out = {
      id: l.id,
      objectType: l.objectType,
      areaName: l.areaName,
      municipality: l.municipality,
      county: l.county,
      livingArea: l.livingArea,
      additionalArea: l.additionalArea,
      plotArea: l.plotArea,
      rooms: l.rooms,
      floor: l.floor,
      constructionYear: l.constructionYear,
      rent: l.rent,
      operatingCost: l.operatingCost,
      tenureForm: l.tenureForm,
      amenities: l.amenities || [],
      soldMonth: monthYear(l.soldDate),
      images: (l.images || []).slice(0, 60),
    };
    if (settings.showAddress) {
      out.streetAddress = l.streetAddress;
      if (l.lat != null && l.lng != null) { out.lat = l.lat; out.lng = l.lng; }
    }
    if (settings.showListPrice) out.listPrice = l.listPrice;
    return out;
  }

  // ---------- Värd: spelmotor ----------
  class HostGame {
    constructor({ code, hostPlayer, listings, settings, onChange }) {
      this.code = code;
      this.listings = listings;
      this.settings = settings;
      this.onChange = onChange;
      this.players = new Map();
      this.colorSeq = 0;
      this.phase = 'lobby';
      this.deck = [];
      this.roundIdx = -1;
      this.guesses = new Map();
      this.results = null;
      this.deadline = 0;
      this.timer = null;
      this.addPlayer(hostPlayer.id, hostPlayer.name, true);
    }

    addPlayer(id, name, isHost = false) {
      name = String(name || 'Spelare').trim().slice(0, 20) || 'Spelare';
      let p = this.players.get(id);
      if (p) { p.connected = true; p.name = name; }
      else {
        p = { id, name, score: 0, lastPoints: 0, connected: true, isHost, color: this.colorSeq++ };
        this.players.set(id, p);
      }
      this.changed();
      return p;
    }
    rename(id, name) {
      const p = this.players.get(id);
      name = String(name || '').trim().slice(0, 20);
      if (!p || !name) return;
      p.name = name;
      this.changed();
    }
    setConnected(id, on) {
      const p = this.players.get(id);
      if (!p) return;
      p.connected = on;
      this.changed();
      if (!on) this.maybeAllGuessed();
    }
    removePlayer(id) {
      if (!this.players.get(id) || this.players.get(id).isHost) return;
      this.players.delete(id);
      this.guesses.delete(id);
      this.changed();
      this.maybeAllGuessed();
    }

    filteredListings() {
      const s = this.settings;
      return this.listings.filter((l) =>
        (s.type === 'alla' || typeOf(l) === s.type) &&
        (s.county === 'alla' || countyOf(l) === s.county) &&
        (!s.manyImages || (l.images || []).length >= 10));
    }

    start() {
      const pool = this.filteredListings();
      if (!pool.length) { toast('Inga bostäder matchar filtret.'); return; }
      const played = new Set(store.get('played', []));
      const fresh = shuffle(pool.filter((l) => !played.has(l.id)));
      const old = shuffle(pool.filter((l) => played.has(l.id)));
      this.deck = [...fresh, ...old].slice(0, Math.min(this.settings.rounds, pool.length));
      for (const p of this.players.values()) { p.score = 0; p.lastPoints = 0; }
      this.roundIdx = -1;
      this.nextRound();
    }

    nextRound() {
      clearTimeout(this.timer);
      this.roundIdx++;
      if (this.roundIdx >= this.deck.length) { this.phase = 'final'; this.changed(); return; }
      this.phase = 'round';
      this.guesses = new Map();
      this.results = null;
      const secs = Number(this.settings.seconds) || 0;
      this.deadline = secs ? Date.now() + secs * 1000 : 0;
      if (secs) this.timer = setTimeout(() => this.reveal(), secs * 1000 + 400);
      const played = store.get('played', []);
      store.set('played', [...new Set([...played, this.deck[this.roundIdx].id])].slice(-2000));
      this.changed();
    }

    guess(id, value) {
      if (this.phase !== 'round' || !this.players.has(id)) return;
      const v = Math.round(Number(value));
      if (!(v >= MIN_PRICE / 10 && v <= MAX_PRICE * 10)) return;
      this.guesses.set(id, v);
      this.changed();
      this.maybeAllGuessed();
    }

    maybeAllGuessed() {
      if (this.phase !== 'round') return;
      const active = [...this.players.values()].filter((p) => p.connected);
      if (active.length && active.every((p) => this.guesses.has(p.id))) {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.reveal(), 700);
      }
    }

    reveal() {
      if (this.phase !== 'round') return;
      clearTimeout(this.timer);
      const l = this.deck[this.roundIdx];
      const actual = l.soldPrice;
      const rows = [...this.players.values()].map((p) => {
        const g = this.guesses.get(p.id);
        return { id: p.id, name: p.name, color: p.color, guess: g ?? null, diff: g ? g / actual - 1 : null, points: g ? scoreFor(g, actual) : 0, bonus: 0 };
      });
      const guessed = rows.filter((r) => r.guess);
      guessed.sort((a, b) => Math.abs(Math.log(a.guess / actual)) - Math.abs(Math.log(b.guess / actual)));
      if (guessed.length > 1) {
        const best = Math.abs(Math.log(guessed[0].guess / actual));
        for (const r of guessed) if (Math.abs(Math.log(r.guess / actual)) === best && r.points > 0) r.bonus = 200;
      }
      for (const r of rows) {
        const p = this.players.get(r.id);
        p.lastPoints = r.points + r.bonus;
        p.score += p.lastPoints;
      }
      const ordered = [...guessed, ...rows.filter((r) => !r.guess)];
      this.results = {
        rows: ordered,
        listing: { ...l },
      };
      this.phase = 'reveal';
      this.changed();
    }

    next() {
      if (this.phase === 'reveal') this.nextRound();
    }
    backToLobby() {
      clearTimeout(this.timer);
      this.phase = 'lobby';
      this.roundIdx = -1;
      this.results = null;
      this.changed();
    }

    stateFor(playerId) {
      const players = [...this.players.values()].map((p) => ({
        id: p.id, name: p.name, score: p.score, lastPoints: p.lastPoints, connected: p.connected, isHost: p.isHost, color: p.color,
        guessed: this.phase === 'round' && this.guesses.has(p.id),
      }));
      const s = {
        code: this.code,
        phase: this.phase,
        settings: this.settings,
        players,
        poolSize: this.filteredListings().length,
        you: playerId,
      };
      if (this.phase === 'round' || this.phase === 'reveal') {
        const l = this.deck[this.roundIdx];
        s.round = {
          index: this.roundIdx,
          total: this.deck.length,
          listing: publicListing(l, this.settings),
          remainingMs: this.deadline ? Math.max(0, this.deadline - Date.now()) : 0,
          yourGuess: this.guesses.get(playerId) ?? null,
        };
        if (this.phase === 'reveal') s.round.results = this.results;
      }
      return s;
    }

    changed() { this.onChange && this.onChange(); }
  }

  // ---------- Nätverk ----------
  const net = {
    peer: null,
    conns: new Map(), // värd: playerId -> DataConnection
    hostConn: null, // klient
  };

  function randomCode() { return Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join(''); }

  function openHostPeer(onReady, attempt = 0) {
    if (typeof Peer === 'undefined') { onReady(null, 'PeerJS kunde inte laddas'); return; }
    const code = randomCode();
    const peer = new Peer(PEER_PREFIX + code, { debug: 1 });
    let done = false;
    peer.on('open', () => { done = true; net.peer = peer; onReady(code); });
    peer.on('error', (err) => {
      if (!done && err.type === 'unavailable-id' && attempt < 5) { peer.destroy(); openHostPeer(onReady, attempt + 1); return; }
      if (!done) { done = true; onReady(null, err.type || String(err)); return; }
      console.warn('Peer-fel', err);
    });
    peer.on('disconnected', () => { if (!peer.destroyed) setTimeout(() => peer.reconnect(), 1000); });
    peer.on('connection', (conn) => handleClientConnection(conn));
  }

  function handleClientConnection(conn) {
    let playerId = null;
    conn.on('data', (msg) => {
      if (!msg || typeof msg !== 'object' || !app.game) return;
      if (msg.t === 'join') {
        playerId = String(msg.id || uid()).slice(0, 40);
        const old = net.conns.get(playerId);
        if (old && old !== conn) try { old.close(); } catch { /* */ }
        net.conns.set(playerId, conn);
        const p = app.game.addPlayer(playerId, msg.name);
        toast(`${p.name} anslöt`);
      } else if (msg.t === 'rename' && playerId) {
        app.game.rename(playerId, msg.name);
      } else if (msg.t === 'guess' && playerId) {
        app.game.guess(playerId, msg.value);
      } else if (msg.t === 'leave' && playerId) {
        app.game.removePlayer(playerId);
        net.conns.delete(playerId);
      }
    });
    const gone = () => {
      if (playerId && net.conns.get(playerId) === conn) {
        net.conns.delete(playerId);
        app.game && app.game.setConnected(playerId, false);
      }
    };
    conn.on('close', gone);
    conn.on('error', gone);
  }

  function broadcast() {
    if (!app.game) return;
    for (const [pid, conn] of net.conns) {
      if (conn.open) {
        try { conn.send({ t: 'state', s: app.game.stateFor(pid) }); } catch (e) { console.warn(e); }
      }
    }
  }

  function connectToHost(code, name) {
    if (typeof Peer === 'undefined') { showError('PeerJS kunde inte laddas. Kontrollera nätverket.'); return; }
    cleanupNet();
    app.role = 'client';
    app.joinCode = code;
    renderConnecting(code);
    const peer = new Peer({ debug: 1 });
    net.peer = peer;
    let opened = false;
    const fail = (why) => {
      if (app.role !== 'client') return;
      renderDisconnected(code, why);
    };
    peer.on('open', () => {
      const conn = peer.connect(PEER_PREFIX + code, { reliable: true });
      net.hostConn = conn;
      const t = setTimeout(() => { if (!opened) fail('Hittade inget rum med den koden.'); }, 9000);
      conn.on('open', () => {
        opened = true;
        clearTimeout(t);
        conn.send({ t: 'join', id: app.me.id, name });
        history.replaceState(null, '', `?rum=${code}`);
      });
      conn.on('data', (msg) => {
        if (msg && msg.t === 'state') { app.state = msg.s; app.stateAt = Date.now(); render(); }
      });
      conn.on('close', () => fail('Anslutningen till värden bröts.'));
      conn.on('error', () => fail('Anslutningen till värden bröts.'));
    });
    peer.on('error', (err) => {
      if (err.type === 'peer-unavailable') fail('Hittade inget rum med koden ' + code + '.');
      else if (!opened) fail('Kunde inte ansluta (' + (err.type || 'okänt fel') + ').');
    });
  }

  function cleanupNet() {
    try { net.hostConn && net.hostConn.close(); } catch { /* */ }
    for (const c of net.conns.values()) try { c.close(); } catch { /* */ }
    net.conns.clear();
    try { net.peer && net.peer.destroy(); } catch { /* */ }
    net.peer = null;
    net.hostConn = null;
  }

  // Spelar-id per flik (sessionStorage) – överlever omladdning men två flikar blir två spelare.
  function tabPlayerId() {
    try {
      let id = sessionStorage.getItem('gbp:pid');
      if (!id) { id = uid(); sessionStorage.setItem('gbp:pid', id); }
      return id;
    } catch { return uid(); }
  }

  // ---------- App-tillstånd ----------
  const app = {
    role: null, // 'host' | 'client' | null
    game: null,
    state: null,
    stateAt: 0,
    me: { id: tabPlayerId(), name: store.get('name', '') },
    viewKey: null,
    ui: { img: 0, guess: null },
    allListings: [],
    customListings: null,
  };

  function renameMe(name) {
    app.me.name = name;
    store.set('name', name);
    if (app.role === 'host') app.game.rename(app.me.id, name);
    else if (net.hostConn && net.hostConn.open) net.hostConn.send({ t: 'rename', name });
  }

  function sendGuess(value) {
    if (app.role === 'host') app.game.guess(app.me.id, value);
    else if (net.hostConn && net.hostConn.open) net.hostConn.send({ t: 'guess', value });
  }

  function hostRefresh() {
    if (!app.game) return;
    app.state = app.game.stateFor(app.me.id);
    app.stateAt = Date.now();
    render();
    broadcast();
  }

  async function startHosting(name, { solo = false } = {}) {
    cleanupNet();
    app.role = 'host';
    app.me.name = name;
    renderConnecting(null, solo ? 'Laddar bostäder…' : 'Skapar rum…');
    const listings = app.customListings || await loadListings();
    app.allListings = listings;
    const settings = Object.assign(
      { rounds: 8, seconds: 45, type: 'alla', county: 'alla', showListPrice: false, showAddress: false, manyImages: false },
      store.get('settings', {}),
    );
    const begin = (code) => {
      app.game = new HostGame({ code, hostPlayer: { id: app.me.id, name }, listings, settings, onChange: hostRefresh });
      app.solo = !code;
      hostRefresh();
    };
    if (solo) { begin(null); return; }
    openHostPeer((code, err) => {
      if (!code) toast('Kunde inte skapa onlinerum (' + err + '). Du kan spela själv.', 5000);
      begin(code || null);
    });
  }

  function leave() {
    if (app.role === 'client' && net.hostConn && net.hostConn.open) try { net.hostConn.send({ t: 'leave' }); } catch { /* */ }
    if (app.game) clearTimeout(app.game.timer);
    cleanupNet();
    app.role = null; app.game = null; app.state = null; app.viewKey = null;
    history.replaceState(null, '', location.pathname);
    renderHome();
  }

  function showError(msg) { toast(msg, 5000); }

  // ---------- Vyer ----------
  const root = $('#app');

  function setTopbar(html) { $('#topbar-right').innerHTML = html || ''; }

  function render() {
    const s = app.state;
    if (!s) return;
    const key = `${s.phase}:${s.round ? s.round.index : ''}`;
    const sameView = key === app.viewKey;
    app.viewKey = key;
    topbarForState(s);
    if (s.phase === 'lobby') renderLobby(s, sameView);
    else if (s.phase === 'round') sameView ? updateRound(s) : renderRound(s);
    else if (s.phase === 'reveal') sameView ? updateReveal(s) : renderReveal(s);
    else if (s.phase === 'final') renderFinal(s);
  }

  function topbarForState(s) {
    const parts = [];
    if (s.round && (s.phase === 'round' || s.phase === 'reveal')) parts.push(`<span class="pill num">Bostad ${s.round.index + 1}/${s.round.total}</span>`);
    if (s.code) parts.push(`<span class="pill" title="Rumskod">Rum ${esc(s.code)}</span>`);
    const me = s.players.find((p) => p.id === s.you);
    if (me && s.phase !== 'lobby') parts.push(`<span class="pill num">${fmt(me.score)} p</span>`);
    setTopbar(parts.join(''));
  }

  // --- Start ---
  function renderHome() {
    app.viewKey = 'home';
    setTopbar('');
    const params = new URLSearchParams(location.search);
    const codeFromUrl = (params.get('rum') || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
    root.innerHTML = `
      <section class="hero pop">
        <div>
          <h1>Vad gick den<br>för, egentligen?</h1>
          <p class="lead">Riktiga sålda bostäder från Booli. Titta på bilderna, läs om bostaden och gissa slutpriset. Den som kommer närmast vinner.</p>
        </div>
        <div class="home-grid">
          <form class="card" id="join-form" autocomplete="off">
            <h2>Gå med i ett rum</h2>
            <div class="field"><label for="join-name">Ditt namn</label>
              <input class="input" id="join-name" maxlength="20" required value="${esc(app.me.name)}" placeholder="t.ex. Neo"></div>
            <div class="field"><label for="join-code">Rumskod</label>
              <input class="input code-input" id="join-code" maxlength="4" required value="${esc(codeFromUrl)}" placeholder="ABCD" autocapitalize="characters"></div>
            <button class="btn primary big block" type="submit">Gå med</button>
          </form>
          <form class="card" id="host-form" autocomplete="off">
            <h2>Skapa ett rum</h2>
            <p class="muted small" style="margin:0">Du blir värd och spelar själv också. Kompisarna går med från sina mobiler med en kod eller QR-kod.</p>
            <div class="field"><label for="host-name">Ditt namn</label>
              <input class="input" id="host-name" maxlength="20" required value="${esc(app.me.name)}" placeholder="t.ex. Neo"></div>
            <button class="btn primary big block" type="submit">Skapa rum</button>
            <button class="btn ghost block" type="button" id="solo-btn">Spela själv</button>
          </form>
        </div>
        <div class="how">
          <div><b>1. Skapa ett rum</b>Visa koden eller QR-koden på en skärm som alla ser.</div>
          <div><b>2. Gissa slutpriset</b>Alla gissar på sin egen mobil innan tiden tar slut.</div>
          <div><b>3. Facit</b>Upp till 1000 p per bostad, och +200 till den som kom närmast.</div>
        </div>
      </section>
      <p class="footer-note">Data och bilder kommer från Booli.se. <a href="importera.html">Lägg till fler bostäder</a></p>`;
    const saveName = (v) => { app.me.name = v.trim(); store.set('name', app.me.name); };
    $('#join-form').onsubmit = (e) => {
      e.preventDefault();
      const name = $('#join-name').value.trim();
      const code = $('#join-code').value.toUpperCase().replace(/[^A-Z]/g, '');
      if (code.length !== 4) { toast('Rumskoden har fyra bokstäver.'); return; }
      saveName(name);
      connectToHost(code, name);
    };
    $('#host-form').onsubmit = (e) => {
      e.preventDefault();
      const name = $('#host-name').value.trim();
      saveName(name);
      startHosting(name);
    };
    $('#solo-btn').onclick = () => {
      const name = $('#host-name').value.trim() || app.me.name || 'Jag';
      saveName(name);
      startHosting(name, { solo: true });
    };
    if (codeFromUrl) $('#join-name').focus();
  }

  function renderConnecting(code, msg) {
    app.viewKey = 'connecting';
    setTopbar(code ? `<span class="pill">Rum ${esc(code)}</span>` : '');
    root.innerHTML = `<div class="card empty pop"><div class="spinner"></div><p class="muted">${esc(msg || 'Ansluter till rum ' + code + '…')}</p></div>`;
  }

  function renderDisconnected(code, why) {
    app.viewKey = 'disconnected';
    root.innerHTML = `
      <div class="card empty pop stack" style="max-width:480px;margin:0 auto">
        <h2>Ingen kontakt</h2>
        <p class="muted" style="margin:0">${esc(why)}</p>
        <div class="row" style="justify-content:center">
          <button class="btn primary" id="retry">Försök igen</button>
          <button class="btn" id="home">Till start</button>
        </div>
      </div>`;
    $('#retry').onclick = () => connectToHost(code, app.me.name);
    $('#home').onclick = leave;
  }

  // --- Lobby ---
  function joinUrl(code) {
    const u = new URL(location.href);
    u.search = `?rum=${code}`;
    u.hash = '';
    return u.toString();
  }

  function renderLobby(s, sameView) {
    const isHost = app.role === 'host';
    const playersHtml = s.players.map((p) => `
      <span class="player-chip ${p.connected ? '' : 'off'}">${avatar(p)} ${esc(p.name)}${p.isHost ? ' <span class="muted small">(värd)</span>' : ''}${p.id === s.you ? ' <span class="muted small">(du)</span>' : ''}</span>`).join('');

    if (sameView && $('#lobby-players')) {
      $('#lobby-players').innerHTML = playersHtml;
      $('#player-count').textContent = s.players.length;
      if (!isHost) $('#client-settings').innerHTML = settingsSummary(s);
      if (isHost) $('#pool-size').textContent = fmt(s.poolSize);
      return;
    }

    const countBy = (f) => app.allListings.reduce((m, l) => m.set(f(l), (m.get(f(l)) || 0) + 1), new Map());
    const countyCount = countBy(countyOf), typeCount = countBy(typeOf);
    const counties = [...countyCount.keys()].sort((a, b) => a.localeCompare(b, 'sv'));
    const types = [...typeCount.keys()].sort((a, b) => a.localeCompare(b, 'sv'));
    const st = s.settings;
    const opt = (v, label, cur) => `<option value="${esc(v)}" ${String(cur) === String(v) ? 'selected' : ''}>${esc(label)}</option>`;

    const left = s.code ? `
      <div class="card stack">
        <div class="label">Gå in på sidan och skriv rumskoden</div>
        <div class="row" style="justify-content:space-between;align-items:center">
          <div class="room-code">${esc(s.code)}</div>
          <div class="qr" id="qr" title="Skanna för att gå med"></div>
        </div>
        <div class="row">
          <button class="btn" id="copy-link">Kopiera länk</button>
          ${navigator.share ? '<button class="btn" id="share-link">Dela</button>' : ''}
        </div>
      </div>` : `
      <div class="card stack">
        <h2>Ensamspel</h2>
        <p class="muted" style="margin:0">Du spelar själv. Vill du spela med andra, gå tillbaka och skapa ett rum i stället.</p>
      </div>`;

    root.innerHTML = `
      <div class="lobby pop">
        <div class="stack">
          ${left}
          <div class="card stack">
            <h3>Spelare (<span id="player-count">${s.players.length}</span>)</h3>
            <div class="players" id="lobby-players">${playersHtml}</div>
            <form class="rename" id="rename-form" autocomplete="off">
              <label class="label" for="rename-input">Ditt namn</label>
              <div class="row" style="flex-wrap:nowrap">
                <input class="input" id="rename-input" maxlength="20" required value="${esc(s.players.find((p) => p.id === s.you)?.name || app.me.name)}">
                <button class="btn" type="submit">Byt namn</button>
              </div>
            </form>
          </div>
        </div>
        <div class="stack">
          ${isHost ? `
          <div class="card stack">
            <h3>Inställningar</h3>
            <div class="settings">
              <div class="field"><label for="set-rounds">Antal bostäder</label>
                <select class="input" id="set-rounds">${[3, 5, 8, 10, 15, 20].map((n) => opt(n, n, st.rounds)).join('')}</select></div>
              <div class="field"><label for="set-seconds">Tid per bostad</label>
                <select class="input" id="set-seconds">${[[20, '20 s'], [30, '30 s'], [45, '45 s'], [60, '60 s'], [90, '90 s'], [0, 'Ingen tidsgräns']].map(([v, l]) => opt(v, l, st.seconds)).join('')}</select></div>
              <div class="field"><label for="set-type">Bostadstyp</label>
                <select class="input" id="set-type">${opt('alla', 'Alla typer', st.type)}${types.map((t) => opt(t, `${t} (${typeCount.get(t)})`, st.type)).join('')}</select></div>
              <div class="field"><label for="set-county">Område</label>
                <select class="input" id="set-county">${opt('alla', 'Hela Sverige', st.county)}${counties.map((c) => opt(c, `${c} (${countyCount.get(c)})`, st.county)).join('')}</select></div>
            </div>
            <label class="toggle"><input type="checkbox" id="set-listprice" ${st.showListPrice ? 'checked' : ''}> Visa utgångspris (lättare)</label>
            <label class="toggle"><input type="checkbox" id="set-address" ${st.showAddress ? 'checked' : ''}> Visa gatuadress</label>
            <label class="toggle"><input type="checkbox" id="set-images" ${st.manyImages ? 'checked' : ''}> Bara bostäder med minst 10 bilder</label>
            <p class="muted small" style="margin:0"><span id="pool-size">${fmt(s.poolSize)}</span> bostäder matchar ·
              <label style="color:var(--accent);cursor:pointer;text-decoration:underline">ladda egen fil<input type="file" id="custom-file" accept=".json,application/json" hidden></label></p>
            <button class="btn primary big block" id="start-btn" ${s.poolSize ? '' : 'disabled'}>Starta spelet</button>
          </div>` : `
          <div class="card stack">
            <h3>Väntar på att värden startar…</h3>
            <div id="client-settings" class="muted small">${settingsSummary(s)}</div>
            <div class="spinner"></div>
          </div>`}
          <button class="btn ghost" id="leave-btn">${isHost ? 'Avsluta rummet' : 'Lämna rummet'}</button>
        </div>
      </div>`;

    if (s.code && typeof QRCode !== 'undefined') {
      try { new QRCode($('#qr'), { text: joinUrl(s.code), width: 148, height: 148, correctLevel: QRCode.CorrectLevel.M }); } catch { $('#qr').remove(); }
    } else if ($('#qr')) $('#qr').remove();
    if ($('#copy-link')) $('#copy-link').onclick = async () => {
      try { await navigator.clipboard.writeText(joinUrl(s.code)); toast('Länken kopierades'); } catch { prompt('Kopiera länken:', joinUrl(s.code)); }
    };
    if ($('#share-link')) $('#share-link').onclick = () => navigator.share({ title: 'Gissa bostadspriset', text: `Gå med i mitt rum: ${s.code}`, url: joinUrl(s.code) }).catch(() => {});
    $('#leave-btn').onclick = () => { if (!isHost || confirm('Avsluta rummet för alla?')) leave(); };
    $('#rename-form').onsubmit = (e) => {
      e.preventDefault();
      const name = $('#rename-input').value.trim().slice(0, 20);
      if (!name) return;
      renameMe(name);
      $('#rename-input').blur();
      toast(`Du heter nu ${name}`);
    };

    if (isHost) {
      const g = app.game;
      const save = () => { store.set('settings', g.settings); g.changed(); };
      $('#set-rounds').onchange = (e) => { g.settings.rounds = Number(e.target.value); save(); };
      $('#set-seconds').onchange = (e) => { g.settings.seconds = Number(e.target.value); save(); };
      $('#set-type').onchange = (e) => { g.settings.type = e.target.value; save(); refreshStart(); };
      $('#set-county').onchange = (e) => { g.settings.county = e.target.value; save(); refreshStart(); };
      $('#set-listprice').onchange = (e) => { g.settings.showListPrice = e.target.checked; save(); };
      $('#set-address').onchange = (e) => { g.settings.showAddress = e.target.checked; save(); };
      $('#set-images').onchange = (e) => { g.settings.manyImages = e.target.checked; save(); refreshStart(); };
      $('#start-btn').onclick = () => g.start();
      $('#custom-file').onchange = async (e) => {
        const f = e.target.files[0];
        if (!f) return;
        try {
          const list = normalizeListings(JSON.parse(await f.text()));
          if (!list.length) throw new Error('tom');
          const byId = new Map([...g.listings, ...list].map((l) => [l.id, l]));
          g.listings = [...byId.values()];
          app.allListings = g.listings;
          app.customListings = g.listings;
          toast(`${list.length} bostäder lades till`);
          app.viewKey = null;
          g.changed();
        } catch { toast('Kunde inte läsa filen – är det en export från importverktyget?'); }
      };
      function refreshStart() { const n = g.filteredListings().length; $('#start-btn').disabled = !n; }
    }
  }

  function settingsSummary(s) {
    const st = s.settings;
    return [`${st.rounds} bostäder`, st.seconds ? `${st.seconds} s per bostad` : 'ingen tidsgräns', st.type === 'alla' ? 'alla typer' : st.type.toLowerCase(), st.county === 'alla' ? 'hela Sverige' : st.county]
      .map(esc).join(' · ');
  }

  // --- Runda ---
  function factsHtml(l, { reveal = false } = {}) {
    const facts = [];
    const add = (k, v) => { if (v != null && v !== '' && !(typeof v === 'number' && !Number.isFinite(v))) facts.push([k, v]); };
    add('Boarea', l.livingArea ? `${fmt(l.livingArea)} m²` : null);
    add('Rum', l.rooms ? `${String(l.rooms).replace('.', ',')} rum` : null);
    add('Biarea', l.additionalArea ? `${fmt(l.additionalArea)} m²` : null);
    add('Tomt', l.plotArea ? `${fmt(l.plotArea)} m²` : null);
    add('Byggår', l.constructionYear);
    add('Avgift', l.rent ? `${fmt(l.rent)} kr/mån` : null);
    add('Drift', l.operatingCost ? `${fmt(l.operatingCost)} kr/mån` : null);
    add('Våning', l.floor ? l.floor.replace(/^våning\s*/i, '') : null);
    add('Upplåtelse', l.tenureForm);
    add('Såld', reveal ? (l.soldDate || null) : l.soldMonth);
    if (l.listPrice) add('Utgångspris', kr(l.listPrice));
    const place = [l.areaName, l.municipality].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(', ');
    return `
      <div class="facts-title">
        <div>
          <div class="label">${esc(l.objectType || 'Bostad')}</div>
          <h2>${esc(l.streetAddress || place || 'Okänd plats')}</h2>
          ${l.streetAddress && place ? `<div class="muted">${esc(place)}</div>` : ''}
        </div>
      </div>
      <div class="facts">${facts.map(([k, v]) => `<div class="fact"><div class="k">${esc(k)}</div><div class="v num">${esc(v)}</div></div>`).join('')}</div>
      ${l.amenities && l.amenities.length ? `<div class="chips">${l.amenities.map((a) => `<span class="chip">${esc(a)}</span>`).join('')}</div>` : ''}`;
  }

  // Google Maps-inbäddning utan API-nyckel. Under rundan visas bara området (om inte gatuadress är påslaget).
  function mapHtml(l, { exact = false } = {}) {
    const place = [l.areaName, l.municipality].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(', ');
    const hasPos = l.lat != null && l.lng != null;
    let q, z;
    if (hasPos && (exact || l.streetAddress)) { q = `${l.lat},${l.lng}`; z = 15; }
    else if (place) { q = `${place}, Sverige`; z = 12; }
    else return '';
    const src = `https://maps.google.com/maps?q=${encodeURIComponent(q)}&z=${z}&hl=sv&output=embed`;
    const link = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
    return `
      <div class="card map-card">
        <div class="map-head">
          <h3>${exact || l.streetAddress ? 'Här ligger bostaden' : 'Ungefär här'}</h3>
          <a class="small" href="${esc(link)}" target="_blank" rel="noopener">Öppna i Google Maps ↗</a>
        </div>
        <iframe class="map" title="Karta över ${esc(place || 'bostaden')}" src="${esc(src)}" loading="lazy" referrerpolicy="no-referrer-when-downgrade" allowfullscreen></iframe>
        ${exact || l.streetAddress ? '' : '<p class="muted small" style="margin:8px 0 0">Exakt läge visas i facit.</p>'}
      </div>`;
  }

  function galleryHtml(images) {
    return `
      <div>
        <div class="gallery" id="gallery">
          <img class="main" id="main-img" alt="Bild på bostaden" src="${esc(imgUrl(images[0]))}">
          ${images.length > 1 ? '<button class="nav prev" id="img-prev" aria-label="Föregående bild">‹</button><button class="nav next" id="img-next" aria-label="Nästa bild">›</button>' : ''}
          <div class="counter num" id="img-counter">1 / ${images.length}</div>
        </div>
        <div class="thumbs" id="thumbs">${images.map((id, i) => `<button data-i="${i}" class="${i ? '' : 'on'}" aria-label="Bild ${i + 1}"><img loading="lazy" alt="" src="${esc(imgUrl(id, 180))}"></button>`).join('')}</div>
      </div>`;
  }

  function wireGallery(images) {
    app.ui.img = 0;
    const show = (i) => {
      app.ui.img = (i + images.length) % images.length;
      $('#main-img').src = imgUrl(images[app.ui.img]);
      $('#img-counter').textContent = `${app.ui.img + 1} / ${images.length}`;
      $$('#thumbs button').forEach((b, j) => b.classList.toggle('on', j === app.ui.img));
      const on = $(`#thumbs button[data-i="${app.ui.img}"]`);
      if (on) on.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
      // Förladda nästa bild
      if (images.length > 1) { const pre = new Image(); pre.src = imgUrl(images[(app.ui.img + 1) % images.length]); }
    };
    app.ui.showImg = show;
    if ($('#img-prev')) $('#img-prev').onclick = () => show(app.ui.img - 1);
    if ($('#img-next')) $('#img-next').onclick = () => show(app.ui.img + 1);
    $('#thumbs').onclick = (e) => { const b = e.target.closest('button[data-i]'); if (b) show(Number(b.dataset.i)); };
    $('#main-img').onclick = () => openLightbox(images, app.ui.img);
    // Svep på mobil
    let x0 = null;
    const g = $('#gallery');
    g.addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; }, { passive: true });
    g.addEventListener('touchend', (e) => {
      if (x0 == null) return;
      const dx = e.changedTouches[0].clientX - x0;
      if (Math.abs(dx) > 40) show(app.ui.img + (dx < 0 ? 1 : -1));
      x0 = null;
    });
    if (images.length > 1) { const pre = new Image(); pre.src = imgUrl(images[1]); }
  }

  function openLightbox(images, start) {
    const lb = $('#lightbox');
    let i = start;
    const draw = () => {
      lb.innerHTML = `<img src="${esc(imgUrl(images[i], 2048))}" alt="">${images.length > 1 ? '<button class="nav prev" aria-label="Föregående">‹</button><button class="nav next" aria-label="Nästa">›</button>' : ''}`;
    };
    const close = () => { lb.hidden = true; lb.innerHTML = ''; document.removeEventListener('keydown', onKey); if (app.ui.showImg) app.ui.showImg(i); };
    const step = (d) => { i = (i + d + images.length) % images.length; draw(); };
    const onKey = (e) => { if (e.key === 'Escape') close(); else if (e.key === 'ArrowRight') step(1); else if (e.key === 'ArrowLeft') step(-1); };
    lb.onclick = (e) => {
      if (e.target.closest('.prev')) { e.stopPropagation(); step(-1); }
      else if (e.target.closest('.next')) { e.stopPropagation(); step(1); }
      else close();
    };
    document.addEventListener('keydown', onKey);
    draw();
    lb.hidden = false;
  }

  // Logaritmiskt reglage: 0..1000 ↔ MIN_PRICE..MAX_PRICE
  const toSlider = (v) => Math.round(1000 * (Math.log(v) - Math.log(MIN_PRICE)) / (Math.log(MAX_PRICE) - Math.log(MIN_PRICE)));
  const fromSlider = (x) => Math.exp(Math.log(MIN_PRICE) + (x / 1000) * (Math.log(MAX_PRICE) - Math.log(MIN_PRICE)));

  function defaultGuess(l) {
    if (l.listPrice) return nicePrice(l.listPrice);
    const area = l.livingArea || 70;
    const perSqm = /villa|fritid|gård/i.test(l.objectType || '') ? 30000 : 50000;
    return nicePrice(Math.min(MAX_PRICE, Math.max(MIN_PRICE, area * perSqm)));
  }

  function renderRound(s) {
    const r = s.round;
    const l = r.listing;
    const images = l.images.length ? l.images : [];
    app.ui.guess = r.yourGuess || defaultGuess(l);
    app.ui.touched = false;
    root.innerHTML = `
      <div class="round pop">
        <div class="stack">
          ${galleryHtml(images)}
          <div class="card">${factsHtml(l)}</div>
          ${mapHtml(l)}
        </div>
        <aside class="card guess-panel" id="guess-panel"></aside>
      </div>`;
    wireGallery(images);
    renderGuessPanel(s);
    startTick();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function renderGuessPanel(s) {
    const r = s.round;
    const panel = $('#guess-panel');
    const locked = r.yourGuess != null;
    const timerHtml = r.remainingMs || s.settings.seconds ? `
      <div class="timer-label"><span>Tid kvar</span><span class="num" id="time-left"></span></div>
      <div class="timer" id="timer"><div></div></div>` : '';
    if (locked) {
      panel.innerHTML = `
        ${timerHtml}
        <div class="label" style="text-align:center">Din gissning</div>
        <div class="guess-amount num">${fmt(r.yourGuess)} <small>kr</small></div>
        <div class="locked">✓ Inlåst. Väntar på de andra…</div>
        <div class="players" id="guess-status">${guessStatus(s)}</div>
        ${hostControls(s)}`;
    } else {
      panel.innerHTML = `
        ${timerHtml}
        <div class="label" style="text-align:center">Vad tror du att den såldes för?</div>
        <div class="guess-amount num" id="guess-amount">${fmt(app.ui.guess)} <small>kr</small></div>
        <input type="range" id="guess-range" min="0" max="1000" step="1" value="${toSlider(app.ui.guess)}" aria-label="Gissning">
        <div class="adjust">
          <button class="btn" data-adj="-0.1">−10 %</button>
          <button class="btn" data-adj="-0.02">−2 %</button>
          <button class="btn" data-adj="0.02">+2 %</button>
          <button class="btn" data-adj="0.1">+10 %</button>
        </div>
        <div class="field"><label for="guess-input">Eller skriv beloppet</label>
          <input class="input num" id="guess-input" inputmode="numeric" autocomplete="off" value="${fmt(app.ui.guess)}"></div>
        <button class="btn primary big block" id="lock-btn">Lås in gissning</button>
        <div class="players" id="guess-status">${guessStatus(s)}</div>
        ${hostControls(s)}`;
      const setGuess = (v, from) => {
        v = Math.max(MIN_PRICE / 2, Math.min(MAX_PRICE * 2, v));
        app.ui.guess = v;
        app.ui.touched = true;
        $('#guess-amount').innerHTML = `${fmt(v)} <small>kr</small>`;
        if (from !== 'range') $('#guess-range').value = toSlider(Math.max(MIN_PRICE, Math.min(MAX_PRICE, v)));
        if (from !== 'input') $('#guess-input').value = fmt(v);
      };
      $('#guess-range').oninput = (e) => setGuess(nicePrice(fromSlider(Number(e.target.value))), 'range');
      $('#guess-input').oninput = (e) => {
        const digits = e.target.value.replace(/\D/g, '');
        const v = Number(digits);
        if (v) setGuess(v, 'input');
      };
      $('#guess-input').onblur = (e) => { e.target.value = fmt(app.ui.guess); };
      // På mobil är textfältet dolt – tryck på beloppet för att skriva in det.
      $('#guess-amount').onclick = () => {
        if (getComputedStyle($('#guess-input').parentElement).display !== 'none') { $('#guess-input').focus(); $('#guess-input').select(); return; }
        const v = Number(String(prompt('Skriv din gissning i kronor:', String(Math.round(app.ui.guess))) || '').replace(/\D/g, ''));
        if (v) setGuess(v);
      };
      $('#guess-input').onkeydown = (e) => { if (e.key === 'Enter') $('#lock-btn').click(); };
      $$('[data-adj]', panel).forEach((b) => { b.onclick = () => setGuess(nicePrice(app.ui.guess * (1 + Number(b.dataset.adj)))); });
      $('#lock-btn').onclick = () => {
        $('#lock-btn').disabled = true;
        sendGuess(Math.round(app.ui.guess));
      };
    }
    wireHostControls();
    tick();
  }

  function guessStatus(s) {
    return s.players.filter((p) => p.connected).map((p) => `<span class="player-chip ${p.guessed ? 'done' : ''}" title="${p.guessed ? 'Har gissat' : 'Tänker…'}">${avatar(p)} ${esc(p.name)} ${p.guessed ? '✓' : '…'}</span>`).join('');
  }

  function hostControls(s) {
    if (app.role !== 'host') return '';
    if (s.phase === 'round') return '<button class="btn ghost block small" id="force-reveal">Visa facit nu</button>';
    return '';
  }
  function wireHostControls() {
    if ($('#force-reveal')) $('#force-reveal').onclick = () => app.game.reveal();
  }

  function updateRound(s) {
    const r = s.round;
    const wasLocked = !$('#guess-range');
    const isLocked = r.yourGuess != null;
    if (wasLocked !== isLocked) { renderGuessPanel(s); return; }
    const gs = $('#guess-status');
    if (gs) gs.innerHTML = guessStatus(s);
  }

  let tickHandle = null;
  function startTick() {
    clearInterval(tickHandle);
    tickHandle = setInterval(tick, 250);
  }
  function tick() {
    const s = app.state;
    if (!s || s.phase !== 'round') { clearInterval(tickHandle); return; }
    const total = (Number(s.settings.seconds) || 0) * 1000;
    if (!total) return;
    const left = Math.max(0, s.round.remainingMs - (Date.now() - app.stateAt));
    const el = $('#time-left');
    const bar = $('#timer');
    if (el) el.textContent = `${Math.ceil(left / 1000)} s`;
    if (bar) {
      bar.firstElementChild.style.width = `${Math.min(100, (left / total) * 100)}%`;
      bar.classList.toggle('low', left < 10_000);
    }
    // Skicka in automatiskt om man rört reglaget men inte hunnit låsa
    if (left <= 600 && s.round.yourGuess == null && app.ui.touched && app.ui.autoSent !== s.round.index) {
      app.ui.autoSent = s.round.index;
      sendGuess(Math.round(app.ui.guess));
    }
  }

  // --- Facit ---
  function renderReveal(s) {
    const r = s.round;
    const res = r.results;
    const l = res.listing;
    const actual = l.soldPrice;
    const isHost = app.role === 'host';
    const last = r.index + 1 >= r.total;

    const guesses = res.rows.filter((x) => x.guess);
    const all = [actual, ...guesses.map((x) => x.guess)];
    const lo = Math.min(...all) * 0.92, hi = Math.max(...all) * 1.08;
    const pos = (v) => `${((Math.log(v) - Math.log(lo)) / (Math.log(hi) - Math.log(lo))) * 100}%`;

    const rows = res.rows.map((x, i) => `
      <div class="result ${x.id === s.you ? 'me' : ''}">
        <span class="place">${x.guess ? i + 1 : '–'}</span>
        ${avatar(x)}
        <div style="min-width:0">
          <div class="name">${esc(x.name)}${x.bonus ? ' 🎯' : ''}</div>
          <div class="sub num">${x.guess ? `${kr(x.guess)} · <span class="${x.diff > 0 ? 'diff-up' : 'diff-down'}">${pct(x.diff)}</span>` : 'Gissade inte'}</div>
        </div>
        <div class="pts num">+${fmt(x.points + x.bonus)}${x.bonus ? '<small>inkl. +200 närmast</small>' : ''}</div>
      </div>`).join('');

    root.innerHTML = `
      <div class="round reveal pop">
        <div class="stack">
          ${galleryHtml(l.images)}
          <div class="card">${factsHtml({ ...l, soldMonth: monthYear(l.soldDate) }, { reveal: true })}
            <p class="small" style="margin:14px 0 0"><a href="${esc(l.url)}" target="_blank" rel="noopener">Se bostaden på Booli ↗</a></p></div>
          ${mapHtml(l, { exact: true })}
        </div>
        <aside class="stack guess-panel">
          <div class="card stack">
            <div class="reveal-price">
              <div class="label">Slutpris</div>
              <div class="price num" id="price-count">${kr(actual)}</div>
              ${l.listPrice ? `<div class="muted small num">Utgångspris ${kr(l.listPrice)} (${pct(actual / l.listPrice - 1)})</div>` : ''}
            </div>
            ${guesses.length ? `
            <div class="scale" aria-hidden="true">
              <div class="line"></div>
              <div class="truth" style="left:${pos(actual)}" title="Slutpris"></div>
              ${guesses.map((x) => `<div class="mark" style="left:${pos(x.guess)}">${avatar(x)}</div>`).join('')}
            </div>` : ''}
            <div class="results">${rows}</div>
          </div>
          <div class="card stack">
            <h3>Ställning</h3>
            <div class="scoreboard">${scoreboard(s)}</div>
            ${isHost ? `<button class="btn primary big block" id="next-btn">${last ? 'Visa slutresultat' : 'Nästa bostad →'}</button>` : `<p class="muted small" style="margin:0;text-align:center">Värden går vidare till ${last ? 'slutresultatet' : 'nästa bostad'}…</p>`}
          </div>
        </aside>
      </div>`;
    wireGallery(l.images);
    animateCount($('#price-count'), actual);
    if (isHost) $('#next-btn').onclick = () => app.game.next();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function updateReveal(s) {
    const sb = $('.scoreboard');
    if (sb) sb.innerHTML = scoreboard(s);
  }

  function scoreboard(s) {
    return [...s.players].sort((a, b) => b.score - a.score).map((p, i) => `
      <div class="score-row">
        <span class="muted num" style="width:20px">${i + 1}</span>${avatar(p)}
        <span class="name">${esc(p.name)}${p.connected ? '' : ' <span class="muted small">(borta)</span>'}</span>
        ${p.lastPoints ? `<span class="delta num">+${fmt(p.lastPoints)}</span>` : ''}
        <strong class="num">${fmt(p.score)}</strong>
      </div>`).join('');
  }

  function animateCount(el, target) {
    if (!el || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const t0 = performance.now(), dur = 1100;
    const step = (t) => {
      const k = Math.min(1, (t - t0) / dur);
      const e = 1 - Math.pow(1 - k, 3);
      el.textContent = kr(nicePrice(target * e) || 0);
      if (k < 1) requestAnimationFrame(step); else el.textContent = kr(target);
    };
    requestAnimationFrame(step);
  }

  // --- Slut ---
  function renderFinal(s) {
    const ranked = [...s.players].sort((a, b) => b.score - a.score);
    const [p1, p2, p3] = ranked;
    const step = (p, n) => p ? `<div class="step p${n}">${avatar(p)}<strong>${esc(p.name)}</strong><span class="num muted small">${fmt(p.score)} p</span><div class="block">${n}</div></div>` : '';
    const isHost = app.role === 'host';
    root.innerHTML = `
      <div class="card stack pop" style="max-width:720px;margin:0 auto">
        <div style="text-align:center">
          <div class="label">Slutresultat</div>
          <h1 style="font-size:clamp(28px,6vw,44px)">${p1 ? `${esc(p1.name)} vinner! 🏆` : 'Spelet är slut'}</h1>
        </div>
        <div class="podium">${step(p2, 2)}${step(p1, 1)}${step(p3, 3)}</div>
        <div class="scoreboard">${scoreboard({ ...s, players: ranked.map((p) => ({ ...p, lastPoints: 0 })) })}</div>
        ${isHost ? `
        <div class="row" style="justify-content:center">
          <button class="btn primary big" id="again-btn">Spela igen</button>
          <button class="btn" id="lobby-btn">Ändra inställningar</button>
        </div>` : '<p class="muted small" style="text-align:center;margin:0">Värden kan starta en ny omgång.</p>'}
        <button class="btn ghost" id="leave-btn">${isHost ? 'Avsluta rummet' : 'Lämna rummet'}</button>
      </div>`;
    if (isHost) {
      $('#again-btn').onclick = () => app.game.start();
      $('#lobby-btn').onclick = () => app.game.backToLobby();
    }
    $('#leave-btn').onclick = leave;
  }

  // ---------- Start ----------
  $('[data-home]').onclick = (e) => {
    e.preventDefault();
    if (!app.role || confirm(app.role === 'host' ? 'Avsluta rummet för alla?' : 'Lämna rummet?')) leave();
  };
  window.addEventListener('beforeunload', (e) => {
    if (app.role === 'host' && app.game && app.game.players.size > 1) { e.preventDefault(); e.returnValue = ''; }
  });
  loadListings().then((l) => { if (!app.allListings.length) app.allListings = l; });
  renderHome();

  // Exponeras för felsökning
  window.__gbp = { app, net, scoreFor, nicePrice };
})();
