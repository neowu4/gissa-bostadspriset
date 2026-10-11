# 🏠 Gissa bostadspriset

Ett partyspel där man gissar slutpriset på riktiga sålda bostäder från Booli. Spela själv eller med kompisar: en person skapar ett rum, de andra går med från sina mobiler med en rumskod eller QR-kod.

Spelet är helt statiskt och körs på GitHub Pages. Spelarna kopplas ihop direkt med varandra (WebRTC via [PeerJS](https://peerjs.com)), så ingen egen server behövs.

## Spela

1. Öppna sidan och tryck på **Skapa rum**.
2. Visa rumskoden eller QR-koden för de andra. De öppnar sidan och skriver in koden.
3. Välj inställningar (antal bostäder, tid, bostadstyp, område) och starta.
4. Alla gissar på sin egen enhet. Upp till 1000 poäng per bostad, och +200 till den som kom närmast.

Värdens webbläsare styr spelet, så låt den fliken vara öppen.

## Poäng

`poäng = 1000 × (1 − |ln(gissning / slutpris)| / ln 1,75)`, men aldrig under 0. Exakt rätt ger 1000 p, 10 % fel ger cirka 830 p och 50 % för högt ger cirka 275 p. Gissar man en faktor 1,75 fel eller mer får man 0 p.

## Fler bostäder

Booli och Hemnet blockerar automatiska skript (Cloudflare), så importen körs i din egen webbläsare medan du är inne på Booli. Se `importera.html` på sidan:

1. Dra bokmärket **🏠 Importera till Gissa bostadspriset** till bokmärkesfältet.
2. Gör en slutprissökning på booli.se och klicka på bokmärket. Välj antal sidor och tryck på **Starta**, sedan **Ladda ner**.
3. Antingen laddar värden in filen direkt i lobbyn (*ladda egen fil*), eller så slår du ihop den med spelets lista:

```bash
node scripts/merge.mjs ~/Downloads/bostader-*.json
git add data/listings.json && git commit -m "Fler bostäder" && git push
```

## Köra lokalt

```bash
python3 -m http.server 5190
```

Öppna sedan http://localhost:5190.

## Filer

| Fil | Innehåll |
| --- | --- |
| `index.html`, `js/app.js`, `css/style.css` | Själva spelet |
| `data/listings.json` | Bostäderna spelet väljer bland |
| `importer/booli-import.js` | Importverktyget som körs på booli.se |
| `importera.html` | Instruktioner och bokmärke för importen |
| `scripts/merge.mjs` | Slår ihop exporter med `data/listings.json` |

Data och bilder tillhör Booli och respektive mäklare. Bilderna länkas direkt från Boolis CDN och lagras inte i repot.
