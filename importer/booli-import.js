// Gissa bostadspriset – Booli-importör.
// Körs i din egen webbläsare på en Booli-sida med slutpriser (t.ex. https://www.booli.se/sok/slutpriser?areaIds=1).
// Läser sökresultatet sida för sida, hämtar detaljer per bostad och laddar ner en JSON-fil som spelet kan läsa.
(() => {
  if (window.__gbpImporter) { window.__gbpImporter.show(); return; }

  const host = location.hostname.replace(/^www\./, '');
  if (host !== 'booli.se') {
    alert('Öppna en sökning med slutpriser på booli.se först (t.ex. booli.se/sok/slutpriser?areaIds=1).');
    return;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const found = new Map();
  let running = false;

  // ---------- UI ----------
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;z-index:2147483647;right:16px;bottom:16px;width:320px;max-width:calc(100vw - 32px);background:#fff;color:#1d1d1f;border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,.25);font:14px/1.4 system-ui,-apple-system,sans-serif;padding:16px';
  box.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
      <strong style="font-size:15px">🏠 Gissa bostadspriset – import</strong>
      <button data-x style="border:0;background:none;font-size:18px;cursor:pointer">×</button>
    </div>
    <label style="display:flex;justify-content:space-between;margin:6px 0">Antal sidor att läsa
      <input data-pages type="number" min="1" max="50" value="5" style="width:64px"></label>
    <label style="display:flex;justify-content:space-between;margin:6px 0">Minst antal bilder
      <input data-minimg type="number" min="1" max="20" value="4" style="width:64px"></label>
    <div data-status style="margin:10px 0;color:#555;min-height:40px">Gör en sökning på slutpriser och tryck på Starta.</div>
    <div style="display:flex;gap:8px">
      <button data-start style="flex:1;padding:8px;border:0;border-radius:8px;background:#0a7d4f;color:#fff;font-weight:600;cursor:pointer">Starta</button>
      <button data-dl disabled style="flex:1;padding:8px;border:0;border-radius:8px;background:#222;color:#fff;font-weight:600;cursor:pointer;opacity:.4">Ladda ner (0)</button>
    </div>`;
  document.body.appendChild(box);
  const $ = (s) => box.querySelector(s);
  const status = (t) => { $('[data-status]').textContent = t; };
  const updateDl = () => {
    const b = $('[data-dl]');
    b.textContent = `Ladda ner (${found.size})`;
    b.disabled = found.size === 0;
    b.style.opacity = found.size ? 1 : 0.4;
  };
  $('[data-x]').onclick = () => { box.style.display = 'none'; };
  window.__gbpImporter = { show: () => { box.style.display = 'block'; } };

  // ---------- Parsning ----------
  // Plockar ut en JSON-array/objekt som börjar vid index `start` genom att matcha hakparenteser.
  function sliceJson(text, start) {
    const open = text[start], close = open === '[' ? ']' : '}';
    let depth = 0, inStr = false;
    for (let j = start; j < text.length; j++) {
      const c = text[j];
      if (inStr) { if (c === '\\') { j++; continue; } if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === open) depth++;
      else if (c === close && --depth === 0) return text.slice(start, j + 1);
    }
    return null;
  }

  function parseSearchItems(html) {
    const at = html.indexOf('"__typename":"SearchSoldV2Result"');
    if (at < 0) return [];
    const i = html.indexOf('"items":[', at);
    if (i < 0) return [];
    const json = sliceJson(html, i + 8);
    try { return JSON.parse(json); } catch { return []; }
  }

  const num = (s) => {
    if (s == null) return null;
    const n = parseFloat(String(s).replace(/\s| /g, '').replace(',', '.'));
    return Number.isFinite(n) ? n : null;
  };

  function parseDetail(rawHtml) {
    const h = rawHtml.replace(/\\"/g, '"');
    const rawOf = (key) => {
      const m = h.match(new RegExp(`"${key}":\\{"__typename":"FormattedValue"[^}]*?"raw":(-?[\\d.]+)`));
      return m ? Number(m[1]) : null;
    };
    const info = (key) => {
      const m = h.match(new RegExp(`"key":"${key}","displayText":\\{"__typename":"DisplayText","markdown":"([^"]*)"`));
      if (!m) return null;
      const b = m[1].match(/\*\*([^*]+)\*\*/);
      return b ? b[1] : m[1];
    };
    const str = (key) => { const m = h.match(new RegExp(`"${key}":"([^"]*)"`)); return m ? m[1] : null; };
    const year = h.match(/"constructionYear":(\d{4})/);
    // Hela bildlistan för bostaden (sökresultatet innehåller bara de fem första).
    let images = [];
    const ii = h.indexOf('"images":[', h.indexOf('"soldPrice":{'));
    if (ii > 0) {
      try { images = JSON.parse(sliceJson(h, ii + 9)).map((x) => x.id); } catch { /* ignorera */ }
    }
    return {
      soldPrice: rawOf('soldPrice'),
      listPrice: rawOf('listPrice'),
      livingArea: rawOf('livingArea'),
      additionalArea: rawOf('additionalArea'),
      plotArea: rawOf('plotArea'),
      rooms: rawOf('rooms'),
      rent: num(info('rent')),
      operatingCost: num(info('operatingCost')),
      floor: info('floor'),
      daysActive: num(info('daysActive')),
      constructionYear: year ? Number(year[1]) : null,
      tenureForm: str('tenureForm'),
      streetAddress: str('streetAddress'),
      areaName: str('descriptiveAreaName'),
      removed: str('removed'),
      allImages: images,
    };
  }

  function fromSearchItem(it) {
    const dp = Object.fromEntries((it.displayAttributes?.dataPoints || []).map((d) => [d.key, d.value?.plainText]));
    const [, area, city] = (it.subtitle || '').split(' · ');
    return {
      id: `booli-${it.listingId}`,
      source: 'booli',
      url: `https://www.booli.se${it.url}`,
      objectType: it.objectType,
      streetAddress: it.title,
      areaName: area || null,
      municipality: it.tracking?.properties?.municipality || city || null,
      county: it.tracking?.properties?.county || null,
      soldDate: it.displayDate || null,
      soldPrice: num(it.displayPrice),
      livingArea: num(dp.livingArea),
      rooms: num(dp.rooms),
      plotArea: num(dp.plotArea),
      amenities: (it.amenities || []).map((a) => a.label),
      images: (it.images || []).map((x) => x.id),
      lat: it.position?.latitude ?? null,
      lng: it.position?.longitude ?? null,
    };
  }

  // Detaljsidan (/bostad/…) visar fastighetens alla bilder, även från tidigare eller senare annonser.
  // Bild-id ökar med tiden, så vi behåller bara bilder som laddades upp i samma veva som sökresultatets.
  function filterImages(all, list) {
    const nums = list.map(Number).filter(Number.isFinite);
    if (!nums.length) return list;
    const lo = Math.min(...nums) - 2000, hi = Math.max(...nums) + 50000;
    return [...new Set([...list, ...all.filter((id) => Number(id) >= lo && Number(id) <= hi)])].slice(0, 60);
  }

  // ---------- Körning ----------
  async function run() {
    if (running) return;
    running = true;
    $('[data-start]').disabled = true;
    const pages = Math.max(1, Math.min(50, Number($('[data-pages]').value) || 1));
    const minImg = Math.max(1, Number($('[data-minimg]').value) || 1);
    const base = new URL(location.href);
    if (!base.pathname.includes('slutpriser')) {
      status('Den här sidan är ingen slutpris-sökning. Gå till booli.se/sok/slutpriser och försök igen.');
      running = false; $('[data-start]').disabled = false; return;
    }
    const startPage = Number(base.searchParams.get('page')) || 1;
    try {
      for (let p = startPage; p < startPage + pages; p++) {
        base.searchParams.set('page', String(p));
        status(`Läser sida ${p - startPage + 1}/${pages}…`);
        const res = await fetch(base.toString(), { credentials: 'include' });
        if (!res.ok) { status(`Sidan svarade ${res.status}. Avbryter – det som hittats hittills går att ladda ner.`); break; }
        const items = parseSearchItems(await res.text()).filter((it) => it.saleType === 'sold' && (it.images?.length || 0) >= minImg);
        if (!items.length && p > startPage) { /* tom sida – fortsätt ändå, nästa kan ha bilder */ }
        for (const it of items) {
          const l = fromSearchItem(it);
          if (found.has(l.id)) continue;
          status(`Sida ${p - startPage + 1}/${pages}: hämtar ${l.streetAddress}…`);
          await sleep(400);
          try {
            const d = parseDetail(await (await fetch(l.url, { credentials: 'include' })).text());
            // Detaljsidan visar även liknande bostäder – lita bara på den om slutpriset stämmer med listan.
            if (!l.soldPrice || !d.soldPrice || d.soldPrice === l.soldPrice) {
              const { allImages, ...rest } = d;
              for (const [k, v] of Object.entries(rest)) {
                if (v == null) continue;
                if (l[k] == null) l[k] = v;
              }
              if (allImages.length) l.images = filterImages(allImages, l.images);
            }
          } catch { /* behåll det vi har från listan */ }
          if (!l.soldPrice || l.images.length < minImg) continue;
          found.set(l.id, l);
          updateDl();
        }
        await sleep(800);
      }
      status(`Klart! ${found.size} bostäder med minst ${minImg} bilder. Tryck på Ladda ner, eller byt sökning och kör igen för att lägga till fler.`);
    } catch (e) {
      status('Något gick fel: ' + e.message);
    }
    running = false;
    $('[data-start]').disabled = false;
  }

  function download() {
    const blob = new Blob([JSON.stringify({ version: 1, exported: new Date().toISOString(), listings: [...found.values()] }, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `bostader-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  $('[data-start]').onclick = run;
  $('[data-dl]').onclick = download;
  window.__gbpImporter.found = found;
  window.__gbpImporter.run = run;
})();
