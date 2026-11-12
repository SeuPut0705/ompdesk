// Injected by shell-tauri2 after stand-in.js (external file: the app's CSP forbids inline scripts).
(function () {
	var S = window.__SHELL || {};
	function post(path, obj) {
		return fetch(path, { method: "POST", body: JSON.stringify(obj) }).catch(function () {});
	}
	// WebView2 has no Window Controls Overlay (env(titlebar-area-*) is unset): reserve the caption band by hand,
	// the way dev-harness/boot.ts does. A style tag, not inline properties: the theme rewrites <html>'s inline style.
	var st = document.createElement("style");
	st.textContent = "html[data-platform='win32']:root{--sc-caption-buttons:138px;--sc-caption-band:48px}";
	document.head.appendChild(st);
	function boot() {
		// Caption buttons, 138 x 48 at the top right, drawn as injected HTML (Segoe MDL2 glyphs).
		var bar = document.createElement("div");
		bar.id = "__shell-caption";
		bar.style.cssText =
			"position:fixed;top:0;right:0;width:138px;height:48px;display:flex;z-index:2147483647;" +
			"-webkit-app-region:no-drag;app-region:no-drag;user-select:none;font-family:'Segoe MDL2 Assets','Segoe Fluent Icons';font-size:10px;background:var(--sc-bg,transparent)";
		[["minimize", "\uE921", "#8883"], ["maximize", "\uE922", "#8883"], ["close", "\uE8BB", "#e81123"]].forEach(function (b) {
			var e = document.createElement("div");
			e.textContent = b[1];
			e.dataset.action = b[0];
			e.style.cssText =
				"width:46px;height:48px;display:flex;align-items:center;justify-content:center;color:var(--omp-text-primary,#888);-webkit-app-region:no-drag;app-region:no-drag";
			e.onmouseenter = function () {
				e.style.background = b[2];
				if (b[0] === "close") e.style.color = "#fff";
			};
			e.onmouseleave = function () {
				e.style.background = "";
				e.style.color = "var(--omp-text-primary,#888)";
			};
			e.onclick = function () {
				post("/__shell/window", { action: b[0] });
			};
			bar.appendChild(e);
		});
		document.body.appendChild(bar);

		if (S.mode === "cef-stream") stream();
	}
	function stream() {
		var c = document.createElement("canvas");
		c.id = "__shell-preview-canvas";
		c.width = 100;
		c.height = 100;
		c.style.cssText = "position:fixed;left:60%;top:48px;width:40%;height:calc(100% - 48px);z-index:2147483000;background:#222;-webkit-app-region:no-drag;app-region:no-drag";
		document.body.appendChild(c);
		var ctx = c.getContext("2d");
		var seq = 0;
		(async function loop() {
			for (;;) {
				try {
					var r = await fetch("/__shell/preview-frame?after=" + seq, { cache: "no-store" });
					if (r.status !== 200) continue;
					seq = +r.headers.get("X-Frame-Seq");
					var bmp = await createImageBitmap(await r.blob());
					if (c.width !== bmp.width || c.height !== bmp.height) {
						c.width = bmp.width;
						c.height = bmp.height;
					}
					ctx.drawImage(bmp, 0, 0);
					bmp.close();
				} catch (e) {
					await new Promise(function (f) { setTimeout(f, 500); });
				}
			}
		})();
		function pt(ev) {
			var b = c.getBoundingClientRect();
			return { x: ((ev.clientX - b.left) * c.width) / b.width, y: ((ev.clientY - b.top) * c.height) / b.height };
		}
		function send(type, ev, extra) {
			var p = pt(ev);
			post("/__shell/preview-input", Object.assign({ type: type, x: p.x, y: p.y, button: ["left", "middle", "right"][ev.button] || "none", buttons: ev.buttons }, extra || {}));
		}
		c.addEventListener("mousedown", function (e) { send("mousePressed", e, { clickCount: 1 }); });
		c.addEventListener("mouseup", function (e) { send("mouseReleased", e, { clickCount: 1 }); });
		c.addEventListener("mousemove", function (e) { send("mouseMoved", e); });
		c.addEventListener("wheel", function (e) { send("mouseWheel", e, { deltaX: e.deltaX, deltaY: e.deltaY }); e.preventDefault(); }, { passive: false });
	}
	if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
	else boot();
})();
