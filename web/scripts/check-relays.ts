// Tests every relay in public/relays.json (in use + candidates) and, with --write, updates the file when one in use
// fails: run weekly by .github/workflows/relays.yml, which turns a change into a pull request.
//   node scripts/check-relays.ts [--write] [--attempts 3] [--gap 20]   (gap: minutes between attempts)
// A relay passes if, in any attempt, it (1) accepts a kind-30078 message from a brand-new key, (2) gives it back when
// asked by its tag, and (3) still serves a kind-30078 message more than 180 days old (it keeps things).
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { Relay } from 'nostr-tools/relay';
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure';
import { parseRelayList, planRelayList, type Probe } from '../src/lib/relaylist.ts';

const args = process.argv.slice(2);
const opt = (name: string, dflt: number) => (args.includes(name) ? Number(args[args.indexOf(name) + 1]) : dflt);
const WRITE = args.includes('--write');
const ATTEMPTS = opt('--attempts', 1);
const GAP_MIN = opt('--gap', 0);
const ABOUT = "Relays Worldline uses for scheduling links. Checked weekly by .github/workflows/relays.yml, which opens a pull request when one stops working. Only relay addresses here — never anyone's data.";
const FILE = new URL('../public/relays.json', import.meta.url);

const timeout = <T,>(p: Promise<T>, ms: number, what: string) =>
  Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${what}: timed out`)), ms))]);
const hex = (n: number) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, '0')).join('');

async function probe(url: string): Promise<Probe> {
  const t0 = Date.now();
  let relay: Relay | undefined;
  try {
    relay = await timeout(Relay.connect(url), 8000, 'connect');
    const d = hex(16);
    const now = Math.floor(Date.now() / 1000);
    const ev = finalizeEvent({ kind: 30078, created_at: now, tags: [['d', d]], content: hex(64) }, generateSecretKey());
    await timeout(relay.publish(ev), 8000, 'publish');
    const query = (filter: object) =>
      timeout(new Promise<number>((res) => {
        let n = 0;
        const sub = relay!.subscribe([filter as never], { onevent: () => n++, oneose: () => { sub.close(); res(n); } });
      }), 8000, 'read');
    if (!(await query({ kinds: [30078], '#d': [d] }))) return { ok: false, ms: Date.now() - t0, why: 'took the message but did not give it back' };
    if (!(await query({ kinds: [30078], until: now - 180 * 86400, limit: 1 }))) return { ok: false, ms: Date.now() - t0, why: 'keeps nothing older than 180 days' };
    return { ok: true, ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, why: String((e as Error).message ?? e).slice(0, 80) };
  } finally {
    try { relay?.close(); } catch { /* already closed */ }
  }
}

const list = parseRelayList(JSON.parse(readFileSync(FILE, 'utf8')));
if (!list) throw new Error('public/relays.json is not a valid relay list');
const all = [...new Set([...list.relays, ...list.candidates])];
const results: Record<string, Probe> = {};
for (let a = 1; a <= ATTEMPTS; a++) {
  if (a > 1 && list.relays.every((u) => results[u]?.ok)) break; // only worth waiting and retrying if one in use failed
  const todo = all.filter((u) => !results[u]?.ok);
  if (!todo.length) break;
  if (a > 1) await new Promise((r) => setTimeout(r, GAP_MIN * 60_000));
  const got = await Promise.all(todo.map(probe));
  todo.forEach((u, i) => (results[u] = got[i]));
}

const today = new Date().toISOString().slice(0, 10);
const plan = planRelayList(list, results, today);
const row = (u: string) => `| ${list.relays.includes(u) ? 'in use' : 'candidate'} | \`${u}\` | ${results[u].ok ? `✅ ${results[u].ms} ms` : `❌ ${results[u].why}`} |`;
const summary = [
  `### Relay check ${today}`,
  '',
  '| | Relay | Result |',
  '|---|---|---|',
  ...all.map(row),
  '',
  plan.removed.length || plan.added.length ? `**Change:** remove ${plan.removed.map((u) => `\`${u}\``).join(', ') || 'none'}; add ${plan.added.map((u) => `\`${u}\``).join(', ') || 'none'}.` : '**No change needed.**',
  ...(plan.trouble ? ['', `⚠️ ${plan.trouble}`] : []),
].join('\n');
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + '\n');
const changed = plan.list !== list;
if (WRITE && changed) writeFileSync(FILE, JSON.stringify({ about: ABOUT, ...plan.list }, null, 2) + '\n');
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changed}\ntrouble=${plan.trouble ?? ''}\n`);
  writeFileSync('relay-report.md', summary + '\n');
}
process.exit(0);
