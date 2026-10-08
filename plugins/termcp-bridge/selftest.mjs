/**
 * termcp-bridge self-test — no host, no network, no termcp binary.
 *
 * It drives the real activate() against a stub host and asserts the three things
 * that are easy to get wrong and invisible at runtime:
 *
 *  1. **The proxy is mounted and stays mounted.** The 6-field cron bug (see
 *     index.mjs) registered the timer first, threw at activate(), and the host
 *     rolled the proxy back — the plugin looked installed while /termcp/ 404ed.
 *     The regression is pinned here.
 *  2. **mcp.json is edited surgically.** Whatever the user had before is what
 *     they get back, byte for byte; a malformed file is never touched.
 *  3. **auto mode steps aside** when another config already provides termcp, so
 *     the same 31 tools do not show up twice under two naming schemes.
 *
 * Run: node selftest.mjs
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import plugin, { detectForeignWiring, SERVER_NAME } from "./index.mjs";

let bad = 0;
const ck = (name, ok, extra = "") => {
	if (ok) {
		console.log(`PASS ${name}`);
		return;
	}
	bad++;
	console.log(`FAIL ${name}${extra ? ` — ${extra}` : ""}`);
};

/**
 * A stub host. Records the registration surfaces the plugin touches so the test
 * can assert on them, and exposes setSettings() to fire the settings handler.
 *
 * `foreign` writes those files into a temp HOME so detectForeignWiring() sees
 * them — the plugin reads the real homedir(), so HOME is stubbed per test.
 */
function makeHost({ mcpJson, settings = {}, foreign = null } = {}) {
	const dataDir = mkdtempSync(join(tmpdir(), "tcb-"));
	const home = mkdtempSync(join(tmpdir(), "tcb-home-"));
	if (mcpJson !== undefined) writeFileSync(join(dataDir, "mcp.json"), mcpJson);
	if (foreign) {
		for (const [rel, body] of Object.entries(foreign)) {
			const p = join(home, rel);
			mkdirSync(dirname(p), { recursive: true });
			writeFileSync(p, body);
		}
	}
	const log = [];
	const proxies = [];
	const schedules = [];
	const handlers = new Set();
	let current = { port: 18765, prefix: "/termcp", ...settings };
	const host = {
		dataDir,
		home,
		dir: "/tmp",
		cwd: "/tmp",
		getSettings: () => current,
		onSettingsChanged: (h) => {
			handlers.add(h);
			return () => handlers.delete(h);
		},
		onMessage: (h) => {
			handlers.add(h);
			return () => handlers.delete(h);
		},
		registerProxy: (p, t) => {
			proxies.push([p, t]);
			return () => {
				const i = proxies.findIndex((x) => x[0] === p);
				if (i >= 0) proxies.splice(i, 1);
			};
		},
		schedule: () => () => {},
		log: (lvl, ...a) => log.push([lvl, a.join(" ")]),
		notify: (lvl, t) => log.push([`notify:${lvl}`, t]),
		broadcast: () => {},
		sendTo: () => {},
	};
	return {
		host,
		dataDir,
		home,
		log,
		proxies,
		schedules,
		// Fire settings handlers under the isolated home too: they run asynchronously
		// in the real host (well after activate), so a test that only isolates
		// activate would let auto mode read the developer's actual config here.
		setSettings: (s) => {
			current = s;
			withHome(home, () => {
				for (const h of handlers) h(s);
			});
		},
	};
}
const readMcp = (dir) => JSON.parse(readFileSync(join(dir, "mcp.json"), "utf8"));

/**
 * Point homedir() at a temp dir for the duration of fn.
 *
 * Required for every activate() call, not just the detection cases: auto mode
 * reads the real home directory, so on a machine that already wired termcp the
 * injection would be skipped everywhere and these tests would pass vacuously.
 */
