/**
 * termcp view — the reverse-proxied termcp UI, filling a top-bar view.
 *
 * Why an iframe and not a React rewrite: termcp's frontend is a whole terminal
 * workspace (xterm grid, session windows, tabs, port-forward dialogs, the
 * approval queue). Rebuilding it would be a second implementation to keep in
 * sync, and it would drift. The host's registerProxy exists for exactly this.
 *
 * Address derivation: the iframe points at `<hostbase><prefix>/` where the base
 * comes from THIS bundle's own URL (`.../plugins/termcp-bridge/client/`). That
 * way pi-web-ui deployed under an nginx sub-path still resolves, without the
 * plugin hardcoding the app root. The prefix itself is a setting, so it arrives
 * from the server with the status message rather than being read here — a view
 * ctx has no settings access.
 *
 * Status bar: the server probes termcp and pushes the result, so a termcp that
 * is down shows how to start it instead of a permanently blank iframe.
 */
export default {
	mount(container, ctx) {
		container.style.cssText = "height:100%;width:100%;display:flex;flex-direction:column;min-height:0";

		const bar = document.createElement("div");
		bar.style.cssText =
			"display:flex;align-items:center;gap:8px;padding:4px 10px;font-size:12px;border-bottom:1px solid var(--border-subtle,#223);color:var(--text-dim,#94a3b8);flex:none";
		const label = document.createElement("span");
		label.textContent = "termcp";
		const state = document.createElement("span");
		state.style.cssText = "flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
		const note = document.createElement("span");
		note.style.cssText = "font-size:11px;opacity:.7;white-space:nowrap";
		const reload = document.createElement("button");
		reload.type = "button";
		reload.textContent = "重载";
		reload.style.cssText =
			"all:unset;cursor:pointer;padding:1px 8px;border:1px solid var(--border-subtle,#223);border-radius:5px;font-size:11px";
		const open = document.createElement("a");
		open.textContent = "新标签打开";
		open.style.cssText = "color:inherit;font-size:11px;text-decoration:underline;cursor:pointer";
		bar.append(label, state, note, open, reload);

		const frame = document.createElement("iframe");
		frame.title = "termcp";
		// clipboard: the terminal workspace copies/pastes.
		frame.setAttribute("allow", "clipboard-read; clipboard-write");
		frame.style.cssText = "flex:1;min-height:0;width:100%;border:0;background:transparent";

		// (…/plugins/termcp-bridge/client/) → app root. Empty at a root deployment.
		const base = new URL("../../..", import.meta.url).pathname.replace(/\/+$/, "");

		let prefix = "/termcp"; // default until the server reports the real one
		const mountFrame = () => {
			const src = `${base}${prefix}/`;
			if (frame.getAttribute("src") === src) return;
			frame.src = src;
			open.href = src;
			open.target = "_blank";
			open.rel = "noreferrer";
		};

		container.append(bar, frame);
		mountFrame();

		const setState = (text, warn) => {
			state.textContent = text;
			state.style.color = warn ? "var(--amber,#f59e0b)" : "inherit";
		};
		setState("正在探测…", false);

		const off = ctx?.onData?.((msg) => {
			if (!msg || msg.type !== "status" || !msg.payload) return;
			const p = msg.payload;

			if (typeof p.prefix === "string" && p.prefix && p.prefix !== prefix) {
				prefix = p.prefix;
				mountFrame();
			}

			// Where the AI tools come from — relevant when the plugin stepped aside.
			note.textContent =
				p.mcpOutcome === "skipped"
					? `AI 工具由 ${compactPath(p.mcpNote)} 提供`
					: p.mcpOutcome === "injected" || p.mcpOutcome === "kept"
						? "AI 工具已接入"
						: p.mcpOutcome === "disabled"
							? ""
							: "";

			if (p.reachable) {
				setState(`运行中 · 127.0.0.1:${p.port}${p.version ? ` · ${p.version}` : ""} · 挂载 ${p.prefix}/`, false);
			} else {
				setState(`termcp 未响应（127.0.0.1:${p.port}${p.error ? `，${p.error}` : ""}）—— 应当自动拉起，若未成功请手动运行：termcp daemon start`, true);
			}
		});

		ctx?.send?.({ type: "status" });

		reload.addEventListener("click", () => {
			// Reset src to force a real reload: termcp keeps sessions server-side,
			// so a reload reconnects rather than losing anything.
			const cur = frame.src;
			frame.src = "about:blank";
			requestAnimationFrame(() => {
				frame.src = cur;
			});
			ctx?.send?.({ type: "status" });
		});

		return () => {
			off?.();
			container.textContent = "";
		};
	},
};

/** Home-relative paths are long and the bar is narrow. */
function compactPath(p) {
	const s = String(p ?? "");
	const home = s.match(/^\/(?:Users|home)\/[^/]+/);
	return home ? `~${s.slice(home[0].length)}` : s;
}
