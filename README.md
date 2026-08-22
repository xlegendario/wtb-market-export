# wtb-market-export

Zet open **Outsource**-orders uit Airtable (`Unfulfilled Orders Log`) op je
**WTB Market** store list via de Users API.

## Hoe het werkt

Een run draait altijd één *profiel* (= één Airtable-filterformule):

1. Haal alle records op die aan de filterformule voldoen.
2. Zet ze om naar unieke `{sku, size}`-paren (WTB Market werkt per maat, niet per order).
3. Haal de huidige lijst op via `GET /user/list/manage/get`.
4. **Diff**: alleen wat er nog niet op staat wordt toegevoegd.
5. Optioneel *prunen*: maten die niet meer gewenst zijn worden verwijderd.

Doordat we eerst de huidige lijst ophalen, is een run idempotent — twee keer
draaien doet de tweede keer niets.

## Profielen

| Profiel      | Filter |
|--------------|--------|
| `all-open`   | Alle open Outsource-orders |
| `ready`      | `Ready for Outsource = 1` (client-delay verstreken) |
| `fresh-24h`  | Order Date binnen 24 uur |
| `aging-72h`  | 72+ uur in outsource |
| `high-value` | Inkoopprijs >= `WTB_HIGH_VALUE_MIN` |

Alle profielen filteren sowieso op `Fulfillment Status = "Outsource"`,
`Outsourced? = 0` en een gevulde SKU + Size. Nieuwe profielen: één entry
bijzetten in `src/profiles.js`.

## Draaien

```bash
npm install
cp .env.example .env
node scripts/run-profile.js ready --dry-run
npm start
```

## Endpoints

Alles behalve `/health` en `/profiles` vereist `x-run-secret: <RUN_SECRET>`
(of `?secret=`).

| Endpoint | Doel |
|----------|------|
| `GET /health` | status |
| `GET /profiles` | profielen + hun formules |
| `GET /list` | ruwe + geparste WTB Market lijst |
| `GET/POST /run?profile=ready` | run starten (`&dryRun=true`, `&prune=true`, `&maxItems=n`) |
| `GET /runs` | laatste 25 run-samenvattingen |

## Draaien op Render

Deze service is een **batch job**, geen listener: hij wordt wakker, doet ~1 minuut
werk en stopt. Draai hem daarom als **Cron Job**, niet als web service.

[`render.yaml`](render.yaml) staat klaar. Secrets (`AIRTABLE_TOKEN`,
`AIRTABLE_BASE_ID`, `WTB_API_KEY`, `WTB_USER_ID`) vul je in het Render dashboard in.

Elke dag een andere filter, binnen dezelfde cron job:

```
WTB_DAILY_PROFILES=mon=fresh-24h, wed=aging-72h, fri=all-open, default=ready
```

`node scripts/run-profile.js --today` kijkt welke dag het is (in `TZ`, niet in
Render's UTC) en draait het bijbehorende profiel. Geen entry voor vandaag en geen
`default`? Dan exit hij netjes met code 0 zonder iets te doen.

Render's cron schedules staan in **UTC**: `0 10 * * *` is 12:00 in Amsterdam
tijdens zomertijd, 11:00 in wintertijd.

### Alternatief: als long-running service

Wil je hem toch always-on draaien (bv. om `/run` handmatig te kunnen triggeren),
gebruik dan `npm start` met een ingebouwde cron:

```
WTB_SCHEDULE=0 12 * * 1|fresh-24h; 0 12 * * 3|aging-72h
```

Let op: op Render's free tier valt een web service na 15 minuten inactiviteit in
slaap en vuurt de ingebouwde cron niet. Voor een dagelijkse run is de Cron Job
de juiste vorm.

## Let op

- **Prunen staat standaard uit.** Zet een profiel pas in `WTB_PRUNE_PROFILES`
  als je zeker weet dat de WTB Market lijst volledig door deze service beheerd
  wordt — anders verdwijnen handmatig toegevoegde items.
- De API kent **geen prijzen**; de lijst is puur SKU + maat.
- `POST /user/list/manage/delete` verwijdert een **hele SKU**. Voor losse maten
  gebruikt de sync `/add` met `method: "delete"`.
- De docs bevatten geen voorbeeld-response voor `/get`. De parser herkent
  meerdere vormen; herkent hij niets, dan draait de sync add-only en pruned niet.
  Draai `GET /list` één keer en scherp `parseList()` daarop aan.

## SKU en maat

Het formulaveld `SKU` en het tekstveld `Size` in `Unfulfilled Orders Log` zijn
al correct, dus die gaan **letterlijk** (alleen getrimd) naar WTB Market —
er wordt niets omgerekend of gegokt.

`WTB_SIZE_MODE` is een noodklep voor het geval WTB Market breuknotatie
(`41 1/3`) niet accepteert:

| Mode | `41 1/3` | `42 2/3` |
|------|----------|----------|
| `raw` (default) | `41 1/3` | `42 2/3` |
| `eu` | `41` | `42.5` |
| `dewu` | `41.5` | `42.5` (exact als Airtable's `Dewu Size Normalized`) |

Het diffen tegen de bestaande lijst is hoofdletter-ongevoelig op de SKU, zodat
een casing-verschil in hun response geen dubbele push oplevert.