function withHome(home, fn) {
	const prev = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
	process.env.HOME = home;
	process.env.USERPROFILE = home;
	try {
		return fn();
	} finally {
		for (const [k, v] of Object.entries(prev)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	}
}

/** activate() under an isolated home, so auto mode never sees the real config. */
function activate(t, home = t.home) {
	return withHome(home, () => plugin.activate(t.host));
}

// ── 1. fresh install ────────────────────────────────────────────────────────
{
	const t = makeHost();
	const off = activate(t);
	ck("1 proxy mounted at the default prefix", t.proxies.length === 1 && t.proxies[0][0] === "/termcp" && t.proxies[0][1].port === 18765, JSON.stringify(t.proxies));

	const cfg = readMcp(t.dataDir);
	const spec = cfg.servers[SERVER_NAME];
	ck("1 termcp entry written", spec?.command === "termcp", JSON.stringify(cfg));
	ck("1 entry uses `daemon stdio` (starts an instance on demand)", spec?.args?.[0] === "daemon" && spec?.args?.[1] === "stdio", JSON.stringify(spec?.args));
	ck("1 entry carries the idle timeout", spec?.args?.includes("--idle-timeout"), JSON.stringify(spec?.args));
	ck("1 entry carries the configured port", spec?.args?.includes("18765"), JSON.stringify(spec?.args));
	ck("1 empty backup marks 'no mcp.json before us'", existsIn(t.dataDir, "mcp.json.termcp-bridge.bak") && readFileSync(join(t.dataDir, "mcp.json.termcp-bridge.bak"), "utf8") === "");

	off();
	ck("1 proxy unregistered on deactivate", t.proxies.length === 0, JSON.stringify(t.proxies));
	const files = readdirSync(t.dataDir);
	ck("1 mcp.json removed again (we created it)", !files.includes("mcp.json") && files.some((f) => f.startsWith("mcp.json.termcp-bridge.removed-")), files.join(","));
}

// ── 2. an existing user config survives verbatim ────────────────────────────
{
	const existing = `${JSON.stringify({ servers: { other: { command: "other-mcp", args: ["--flag"] } } }, null, 2)}\n`;
	const t = makeHost({ mcpJson: existing });
	const off = activate(t);
	const during = readMcp(t.dataDir);
	ck("2 existing server kept", during.servers.other?.command === "other-mcp", JSON.stringify(during));
	ck("2 termcp entry added alongside", during.servers.termcp !== undefined);
	off();
	ck("2 restored byte for byte", readFileSync(join(t.dataDir, "mcp.json"), "utf8") === existing);
}

// ── 3. a malformed file is never touched ────────────────────────────────────
{
	const broken = "{ this is not json";
	const t = makeHost({ mcpJson: broken });
	let off;
	let threw = null;
	try {
		off = activate(t);
	} catch (e) {
		threw = e;
	}
	ck("3 activate does not throw", threw === null, String(threw));
	ck("3 file left alone", readFileSync(join(t.dataDir, "mcp.json"), "utf8") === broken);
	ck("3 user is warned", t.log.some(([l, m]) => l === "notify:warning" && m.includes("mcp.json")), JSON.stringify(t.log));
	ck("3 proxy still mounted despite the bad file", t.proxies.length === 1);
	off?.();
	ck("3 still untouched on deactivate", readFileSync(join(t.dataDir, "mcp.json"), "utf8") === broken);
}

// ── 4. auto mode steps aside when termcp is wired elsewhere ─────────────────
{
	const generic = JSON.stringify({ mcpServers: { termcp: { url: "http://localhost:18765/stream" } } }, null, 2);
	const t = makeHost({ foreign: { ".config/mcp/mcp.json": generic } });
	let off;
	withHome(t.home, () => {
		off = activate(t);
	});
	ck("4 no mcp.json written", !existsIn(t.dataDir, "mcp.json"), readdirSync(t.dataDir).join(","));
	ck("4 proxy still mounted (view works regardless)", t.proxies.length === 1);
	ck("4 the reason is logged with the path", t.log.some(([l, m]) => l === "info" && m.includes("already wired") && m.includes(".config/mcp/mcp.json")), JSON.stringify(t.log.filter(([l]) => l === "info")));
	off();
}

// ── 5. `always` overrides the detection ─────────────────────────────────────
{
	const generic = JSON.stringify({ mcpServers: { termcp: { url: "http://localhost:18765/stream" } } });
	const t = makeHost({ settings: { mcpMode: "always" }, foreign: { ".config/mcp/mcp.json": generic } });
	let off;
	withHome(t.home, () => {
		off = activate(t);
	});
	ck("5 entry written anyway", readMcp(t.dataDir).servers.termcp !== undefined, JSON.stringify(readdirSync(t.dataDir)));
	off();
}

// ── 6. `never` leaves mcp.json alone ────────────────────────────────────────
{
	const t = makeHost({ settings: { mcpMode: "never" } });
	const off = activate(t);
	ck("6 no mcp.json", !existsIn(t.dataDir, "mcp.json"));
	ck("6 no backup either", !existsIn(t.dataDir, "mcp.json.termcp-bridge.bak"), readdirSync(t.dataDir).join(","));
	ck("6 proxy still mounted", t.proxies.length === 1);
	off();
}

// ── 7. changing settings remounts the proxy at the new place ────────────────
{
	const t = makeHost();
	const off = activate(t);
	t.setSettings({ port: 19999, prefix: "/tc2" });
	ck("7 new prefix mounted with the new port", t.proxies.some(([p, tg]) => p === "/tc2" && tg.port === 19999), JSON.stringify(t.proxies));
	ck("7 old prefix released", !t.proxies.some(([p]) => p === "/termcp"), JSON.stringify(t.proxies));
	const spec = readMcp(t.dataDir).servers.termcp;
	ck("7 mcp entry follows the port", spec.args.includes("19999"), JSON.stringify(spec.args));
	off();
}

// ── 8. a failing timer must not take the proxy down (the cron-shape bug) ────
{
	const t = makeHost();
	t.host.schedule = () => {
		throw new Error("schedule: unsupported cron shape");
	};
	let off;
	let threw = null;
	try {
		off = activate(t);
	} catch (e) {
		threw = e;
	}
	ck("8 activate does not throw", threw === null, String(threw));
	ck("8 proxy survives a failing timer", t.proxies.length === 1, JSON.stringify(t.proxies));
	ck("8 the failure is logged, not swallowed silently", t.log.some(([l, m]) => l === "warn" && m.includes("status polling")), JSON.stringify(t.log));
	off?.();
}

// ── 9. a user entry added while we are active survives deactivate ───────────
{
	const t = makeHost();
	const off = activate(t);
	const cfg = readMcp(t.dataDir);
	cfg.servers.addedLater = { command: "late-mcp", args: [] };
	writeFileSync(join(t.dataDir, "mcp.json"), JSON.stringify(cfg, null, 2));
	off();
	const after = readMcp(t.dataDir);
	ck("9 late addition kept", after.servers.addedLater?.command === "late-mcp", JSON.stringify(after));
	ck("9 our key removed", after.servers.termcp === undefined, JSON.stringify(after));
}

// ── 11. auto mode withdraws the plugin's OWN entry when it steps aside ──────
{
	// Start in `always` so the entry gets written...
	const t = makeHost({ settings: { mcpMode: "always" } });
	const off = activate(t);
	ck("11 always writes the entry", readMcp(t.dataDir).servers.termcp !== undefined);

	// ...then wire termcp globally and switch to auto: the plugin's entry is now
	// the duplicate, so it must go.
	mkdirSync(join(t.home, ".config/mcp"), { recursive: true });
	writeFileSync(
		join(t.home, ".config/mcp/mcp.json"),
		JSON.stringify({ mcpServers: { termcp: { url: "http://localhost:18765/stream" } } }),
	);
	t.setSettings({ mcpMode: "auto" });
	ck("11 our entry withdrawn", !existsIn(t.dataDir, "mcp.json"), readdirSync(t.dataDir).join(","));
	ck("11 proxy still mounted", t.proxies.length === 1);
	off();
}

// ── 12. a hand-edited entry is NOT withdrawn ────────────────────────────────
{
	const t = makeHost({ settings: { mcpMode: "always" } });
	const off = activate(t);
	// The user edits the entry (different args = not ours any more).
	const cfg = readMcp(t.dataDir);
	cfg.servers.termcp = { command: "my-own-termcp-wrapper", args: ["--custom"] };
	writeFileSync(join(t.dataDir, "mcp.json"), JSON.stringify(cfg, null, 2));
	mkdirSync(join(t.home, ".config/mcp"), { recursive: true });
	writeFileSync(
		join(t.home, ".config/mcp/mcp.json"),
		JSON.stringify({ mcpServers: { termcp: { url: "http://localhost:18765/stream" } } }),
	);
	t.setSettings({ mcpMode: "auto" });
	const after = readMcp(t.dataDir);
	ck("12 hand-edited entry survives", after.servers.termcp?.command === "my-own-termcp-wrapper", JSON.stringify(after));
	off();
	ck("12 and survives deactivate too", readMcp(t.dataDir).servers.termcp?.command === "my-own-termcp-wrapper");
}

// ── 10. detectForeignWiring unit checks ─────────────────────────────────────
{
	const home = mkdtempSync(join(tmpdir(), "tcb-detect-"));
	ck("10 nothing found in an empty home", detectForeignWiring([join(home, ".pi/agent/mcp.json")]) === null);

	writeFileSync(join(home, "servers.json"), JSON.stringify({ servers: { termcp: { command: "termcp" } } }));
	ck("10 finds the pi-web-ui shape", detectForeignWiring([join(home, "servers.json")]) === join(home, "servers.json"));

	writeFileSync(join(home, "mcpServers.json"), JSON.stringify({ mcpServers: { termcp: { url: "http://x" } } }));
	ck("10 finds the generic shape", detectForeignWiring([join(home, "mcpServers.json")]) === join(home, "mcpServers.json"));

	writeFileSync(join(home, "other.json"), JSON.stringify({ mcpServers: { somethingelse: {} } }));
	ck("10 ignores unrelated servers", detectForeignWiring([join(home, "other.json")]) === null);

	writeFileSync(join(home, "broken.json"), "{ nope");
	ck("10 ignores a malformed file instead of throwing", detectForeignWiring([join(home, "broken.json")]) === null);
}

console.log(bad === 0 ? "\nall passed" : `\n${bad} failure(s)`);
process.exit(bad === 0 ? 0 : 1);

function existsIn(dir, name) {
	return readdirSync(dir).includes(name);
}
