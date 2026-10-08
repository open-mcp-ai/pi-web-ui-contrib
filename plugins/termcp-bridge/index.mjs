/**
 * termcp-bridge — bring termcp into pi-web-ui.
 *
 * Three jobs, all idempotent, all reversible:
 *
 *  1. **Reverse proxy.** Mount `/termcp` onto the termcp HTTP port. The host's
 *     registerProxy forwards both HTTP and WebSocket upgrades, which is what the
 *     embedded UI needs (its terminal I/O rides a WebSocket). termcp v0.2.7+
 *     resolves every page URL against the mount prefix, so it needs no config.
 *
 *  2. **Make sure an instance exists.** `termcp daemon stdio` is a bridge that
 *     first ensures an instance is listening, then relays MCP over stdio: it
 *     starts one when none is running, adopts one that already is, and (started
 *     this way) lets it exit after an idle timeout. That single command is the
 *     whole "termcp starts itself" story, so it is what the MCP entry runs.
 *
 *  3. **AI tools, without double-wiring.** The host has no MCP API for plugins;
 *     its own MCP bridge (fed from <dataDir>/mcp.json, hot-reloaded) is the
 *     supported path, so the plugin writes a server entry there. The catch:
 *     users who already wired termcp through a global pi MCP config would end up
 *     with two sets of the same 31 tools, because the host bridge registers them
 *     under bare names (`file_write`) while the pi adapter namespaces them
 *     (`mcp__termcp__file_write`). `auto` mode detects that and steps aside;
 *     see detectForeignWiring().
 *
 * Deliberately NOT managed here: stopping termcp. The plugin can create an
 * instance and will hand it an idle countdown, but killing a service that owns
 * SSH credentials and its own web UI is the user's call (`termcp daemon stop`).
 */
import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Server entry name in <dataDir>/mcp.json. Also the key we restore around. */
const SERVER_NAME = "termcp";
/** Backup of mcp.json, taken once before the first write. */
const BACKUP = "mcp.json.termcp-bridge.bak";
/** How long a plugin-started instance may sit idle before exiting on its own. */
const IDLE_TIMEOUT = "10m";

/**
 * MCP config files a user may have already wired termcp through. Checked in
 * `auto` mode so the plugin does not double-register the same server.
 *
 * The first two are generic pi agent configs, the third is what the pi-mcp-adapter
 * extension reads. All are read-only here — the plugin only ever writes the
 * host's own <dataDir>/mcp.json.
 */
function foreignMcpConfigPaths() {
	const home = homedir();
	return [
		join(home, ".pi", "agent", "mcp.json"),
		join(home, ".config", "mcp", "mcp.json"),
		join(home, ".agents", "mcp.json"),
	];
}

/**
 * Whether some other config already points at termcp. Read-only, best-effort:
 * a missing or malformed file simply means "not wired here".
 *
 * Matches on the server NAME (`termcp`) rather than on the command, because the
 * name is what the user sees and what collides. A foreign entry pointing at a
 * different port still counts: the intent to have termcp tools is what matters,
 * and registering a second copy would only add duplicate tools.
 */
function detectForeignWiring(paths = foreignMcpConfigPaths()) {
	for (const p of paths) {
		try {
			if (!existsSync(p)) continue;
			const raw = readFileSync(p, "utf8");
			if (!raw.trim()) continue;
			const data = JSON.parse(raw);
			// Two shapes in the wild: {"servers":{...}} (pi-web-ui's own) and
			// {"mcpServers":{...}} (Claude/generic). Accept both.
			const servers = data?.servers ?? data?.mcpServers ?? {};
			if (servers && typeof servers === "object" && SERVER_NAME in servers) return p;
		} catch {
			/* unreadable or malformed = not our business */
		}
	}
	return null;
}

