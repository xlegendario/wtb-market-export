import express from 'express';
import cron from 'node-cron';
import { config, assertConfig } from './src/config.js';
import { listProfiles } from './src/profiles.js';
import { runProfile } from './src/sync.js';
import { WtbClient, parseList } from './src/wtbClient.js';

assertConfig();

const app = express();
app.use(express.json());

const runHistory = [];
let running = null;

function remember(summary) {
  runHistory.unshift(summary);
  if (runHistory.length > 25) runHistory.pop();
}

function authorized(req) {
  if (!config.runSecret) return true;
  const provided = req.get('x-run-secret') || req.query.secret;
  return provided === config.runSecret;
}

function bool(value, fallback) {
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

/** Zorgt dat er nooit twee runs tegelijk lopen (dubbele pushes voorkomen). */
async function guardedRun(profileName, options) {
  if (running) {
    throw Object.assign(new Error(`Run voor "${running}" is nog bezig.`), { status: 409 });
  }
  running = profileName;
  try {
    const summary = await runProfile(profileName, options);
    remember(summary);
    return summary;
  } finally {
    running = null;
  }
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, running, profiles: listProfiles().length });
});

app.get('/profiles', (_req, res) => {
  res.json({ profiles: listProfiles() });
});

app.get('/runs', (req, res) => {
  if (!authorized(req)) return res.status(401).json({ error: 'unauthorized' });
  res.json({ runs: runHistory });
});

// Handig om één keer te draaien en te zien hoe de /get response er echt uitziet.
app.get('/list', async (req, res) => {
  if (!authorized(req)) return res.status(401).json({ error: 'unauthorized' });
  try {
    const client = new WtbClient(config.wtb);
    const result = await client.getList();
    const parsed = parseList(result.json ?? result.raw);
    res.json({
      raw: result.json ?? result.raw,
      recognized: parsed.recognized,
      pairs: [...parsed.pairs],
      skus: [...parsed.skus],
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.all('/run', async (req, res) => {
  if (!authorized(req)) return res.status(401).json({ error: 'unauthorized' });

  const profileName = req.query.profile || req.body?.profile;
  if (!profileName) return res.status(400).json({ error: 'profile ontbreekt' });

  try {
    const summary = await guardedRun(profileName, {
      dryRun: bool(req.query.dryRun ?? req.body?.dryRun, config.dryRunDefault),
      prune: bool(req.query.prune ?? req.body?.prune, undefined),
      maxItems: req.query.maxItems ? Number(req.query.maxItems) : null,
    });
    res.json(summary);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

/**
 * WTB_SCHEDULE = "0 12 * * 1|fresh-24h; 0 12 * * 3|aging-72h"
 * Zo kun je per dag een ander profiel laten draaien zonder code te wijzigen.
 */
function installSchedule() {
  const entries = config.schedule
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);

  for (const entry of entries) {
    const [expr, profileName] = entry.split('|').map((s) => s.trim());
    if (!expr || !profileName) {
      console.error(`⚠️  Ongeldige WTB_SCHEDULE entry: "${entry}"`);
      continue;
    }
    if (!cron.validate(expr)) {
      console.error(`⚠️  Ongeldige cron-expressie: "${expr}"`);
      continue;
    }

    cron.schedule(
      expr,
      async () => {
        console.log(`⏰ Cron start profiel "${profileName}"`);
        try {
          const summary = await guardedRun(profileName, {});
          console.log(
            `✅ ${profileName}: ${summary.added.length} toegevoegd, ` +
              `${summary.removed.length} verwijderd, ${summary.skipped.length} overgeslagen`
          );
        } catch (err) {
          console.error(`❌ Cron ${profileName} faalde: ${err.message}`);
        }
      },
      { timezone: config.timezone }
    );

    console.log(`⏰ Ingepland: "${expr}" (${config.timezone}) -> ${profileName}`);
  }
}

installSchedule();

app.listen(config.port, () => {
  console.log(`🚀 wtb-market-export luistert op :${config.port}`);
});