export default {
	activate(host) {
		const settings = () => host.getSettings() ?? {};
		const port = () => {
			const n = Number(settings().port);
			return Number.isFinite(n) && n > 0 && n < 65536 ? Math.floor(n) : 18765;
		};
		const prefix = () => {
			const p = String(settings().prefix ?? "/termcp").trim() || "/termcp";
			return p.startsWith("/") ? p.replace(/\/+$/, "") : `/${p}`;
		};
		const bin = () => String(settings().termcpBin ?? "").trim() || "termcp";
		const mcpMode = () => {
			const m = String(settings().mcpMode ?? "auto");
			return m === "always" || m === "never" ? m : "auto";
		};
		const mcpPath = () => join(host.dataDir, "mcp.json");

		// ── 1. reverse proxy ───────────────────────────────────────────────────
		let proxyOff = null;
		const mountProxy = () => {
			try {
				proxyOff?.();
			} catch {
				/* the previous registration is already gone */
			}
			proxyOff = host.registerProxy(prefix(), { port: port() });
			host.log("info", `proxy ${prefix()} → 127.0.0.1:${port()}`);
		};

		// ── 2. the termcp entry in mcp.json ────────────────────────────────────
		/** Read the existing config. Returns null for malformed JSON — never overwrite that. */
		const readConfig = () => {
			const p = mcpPath();
			if (!existsSync(p)) return { file: p, data: { servers: {} }, existed: false };
			try {
				const raw = readFileSync(p, "utf8");
				if (!raw.trim()) return { file: p, data: { servers: {} }, existed: true };
				const data = JSON.parse(raw);
				if (!data || typeof data !== "object" || Array.isArray(data)) return null;
				if (!data.servers || typeof data.servers !== "object" || Array.isArray(data.servers)) data.servers = {};
				return { file: p, data, existed: true };
			} catch {
				return null;
			}
		};
		const writeConfig = (data) => writeFileSync(mcpPath(), `${JSON.stringify(data, null, "\t")}\n`, "utf8");

		/**
		 * The command the host bridge will spawn. `daemon stdio` is what makes the
		 * instance appear on demand; `stdio` alone would only bridge to one that is
		 * already listening and fail otherwise.
		 *
		 * --idle-timeout only applies to an instance this command launches itself,
		 * so an instance the user started by hand keeps running — the countdown
		 * cannot be used to stop something we did not start.
		 */
		const termcpSpec = () => ({
			command: bin(),
			args: ["daemon", "stdio", "--port", String(port()), "--idle-timeout", IDLE_TIMEOUT],
		});

		/** outcome: "injected" | "kept" | "skipped" | "disabled" | "failed" — surfaced in status(). */
		let mcpOutcome = "none";
		let mcpNote = "";
		let injected = false;

		/**
		 * Drop the termcp entry if — and only if — it is the one this plugin writes.
		 * Used when auto mode decides to step aside: the entry may have been left by
		 * an earlier state of the settings, and leaving it would defeat the decision.
		 *
		 * The `injected` flag is not enough on its own: it is per-activation, while the
		 * file survives restarts. So the comparison is against the current spec, and a
		 * user who edited the entry keeps it.
		 */
		const entryIsOurs = () => {
			const conf = readConfig();
			const cur = conf?.data?.servers?.[SERVER_NAME];
			if (!cur) return false;
			if (JSON.stringify(cur) === JSON.stringify(termcpSpec())) return true;
			// Tolerate a stale port or idle timeout (the user may have moved the port):
			// the shape still identifies the command this plugin installs.
			return Array.isArray(cur.args) && cur.args[0] === "daemon" && cur.args[1] === "stdio" && cur.command === bin();
		};

		const removeOurEntry = () => {
			try {
				const conf = readConfig();
				if (!conf) return;
				if (!conf.data.servers?.[SERVER_NAME]) return;
				if (!entryIsOurs()) {
					host.log("info", "an mcp.json termcp entry exists but was not written by this plugin — leaving it alone");
					return;
				}
				delete conf.data.servers[SERVER_NAME];
				if (Object.keys(conf.data.servers).length === 0) {
					renameSync(mcpPath(), join(host.dataDir, `mcp.json.termcp-bridge.removed-${Date.now()}`));
				} else {
					writeConfig(conf.data);
				}
				injected = false;
				host.log("info", "withdrew the plugin's own termcp entry (another config provides its tools)");
			} catch (err) {
				host.log("warn", "could not withdraw the termcp entry:", err?.message ?? err);
			}
		};

		const injectMcp = () => {
			if (mcpMode() === "never") {
				mcpOutcome = "disabled";
				mcpNote = "";
				host.log("info", "mcpMode=never — AI tools are handled elsewhere; view only");
				return;
			}
			if (mcpMode() === "auto") {
				const foreign = detectForeignWiring();
				if (foreign) {
					// Someone else already provides termcp tools. Registering a second
					// copy would duplicate 31 tool schemas under different names, so step
					// aside and say where the existing wiring lives.
					//
					// Also withdraw our own entry if an earlier run (or an earlier
					// `always`) wrote one: after this decision it is the duplicate.
					// Only when it still matches our spec — a hand-edited entry is the
					// user talking and is left alone.
					removeOurEntry();
					mcpOutcome = "skipped";
					mcpNote = foreign;
					host.log("info", `termcp is already wired for the agent by ${foreign} — skipping the host MCP entry to avoid duplicate tools`);
					return;
				}
			}
			const conf = readConfig();
			if (!conf) {
				mcpOutcome = "failed";
				host.notify("warning", "mcp.json 不是合法 JSON，已跳过 termcp 接入（文件未被改动）");
				return;
			}
			const spec = termcpSpec();
			const cur = conf.data.servers[SERVER_NAME];
			if (cur && JSON.stringify(cur) === JSON.stringify(spec)) {
				injected = true;
				mcpOutcome = "kept";
				mcpNote = "";
				host.log("info", "mcp.json already has the termcp entry, unchanged");
				return;
			}
			// Back up once, before the first write, and never refresh it: restore
			// always puts back the file as it was before the plugin touched it.
			const backup = join(host.dataDir, BACKUP);
			if (!existsSync(backup)) {
				try {
					writeFileSync(backup, conf.existed ? readFileSync(conf.file) : "");
				} catch (err) {
					host.log("warn", "could not back up mcp.json:", err?.message ?? err);
				}
			}
			conf.data.servers[SERVER_NAME] = spec;
			try {
				writeConfig(conf.data);
				injected = true;
				mcpOutcome = "injected";
				mcpNote = "";
				host.log("info", "wrote the termcp entry to mcp.json (the host hot-reloads it)");
			} catch (err) {
				mcpOutcome = "failed";
				host.notify("error", `写入 mcp.json 失败：${err?.message ?? err}`);
			}
		};

		/**
		 * Undo exactly our edit.
		 *
		 * A backup is the authority: empty means the file did not exist before us
		 * (remove it, keeping a .removed copy in case we are wrong), anything else
		 * is restored verbatim. Deleting the termcp key first means servers the
		 * user added while the plugin was active survive either way.
		 */
		const restoreMcp = () => {
			const backup = join(host.dataDir, BACKUP);
			try {
				if (!injected) return; // nothing of ours went in
				// If the entry is no longer ours (the user edited it), it is theirs now:
				// undoing our edit would delete theirs. Same rule as removeOurEntry.
				if (!entryIsOurs()) {
					host.log("info", "the mcp.json termcp entry was changed by hand — leaving it on deactivate");
					return;
				}
				if (existsSync(backup)) {
					const saved = readFileSync(backup, "utf8");
					if (saved.trim()) {
						writeFileSync(mcpPath(), saved, "utf8");
						return;
					}
					const conf = readConfig();
					if (!conf) return; // malformed now; leave it alone
					delete conf.data.servers[SERVER_NAME];
					if (Object.keys(conf.data.servers).length === 0) {
						renameSync(mcpPath(), join(host.dataDir, `mcp.json.termcp-bridge.removed-${Date.now()}`));
					} else {
						writeConfig(conf.data);
					}
					return;
				}
				// No backup on disk (should not happen): fall back to removing the key.
				const conf = readConfig();
				if (!conf || !(SERVER_NAME in conf.data.servers)) return;
				delete conf.data.servers[SERVER_NAME];
				writeConfig(conf.data);
			} catch (err) {
				host.log("warn", "could not restore mcp.json:", err?.message ?? err);
			}
		};

		// ── 3. reachability (report the truth, never fake "online") ────────────
		const probe = async () => {
			try {
				const ac = new AbortController();
				const t = setTimeout(() => ac.abort(), 1500);
				const res = await fetch(`http://127.0.0.1:${port()}/api/version`, { signal: ac.signal });
				clearTimeout(t);
				if (!res.ok) return { reachable: false, error: `HTTP ${res.status}` };
				const j = await res.json().catch(() => ({}));
				return { reachable: true, version: typeof j?.version === "string" ? j.version : "" };
			} catch (err) {
				return { reachable: false, error: String(err?.message ?? err) };
			}
		};

		const status = async () => {
			const p = await probe();
			return {
				type: "status",
				payload: {
					port: port(),
					prefix: prefix(),
					bin: bin(),
					proxyMounted: Boolean(proxyOff),
					mcpMode: mcpMode(),
					mcpOutcome,
					mcpNote,
					reachable: p.reachable,
					version: p.version ?? "",
					error: p.error ?? "",
				},
			};
		};

		const offMessage = host.onMessage(async (msg, from) => {
			if (!msg || typeof msg !== "object" || msg.type !== "status") return;
			const out = await status();
			if (from) host.sendTo(from, out);
			else host.broadcast(out);
		});

		const offSettings = host.onSettingsChanged(() => {
			mountProxy();
			injectMcp();
		});

		mountProxy();
		injectMcp();

		// The interval is milliseconds, not cron. The host only parses 5-field
		// cron (min hour dom mon dow); a 6-field "*/20 * * * * *" makes schedule()
		// throw, which fails the WHOLE activate() and makes the host roll back the
		// effect stack — the reverse proxy included. The plugin then looks installed
		// (mcp.json got written, it is not on the effect stack) while /termcp/ 404s.
		// Milliseconds is the one shape on that path that cannot be written wrong,
		// and a failure here must never take the proxy with it.
		let tick = () => {};
		try {
			tick = host.schedule(20_000, () => {
				void (async () => {
					host.broadcast(await status());
				})();
			});
		} catch (err) {
			host.log("warn", "status polling not registered; the view will probe on open instead:", err?.message ?? err);
		}

		return () => {
			offMessage();
			offSettings();
			try {
				tick();
			} catch {
				/* never registered */
			}
			try {
				proxyOff?.();
			} catch {
				/* already unregistered */
			}
			proxyOff = null;
			restoreMcp();
		};
	},
};

// Exported for selftest.mjs. The host only reads the default export.
export { detectForeignWiring, foreignMcpConfigPaths, SERVER_NAME, IDLE_TIMEOUT };
