"use strict";

/* global BareMux, registerSW, __uv$config */

import {
	SEARCH_ENGINES,
	buildSearchUrl,
	displayHost,
	extractProxyUrl,
	getSearchTemplate,
	hueFor,
	initialForUrl,
	isProxyableUrl,
	isValidSearchTemplate,
	looksLikeUrl,
	parseAddress,
} from "./js/url.js";
import {
	clearAllData,
	clearBookmarks,
	clearHistory,
	clearSession,
	loadBookmarks,
	loadHistory,
	loadSession,
	loadSettings,
	sanitizeBookmarks,
	sanitizeHistory,
	sanitizeSettings,
	saveBookmarks,
	saveHistory,
	saveSession,
	saveSettings,
	uid,
} from "./js/store.js";

const VERSION = "1.0.0";
const MAX_TABS = 30;
const MAX_CLOSED_TABS = 15;
const MAX_SUGGESTIONS = 8;
const PROXY_TRANSPORT = "/epoxy/index.mjs";

const $ = (selector) => document.querySelector(selector);

const dom = {
	html: document.documentElement,
	themeMeta: document.querySelector('meta[name="theme-color"]'),
	tabs: $("#tabs"),
	newTab: $("#new-tab"),
	back: $("#back"),
	forward: $("#forward"),
	reload: $("#reload"),
	home: $("#home"),
	addressForm: $("#address-form"),
	address: $("#address"),
	addressClear: $("#address-clear"),
	siteIcon: $("#site-icon"),
	proxyBadge: $("#proxy-badge"),
	suggestions: $("#suggestions"),
	bookmarkToggle: $("#bookmark-toggle"),
	menuToggle: $("#menu-toggle"),
	bookmarksBar: $("#bookmarks-bar"),
	loadTrack: $("#load-track"),
	frames: $("#frames"),
	newtab: $("#newtab"),
	ntSearch: $("#nt-search"),
	ntInput: $("#nt-input"),
	ntShortcuts: $("#nt-shortcuts"),
	ntRecent: $("#nt-recent"),
	pageError: $("#page-error"),
	errorTitle: $("#error-title"),
	errorMessage: $("#error-message"),
	errorDetail: $("#error-detail"),
	errorRetry: $("#error-retry"),
	errorHome: $("#error-home"),
	slowBanner: $("#slow-banner"),
	slowStop: $("#slow-stop"),
	slowRetry: $("#slow-retry"),
	findBar: $("#find-bar"),
	findInput: $("#find-input"),
	findStatus: $("#find-status"),
	findPrev: $("#find-prev"),
	findNext: $("#find-next"),
	findClose: $("#find-close"),
	offlineBanner: $("#offline-banner"),
	panel: $("#panel"),
	panelTitle: $("#panel-title"),
	panelSubtitle: $("#panel-subtitle"),
	panelPrimary: $("#panel-primary"),
	panelClose: $("#panel-close"),
	panelFilter: $("#panel-filter"),
	panelClear: $("#panel-clear"),
	panelList: $("#panel-list"),
	panelEmpty: $("#panel-empty"),
	scrim: $("#scrim"),
	menu: $("#menu"),
	tabMenu: $("#tab-menu"),
	settingsDialog: $("#settings-dialog"),
	settingsForm: $("#settings-form"),
	shortcutsDialog: $("#shortcuts-dialog"),
	shortcutsBody: $("#shortcuts-body"),
	toasts: $("#toasts"),
};

const state = {
	settings: loadSettings(),
	bookmarks: loadBookmarks(),
	history: loadHistory(),
	tabs: [],
	activeId: null,
	closedTabs: [],
	panelKind: null,
	suggestions: [],
	suggestionIndex: -1,
	proxy: { ready: false, starting: false, error: null },
	findOpen: false,
	findQuery: "",
	frameTimer: null,
	saveTimer: null,
	panelCloseTimer: null,
	lastToolbarTabId: null,
	settingsFeedbackTimer: null,
};

const tabElements = new Map();
let connection = null;
let proxyPromise = null;

const themeMedia = window.matchMedia("(prefers-color-scheme: light)");

// ---------------------------------------------------------------------------
// Small DOM helpers

function icon(id, className = "icon") {
	const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
	svg.setAttribute("class", className);
	svg.setAttribute("aria-hidden", "true");
	const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
	use.setAttribute("href", `#${id}`);
	svg.append(use);
	return svg;
}

function element(tag, className, text) {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

function isSafeIcon(value) {
	if (typeof value !== "string" || !value) return false;
	if (value.length > 200000) return false;
	if (value.startsWith("//")) return false;
	return (
		value.startsWith("http://") ||
		value.startsWith("https://") ||
		value.startsWith("data:image/") ||
		value.startsWith("/")
	);
}

function faviconImageSource(url) {
	if (!isSafeIcon(url)) return null;
	if (url.startsWith("data:image/")) return url;
	if (url.startsWith("http://") || url.startsWith("https://")) {
		// Load through Horizon so COEP and hotlink protection cannot leave the
		// tab with a letter fallback.
		return `/api/favicon?url=${encodeURIComponent(url)}`;
	}
	return url;
}

function collectFaviconCandidates(tab, doc, baseHref) {
	const base = doc?.baseURI || baseHref || tab.url;
	const candidates = [];
	const seen = new Set();

	const add = (value, score) => {
		if (!value) return;
		let resolved;
		try {
			resolved = new URL(value, base).href;
		} catch {
			return;
		}
		if (!isSafeIcon(resolved) || seen.has(resolved)) return;
		seen.add(resolved);
		candidates.push({ url: resolved, score });
	};

	for (const link of doc?.querySelectorAll("link[rel][href]") || []) {
		const rels = (link.getAttribute("rel") || "").toLowerCase().split(/\s+/);
		const hasIcon = rels.includes("icon");
		const apple = rels.includes("apple-touch-icon");
		const mask = rels.includes("mask-icon");
		if (!hasIcon && !apple && !mask) continue;

		let score = hasIcon ? 0 : apple ? 2 : 3;
		const sizes = (link.getAttribute("sizes") || "").toLowerCase();
		if (sizes.includes("any")) {
			score -= 0.4;
		} else {
			const values = sizes
				.split(/\s+/)
				.map((value) => parseInt(value, 10))
				.filter((value) => Number.isFinite(value));
			const largest = Math.max(0, ...values);
			if (largest >= 16 && largest <= 128) score -= 0.2;
			else if (largest > 128) score += 0.3;
		}
		add(link.getAttribute("href"), score);
	}

	// Many sites rely on the implicit /favicon.ico without declaring a link.
	if (tab.url) {
		try {
			add(new URL("/favicon.ico", tab.url).href, 4);
		} catch {
			// Ignore malformed page URLs.
		}
	}

	return candidates
		.sort((a, b) => a.score - b.score)
		.map((candidate) => candidate.url)
		.slice(0, 5);
}

function createFavicon(url, label, className = "favicon-tile") {
	const box = element("span", className);
	setFavicon(box, url, label);
	return box;
}

function setFavicon(box, sources, label, onResolved) {
	const candidates = (Array.isArray(sources) ? sources : [sources])
		.filter(isSafeIcon)
		.filter((url, index, list) => list.indexOf(url) === index);

	const fallback = () => {
		box.replaceChildren();
		box.textContent =
			(label && label.trim().charAt(0).toUpperCase()) ||
			initialForUrl(candidates[0] || label);
		box.style.background = `hsl(${hueFor(candidates[0] || label || "horizon")} 42% 34%)`;
		box.style.color = "#fff";
	};

	const attempt = (index) => {
		if (index >= candidates.length) {
			fallback();
			return;
		}

		box.replaceChildren();
		box.style.background = "";
		box.style.color = "";
		const img = document.createElement("img");
		img.alt = "";
		img.loading = "eager";
		img.decoding = "async";
		img.src = faviconImageSource(candidates[index]);
		img.addEventListener(
			"load",
			() => {
				if (onResolved) onResolved(candidates[index]);
			},
			{ once: true }
		);
		img.addEventListener("error", () => attempt(index + 1), { once: true });
		box.append(img);
	};

	attempt(0);
}

function activeTab() {
	return state.tabs.find((tab) => tab.id === state.activeId) || null;
}

function tabById(id) {
	return state.tabs.find((tab) => tab.id === id) || null;
}

function proxyPrefix() {
	return globalThis.__uv$config?.prefix || "/uv/service/";
}

function proxyBase() {
	return (
		(location.protocol === "https:" ? "wss" : "ws") +
		"://" +
		location.host +
		"/wisp/"
	);
}

// ---------------------------------------------------------------------------
// Theme

function resolvedTheme() {
	if (state.settings.theme === "system") {
		return themeMedia.matches ? "light" : "dark";
	}
	return state.settings.theme;
}

function applyTheme() {
	const theme = resolvedTheme();
	dom.html.dataset.theme = theme;
	if (dom.themeMeta) {
		dom.themeMeta.setAttribute(
			"content",
			theme === "light" ? "#eef1f7" : "#0b0d12"
		);
	}
}

themeMedia.addEventListener("change", () => {
	if (state.settings.theme === "system") applyTheme();
});

// ---------------------------------------------------------------------------
// Proxy service

function withTimeout(promise, ms, message) {
	let timer;
	return Promise.race([
		promise,
		new Promise((_, reject) => {
			timer = setTimeout(() => reject(new Error(message)), ms);
		}),
	]).finally(() => clearTimeout(timer));
}

async function ensureProxy() {
	if (state.proxy.ready) return;
	if (proxyPromise) return proxyPromise;

	state.proxy.starting = true;
	state.proxy.error = null;
	updateProxyBadge();
	updateProxyStatusText();

	proxyPromise = (async () => {
		if (typeof registerSW !== "function") {
			throw new Error("The service worker helper failed to load.");
		}
		if (typeof BareMux === "undefined" || !BareMux.BareMuxConnection) {
			throw new Error("The bare-mux transport failed to load.");
		}

		await withTimeout(
			registerSW(),
			20000,
			"The proxy service worker could not be registered."
		);
		await withTimeout(
			waitForProxyWorker(),
			15000,
			"The proxy service worker did not start in time."
		);

		if (!connection) {
			connection = new BareMux.BareMuxConnection("/baremux/worker.js");
		}
		// Always reconfigure on boot. A page reload can reuse a bare-mux worker
		// that already reports the Epoxy transport but still holds an old or
		// missing Wisp endpoint, which would leave proxied frames blank.
		await withTimeout(
			connection.setTransport(PROXY_TRANSPORT, [{ wisp: proxyBase() }]),
			15000,
			"The proxy transport could not be configured."
		);

		state.proxy.ready = true;
		state.proxy.starting = false;
		updateProxyBadge();
		updateProxyStatusText();
	})().catch((error) => {
		state.proxy.ready = false;
		state.proxy.starting = false;
		state.proxy.error = error;
		proxyPromise = null;
		updateProxyBadge();
		updateProxyStatusText();
		throw error;
	});

	return proxyPromise;
}

function updateProxyBadge() {
	if (!dom.proxyBadge) return;
	dom.proxyBadge.classList.remove("connecting", "error");
	const text = dom.proxyBadge.querySelector(".proxy-badge-text");
	if (!navigator.onLine) {
		dom.proxyBadge.classList.add("error");
		if (text) text.textContent = "Offline";
		dom.proxyBadge.title = "You are offline.";
	} else if (state.proxy.error) {
		dom.proxyBadge.classList.add("error");
		if (text) text.textContent = "Proxy offline";
		dom.proxyBadge.title =
			state.proxy.error.message || "The proxy service is unavailable.";
	} else if (state.proxy.ready) {
		if (text) text.textContent = "Proxied";
		dom.proxyBadge.title = "Traffic is routed through the Horizon proxy.";
	} else {
		dom.proxyBadge.classList.add("connecting");
		if (text) text.textContent = "Connecting…";
		dom.proxyBadge.title = "Connecting to the proxy service.";
	}
}

async function waitForProxyWorker() {
	const deadline = Date.now() + 15000;
	while (Date.now() < deadline) {
		const registrations = await navigator.serviceWorker.getRegistrations();
		const registration = registrations.find((item) =>
			item.scope.replace(location.origin, "").startsWith("/uv/")
		);
		if (registration?.active) return;

		const worker = registration?.installing || registration?.waiting;
		if (worker) {
			await new Promise((resolve) => {
				const finish = () => {
					clearTimeout(timer);
					worker.removeEventListener("statechange", check);
					resolve();
				};
				const check = () => {
					if (worker.state === "activated" || worker.state === "redundant") {
						finish();
					}
				};
				const timer = setTimeout(finish, 600);
				worker.addEventListener("statechange", check);
			});
		} else {
			await new Promise((resolve) => setTimeout(resolve, 150));
		}
	}
	throw new Error("The proxy service worker did not start in time.");
}

function updateProxyStatusText() {
	const node = document.getElementById("proxy-status-text");
	if (!node) return;
	if (!navigator.onLine) {
		node.textContent =
			"Offline. The proxy will reconnect when your connection returns.";
	} else if (state.proxy.error) {
		node.textContent = `Proxy unavailable: ${state.proxy.error.message || state.proxy.error}`;
	} else if (state.proxy.ready) {
		node.textContent = "Connected through the Ultraviolet proxy.";
	} else if (state.proxy.starting) {
		node.textContent = "Connecting to the proxy…";
	} else {
		node.textContent = "Not connected yet.";
	}
}

// ---------------------------------------------------------------------------
// Tab lifecycle

function makeTab(options = {}) {
	const title =
		options.title || (options.url ? displayHost(options.url) : "New Tab");
	return {
		id: options.id || uid(),
		url: options.url || null,
		title,
		favicon: options.favicon || null,
		home: !options.url,
		loading: false,
		error: null,
		entries: options.entries || [],
		index: Number.isInteger(options.index) ? options.index : -1,
		zoom: options.zoom || state.settings.defaultZoom,
		frame: null,
		frameTimer: null,
		slowTimer: null,
		navSeq: 0,
		deferred: Boolean(options.deferred),
		lastDeepSync: 0,
		homeReturn: null,
		skipNextRecord: false,
	};
}

function createTab(options = {}) {
	if (state.tabs.length >= MAX_TABS) {
		toast(`You can keep up to ${MAX_TABS} tabs open.`);
		return null;
	}

	const tab = makeTab(options);
	state.tabs.push(tab);

	if (options.activate !== false) {
		state.activeId = tab.id;
		closeFind();
		closeSuggestions();
		closeMenu();
		closeTabMenu();
		if (state.panelKind) closePanel();
	}

	renderTabs();

	if (tab.url && !options.deferred) {
		loadTab(tab, tab.url, {
			skipEntry: Boolean(options.entries?.length),
			title: tab.title,
		});
	}

	refreshActiveUI();
	saveSessionSoon();

	if (options.focusAddress && options.activate !== false) {
		requestAnimationFrame(focusAddress);
	}

	return tab;
}

function restoreTabs(session) {
	state.tabs = [];
	state.activeId = session.activeTabId;

	for (const record of session.tabs) {
		const tab = makeTab({
			...record,
			activate: false,
			deferred: record.id !== session.activeTabId,
		});
		state.tabs.push(tab);
	}

	if (!tabById(state.activeId)) state.activeId = state.tabs[0]?.id || null;
	renderTabs();

	const active = activeTab();
	if (active) {
		if (active.url) {
			active.deferred = false;
			loadTab(active, active.url, {
				skipEntry: true,
				title: active.title,
			});
		}
	}

	refreshActiveUI();
	saveSessionSoon();
}

function activateTab(id, options = {}) {
	const tab = tabById(id);
	if (!tab) return;
	const changed = state.activeId !== id;
	state.activeId = id;

	if (tab.deferred && tab.url) {
		tab.deferred = false;
		loadTab(tab, tab.url, {
			skipEntry: true,
			title: tab.title,
		});
	}

	closeSuggestions();
	closeFind();
	if (document.activeElement === dom.address) dom.address.blur();
	renderTabs();
	refreshActiveUI();
	saveSessionSoon();

	if (options.focusAddress) requestAnimationFrame(focusAddress);
	if (!changed && options.noFocus) return;
}

function closeTab(id, options = {}) {
	const index = state.tabs.findIndex((tab) => tab.id === id);
	if (index === -1) return;
	const tab = state.tabs[index];

	state.closedTabs.unshift({
		url: tab.url,
		title: tab.url ? tab.title : "New Tab",
		favicon: tab.favicon,
	});
	state.closedTabs = state.closedTabs.slice(0, MAX_CLOSED_TABS);

	clearTabTimers(tab);
	destroyFrame(tab);
	state.tabs.splice(index, 1);

	if (state.activeId === id) {
		closeFind();
		closeSuggestions();
		const next = state.tabs[Math.min(index, state.tabs.length - 1)];
		state.activeId = next ? next.id : null;
	}

	if (state.tabs.length === 0) {
		createTab({ activate: true, focusAddress: options.focusAddress });
		return;
	}

	renderTabs();
	refreshActiveUI();
	saveSessionNow();
}

function closeOtherTabs(id) {
	const tab = tabById(id);
	if (!tab) return;
	for (const other of [...state.tabs]) {
		if (other.id === id) continue;
		clearTabTimers(other);
		destroyFrame(other);
	}
	state.tabs = [tab];
	state.activeId = tab.id;
	closeFind();
	closeSuggestions();
	renderTabs();
	refreshActiveUI();
	saveSessionNow();
}

function duplicateTab(id) {
	const tab = tabById(id);
	if (!tab) return;
	createTab({
		url: tab.url,
		title: tab.title,
		favicon: tab.favicon,
		entries: tab.entries.map((entry) => ({ ...entry })),
		index: tab.index,
		zoom: tab.zoom,
		activate: true,
	});
}

function reopenClosedTab() {
	const closed = state.closedTabs.shift();
	if (!closed) {
		toast("No recently closed tabs.");
		return;
	}
	createTab({
		url: closed.url,
		title: closed.title,
		favicon: closed.favicon,
		activate: true,
	});
}

function selectRelativeTab(delta) {
	if (state.tabs.length < 2) return;
	const index = state.tabs.findIndex((tab) => tab.id === state.activeId);
	const next = (index + delta + state.tabs.length) % state.tabs.length;
	activateTab(state.tabs[next].id);
}

function selectTabByIndex(index) {
	if (index < 0 || index >= state.tabs.length) return;
	activateTab(state.tabs[index].id);
}

function reorderTab(fromId, toId) {
	const from = state.tabs.findIndex((tab) => tab.id === fromId);
	const to = state.tabs.findIndex((tab) => tab.id === toId);
	if (from === -1 || to === -1 || from === to) return;
	const [moved] = state.tabs.splice(from, 1);
	state.tabs.splice(to, 0, moved);
	renderTabs();
	saveSessionSoon();
}

// ---------------------------------------------------------------------------
// Frame creation and navigation

function ensureFrame(tab) {
	if (tab.frame) return tab.frame;

	const frame = document.createElement("iframe");
	frame.className = "tab-frame";
	frame.title = "Browsing content";
	frame.setAttribute(
		"allow",
		"autoplay; clipboard-read; clipboard-write; fullscreen; encrypted-media; picture-in-picture; geolocation; microphone; camera; web-share"
	);
	// Keep proxied pages inside the viewport: they may open popups and download
	// files, but they cannot replace the browser UI with a top-level navigation.
	frame.setAttribute(
		"sandbox",
		"allow-same-origin allow-scripts allow-forms allow-modals allow-popups allow-downloads allow-pointer-lock allow-presentation allow-orientation-lock allow-storage-access-by-user-activation"
	);

	frame.addEventListener("load", () => {
		if (!tabsContain(tab)) return;
		if (
			!frame.getAttribute("src") ||
			frame.getAttribute("src") === "about:blank"
		) {
			return;
		}
		try {
			if (frame.contentWindow.location.href === "about:blank") return;
		} catch {
			// A cross-origin document is handled below by the error state.
		}
		clearTabTimers(tab);
		tab.loading = false;
		tab.slow = false;
		tab.lastDeepSync = Date.now();
		applyZoom(tab);
		const failed = syncTabFromFrame(tab, { deep: true });
		if (!failed && !canAccessFrameDocument(tab)) {
			setTabError(tab, {
				title: "This page couldn't be loaded",
				message:
					"The page did not open inside Horizon. It may have blocked embedding or navigated to another origin.",
				detail: tab.url || "",
			});
			return;
		}
		if (!failed) {
			tab.error = null;
			if (tab.skipNextRecord) tab.skipNextRecord = false;
			else recordVisit(tab);
		}
		refreshActiveUI();
		updateTabElement(tab);
		saveSessionSoon();
	});

	frame.addEventListener("error", () => {
		if (!tabsContain(tab)) return;
		clearTabTimers(tab);
		setTabError(tab, {
			title: "This page couldn't be loaded",
			message: "The page could not be displayed.",
			detail: tab.url || "",
		});
	});

	tab.frame = frame;
	dom.frames.append(frame);
	return frame;
}

function tabsContain(tab) {
	return state.tabs.includes(tab);
}

function canAccessFrameDocument(tab) {
	try {
		return Boolean(tab.frame?.contentDocument);
	} catch {
		return false;
	}
}

function destroyFrame(tab) {
	clearTabTimers(tab);
	if (!tab.frame) return;
	try {
		tab.frame.src = "about:blank";
	} catch {
		// Ignore.
	}
	tab.frame.remove();
	tab.frame = null;
}

function loadTab(tab, url, options = {}) {
	if (!tabsContain(tab) || !isProxyableUrl(url)) return;

	const seq = ++tab.navSeq;
	clearTabTimers(tab);

	tab.homeReturn = null;
	tab.home = false;
	tab.url = url;
	tab.error = null;
	tab.favicon = null;
	tab.faviconCandidates = [];
	tab.loading = true;
	tab.slow = false;
	tab.lastDeepSync = 0;
	tab.skipNextRecord = Boolean(options.skipRecord);
	if (options.title) tab.title = options.title;

	if (!options.skipEntry) {
		commitEntry(tab, url, tab.title);
	}

	let target = proxyPrefix() + __uv$config.encodeUrl(url);
	// Re-assigning an iframe an identical src is a no-op in some browsers.
	// A query string is ignored by the Ultraviolet codec, so it forces a fresh
	// navigation without changing the decoded page URL or rebuilding the tab.
	if (tab.frame && tab.frame.getAttribute("src") === target) {
		target += `?horizon_reload=${Date.now()}`;
	}
	ensureFrame(tab);
	updateTabElement(tab);
	renderError();
	updateToolbar();

	if (!navigator.onLine) {
		tab.loading = false;
		setTabError(tab, {
			title: "You're offline",
			message: "Check your connection and try again.",
			detail: url,
		});
		return;
	}

	ensureProxy()
		.then(() => {
			if (!tabsContain(tab) || seq !== tab.navSeq) return;
			const frame = ensureFrame(tab);
			startTabTimers(tab);
			frame.src = target;
			updateTabElement(tab);
			renderError();
			updateToolbar();
			refreshActiveUI();
		})
		.catch((error) => {
			if (!tabsContain(tab) || seq !== tab.navSeq) return;
			clearTabTimers(tab);
			setTabError(tab, {
				title: "The proxy is unavailable",
				message:
					"Horizon could not start its proxy connection. Check your network and try reconnecting.",
				detail: String(error?.message || error),
			});
		});

	refreshActiveUI();
	saveSessionSoon();
}

function commitEntry(tab, url, title) {
	const current = tab.entries[tab.index];
	if (current && current.url === url) {
		if (title) current.title = title;
		return;
	}
	tab.entries = tab.entries.slice(0, tab.index + 1);
	tab.entries.push({ url, title: title || displayHost(url) });
	if (tab.entries.length > 60) tab.entries.shift();
	tab.index = tab.entries.length - 1;
}

function goBack(tab = activeTab()) {
	if (!tab) return;
	if (tab.home && tab.homeReturn) {
		const target = tab.homeReturn;
		tab.homeReturn = null;
		loadTab(tab, target.url, {
			skipEntry: true,
			skipRecord: true,
			title: target.title || displayHost(target.url),
		});
		return;
	}
	if (tab.index <= 0) return;
	tab.index -= 1;
	const entry = tab.entries[tab.index];
	loadTab(tab, entry.url, {
		skipEntry: true,
		title: entry.title || displayHost(entry.url),
	});
}

function goForward(tab = activeTab()) {
	if (!tab || tab.index >= tab.entries.length - 1) return;
	tab.index += 1;
	const entry = tab.entries[tab.index];
	loadTab(tab, entry.url, {
		skipEntry: true,
		skipRecord: true,
		title: entry.title || displayHost(entry.url),
	});
}

function reloadTab(tab = activeTab()) {
	if (!tab) return;
	if (tab.loading) {
		stopLoading(tab);
		return;
	}
	if (!tab.url) {
		stopLoading(tab);
		return;
	}
	// Re-enter through the proxy URL instead of calling location.reload().
	// Reloading the child document directly can bypass the service worker on
	// some browsers and leave the tab stuck in a loading state.
	loadTab(tab, tab.url, { skipEntry: true });
}

function stopLoading(tab = activeTab()) {
	if (!tab) return;
	tab.navSeq += 1;
	clearTabTimers(tab);
	tab.loading = false;
	tab.slow = false;
	try {
		tab.frame?.contentWindow?.stop();
	} catch {
		// The frame may not have navigated yet.
	}
	updateTabElement(tab);
	refreshActiveUI();
}

function startTabTimers(tab) {
	clearTabTimers(tab);
	tab.slowTimer = window.setTimeout(() => {
		if (!tabsContain(tab) || !tab.loading) return;
		tab.slow = true;
		refreshActiveUI();
	}, 20000);

	tab.frameTimer = window.setTimeout(() => {
		if (!tabsContain(tab) || !tab.loading) return;
		setTabError(tab, {
			title: "This page is taking too long",
			message:
				"The site did not respond in time. It may be blocked, offline, or refusing proxied requests.",
			detail: tab.url || "",
		});
	}, 45000);
}

function clearTabTimers(tab) {
	if (tab.slowTimer) {
		clearTimeout(tab.slowTimer);
		tab.slowTimer = null;
	}
	if (tab.frameTimer) {
		clearTimeout(tab.frameTimer);
		tab.frameTimer = null;
	}
}

function setTabError(tab, error) {
	clearTabTimers(tab);
	tab.loading = false;
	tab.slow = false;
	tab.error = error;
	tab.skipNextRecord = false;
	tab.title = tab.url ? displayHost(tab.url) : "New Tab";
	updateTabElement(tab);
	refreshActiveUI();
	saveSessionSoon();
}

function syncTabFromFrame(tab, options = {}) {
	if (!tab.frame || tab.home) return false;
	const now = Date.now();
	const deep = options.deep || now - tab.lastDeepSync > 1800;
	let href = null;
	let doc = null;

	try {
		href = tab.frame.contentWindow.location.href;
	} catch {
		href = null;
	}

	let decoded = null;
	if (href && href.includes(proxyPrefix())) {
		decoded = extractProxyUrl(href, proxyPrefix(), __uv$config.decodeUrl);
	} else if (href && isProxyableUrl(href)) {
		// Ultraviolet may expose the decoded address through the child's
		// emulated Location object.
		decoded = href;
	}

	if (decoded && decoded !== tab.url) {
		tab.url = decoded;
		tab.home = false;
		tab.lastLocation = decoded;
		commitEntry(tab, decoded, tab.title);
		if (state.activeId === tab.id) updateToolbar();
		saveSessionSoon();
	}

	if (!deep) return false;
	tab.lastDeepSync = now;

	try {
		doc = tab.frame.contentDocument;
	} catch {
		doc = null;
	}
	if (!doc) return false;

	const errorNode = doc.querySelector("#uv-error");
	const errorText = errorNode?.textContent?.trim() || "";
	const title = (doc.title || "").trim().slice(0, 300);

	if (
		errorText ||
		title === "Ultraviolet | Error" ||
		doc.querySelector("#uv-register-sw.show")
	) {
		const code = doc.querySelector("#uv-error-code")?.textContent?.trim() || "";
		setTabError(tab, {
			title: "This page couldn't be loaded",
			message: errorText || "The proxy could not reach this site.",
			detail: code,
		});
		return true;
	}

	const effectiveTitle = title || displayHost(tab.url);
	if (effectiveTitle && effectiveTitle !== tab.title) {
		tab.title = effectiveTitle;
		const entry = tab.entries[tab.index];
		if (entry && entry.url === tab.url) entry.title = effectiveTitle;
		if (state.history[0]?.url === tab.url) {
			state.history[0].title = effectiveTitle;
			saveHistory(state.history);
		}
		updateTabElement(tab);
		updateDocumentTitle();
		saveSessionSoon();
	}

	const faviconCandidates = collectFaviconCandidates(tab, doc, href || tab.url);
	const previousCandidates = tab.faviconCandidates || [];
	if (faviconCandidates.join("\n") !== previousCandidates.join("\n")) {
		tab.faviconCandidates = faviconCandidates;
		if (tab.favicon && !faviconCandidates.includes(tab.favicon)) {
			tab.favicon = null;
		}
		updateTabElement(tab);
		saveSessionSoon();
	}
	return false;
}

function applyZoom(tab) {
	if (!tab.frame) return;
	const zoom = tab.zoom || 100;
	try {
		const doc = tab.frame.contentDocument;
		if (doc?.documentElement) {
			doc.documentElement.style.zoom = zoom === 100 ? "" : `${zoom}%`;
			return;
		}
	} catch {
		// Fall back to scaling the iframe itself.
	}
	tab.frame.style.zoom = zoom === 100 ? "" : `${zoom}%`;
}

function setZoom(action) {
	const tab = activeTab();
	if (!tab) return;
	let zoom = tab.zoom || 100;
	if (action === "in") zoom = Math.min(200, zoom + 10);
	else if (action === "out") zoom = Math.max(50, zoom - 10);
	else zoom = state.settings.defaultZoom || 100;
	tab.zoom = zoom;
	applyZoom(tab);
	saveSessionSoon();
	toast(`Zoom: ${zoom}%`);
}

// ---------------------------------------------------------------------------
// History

function recordVisit(tab) {
	if (!tab.url) return;
	const now = Date.now();

	if (
		state.history[0] &&
		state.history[0].url === tab.url &&
		now - state.history[0].visitedAt < 5000
	) {
		state.history[0].title = tab.title || state.history[0].title;
		saveHistory(state.history);
		updateSettingsCounts();
		return;
	}

	state.history.unshift({
		id: uid(),
		url: tab.url,
		title: tab.title || displayHost(tab.url),
		favicon: tab.favicon,
		visitedAt: now,
	});
	state.history = state.history.slice(0, 500);
	saveHistory(state.history);
	updateSettingsCounts();
}

function historyForHost() {
	const seen = new Set();
	const items = [];
	for (const entry of state.history) {
		if (seen.has(entry.url)) continue;
		seen.add(entry.url);
		items.push(entry);
		if (items.length >= 6) break;
	}
	return items;
}

// ---------------------------------------------------------------------------
// Bookmarks

function isBookmarked(url) {
	if (!url) return false;
	return state.bookmarks.some((bookmark) => bookmark.url === url);
}

function toggleBookmark() {
	const tab = activeTab();
	if (!tab || !tab.url) {
		toast("Open a page before bookmarking it.");
		return;
	}

	const existing = state.bookmarks.find((bookmark) => bookmark.url === tab.url);
	if (existing) {
		state.bookmarks = state.bookmarks.filter(
			(bookmark) => bookmark.url !== tab.url
		);
		toast("Bookmark removed.");
	} else {
		state.bookmarks.unshift({
			id: uid(),
			title: tab.title || displayHost(tab.url),
			url: tab.url,
			favicon: tab.favicon,
			createdAt: Date.now(),
		});
		toast("Bookmarked.");
	}

	saveBookmarks(state.bookmarks);
	updateBookmarkButton();
	renderBookmarksBar();
	renderNewTab();
	updateSettingsCounts();
	if (state.panelKind === "bookmarks") renderPanel();
	saveSessionSoon();
}

function addCurrentBookmark() {
	const tab = activeTab();
	if (!tab || !tab.url) {
		toast("Open a page before bookmarking it.");
		return;
	}
	if (isBookmarked(tab.url)) {
		toast("This page is already bookmarked.");
		return;
	}
	state.bookmarks.unshift({
		id: uid(),
		title: tab.title || displayHost(tab.url),
		url: tab.url,
		favicon: tab.favicon,
		createdAt: Date.now(),
	});
	saveBookmarks(state.bookmarks);
	updateBookmarkButton();
	renderBookmarksBar();
	renderNewTab();
	updateSettingsCounts();
	if (state.panelKind === "bookmarks") renderPanel();
	toast("Bookmarked.");
}

function removeBookmark(id) {
	state.bookmarks = state.bookmarks.filter((bookmark) => bookmark.id !== id);
	saveBookmarks(state.bookmarks);
	updateBookmarkButton();
	renderBookmarksBar();
	renderNewTab();
	updateSettingsCounts();
	if (state.panelKind === "bookmarks") renderPanel();
	toast("Bookmark removed.");
}

// ---------------------------------------------------------------------------
// Rendering: tabs and toolbar

function updateTabSizing() {
	const count = state.tabs.length;
	if (!count) {
		dom.tabs.style.removeProperty("--tab-width");
		dom.tabs.style.removeProperty("width");
		return;
	}

	const strip = dom.tabs.parentElement;
	const stripStyle = getComputedStyle(strip);
	const horizontalPadding =
		parseFloat(stripStyle.paddingLeft) + parseFloat(stripStyle.paddingRight);
	const gap = parseFloat(stripStyle.columnGap) || 0;
	const newTabWidth = dom.newTab?.getBoundingClientRect().width || 28;
	const available = Math.max(
		220,
		strip.clientWidth - horizontalPadding - newTabWidth - 16 - gap * 2
	);
	const minimum = window.innerWidth <= 700 ? 56 : 64;
	const tabWidth = Math.max(
		minimum,
		Math.floor(available / Math.max(6, count))
	);

	dom.tabs.style.setProperty("--tab-width", `${tabWidth}px`);
	dom.tabs.style.width = `${Math.min(tabWidth * count, available)}px`;
}

function renderTabs() {
	tabElements.clear();
	dom.tabs.replaceChildren();

	for (const tab of state.tabs) {
		const tabEl = element("div", "tab");
		tabEl.setAttribute("role", "tab");
		tabEl.setAttribute("tabindex", "0");
		tabEl.setAttribute("aria-selected", String(tab.id === state.activeId));
		tabEl.draggable = true;
		if (tab.id === state.activeId) tabEl.classList.add("active");

		const favicon = element("span", "tab-favicon");
		const title = element("span", "tab-title", tab.title);
		const close = element("button", "tab-close");
		close.type = "button";
		close.title = "Close tab";
		close.setAttribute("aria-label", `Close ${tab.title}`);
		close.append(icon("i-x"));

		tabEl.append(favicon, title, close);

		tabEl.addEventListener("click", () => activateTab(tab.id));
		tabEl.addEventListener("keydown", (event) => {
			if (event.key === "Enter" || event.key === " ") {
				event.preventDefault();
				activateTab(tab.id);
			}
		});
		tabEl.addEventListener("auxclick", (event) => {
			if (event.button === 1) {
				event.preventDefault();
				closeTab(tab.id);
			}
		});
		tabEl.addEventListener("contextmenu", (event) => {
			event.preventDefault();
			openTabMenu(event, tab);
		});
		close.addEventListener("click", (event) => {
			event.stopPropagation();
			closeTab(tab.id);
		});

		tabEl.addEventListener("dragstart", (event) => {
			event.dataTransfer.effectAllowed = "move";
			event.dataTransfer.setData("text/plain", tab.id);
			tabEl.classList.add("dragging");
		});
		tabEl.addEventListener("dragend", () => {
			tabEl.classList.remove("dragging");
			for (const node of dom.tabs.children)
				node.classList.remove("drop-target");
		});
		tabEl.addEventListener("dragover", (event) => {
			event.preventDefault();
			event.dataTransfer.dropEffect = "move";
			tabEl.classList.add("drop-target");
		});
		tabEl.addEventListener("dragleave", () =>
			tabEl.classList.remove("drop-target")
		);
		tabEl.addEventListener("drop", (event) => {
			event.preventDefault();
			tabEl.classList.remove("drop-target");
			const fromId = event.dataTransfer.getData("text/plain");
			if (fromId) reorderTab(fromId, tab.id);
		});

		dom.tabs.append(tabEl);
		tabElements.set(tab.id, {
			root: tabEl,
			favicon,
			title,
			close,
			faviconKey: undefined,
			faviconLabel: undefined,
		});
		updateTabElement(tab);
	}

	updateTabSizing();

	const activeEl = tabElements.get(state.activeId)?.root;
	if (activeEl) {
		activeEl.scrollIntoView({ block: "nearest", inline: "nearest" });
	}
}

function updateTabElement(tab) {
	const refs = tabElements.get(tab.id);
	if (!refs) return;
	const isActive = tab.id === state.activeId;
	refs.root.classList.toggle("active", isActive);
	refs.root.setAttribute("aria-selected", String(isActive));
	refs.root.title = tab.title || "New Tab";
	refs.title.textContent = tab.title || "New Tab";
	refs.close.setAttribute("aria-label", `Close ${tab.title || "tab"}`);

	refs.favicon.hidden = Boolean(tab.loading);
	if (tab.loading) {
		refs.favicon.replaceChildren();
		refs.faviconKey = undefined;
		refs.faviconLabel = undefined;
	} else {
		const faviconLabel = tab.url || tab.title;
		const candidates = [];
		if (tab.favicon) candidates.push(tab.favicon);
		for (const candidate of tab.faviconCandidates || []) {
			if (!candidates.includes(candidate)) candidates.push(candidate);
		}
		const faviconKey = candidates.join("\n");
		if (refs.faviconKey !== faviconKey || refs.faviconLabel !== faviconLabel) {
			const navSeq = tab.navSeq;
			const pageUrl = tab.url;
			setFavicon(refs.favicon, candidates, faviconLabel, (resolved) => {
				if (
					!tabsContain(tab) ||
					tab.navSeq !== navSeq ||
					tab.url !== pageUrl ||
					tab.favicon === resolved
				) {
					return;
				}
				tab.favicon = resolved;
				saveSessionSoon();
			});
			refs.faviconKey = faviconKey;
			refs.faviconLabel = faviconLabel;
		}
	}

	const existingSpinner = refs.root.querySelector(".tab-spinner");
	if (tab.loading) {
		if (!existingSpinner) {
			const spinner = element("span", "tab-spinner");
			refs.root.insertBefore(spinner, refs.close);
		}
	} else if (existingSpinner) {
		existingSpinner.remove();
	}
}

function refreshActiveUI() {
	const tab = activeTab();
	for (const item of state.tabs) {
		if (item.frame) {
			item.frame.classList.toggle(
				"active",
				item.id === state.activeId && !item.home
			);
		}
		updateTabElement(item);
	}
	dom.newtab.hidden = !tab || !tab.home;
	renderError();
	renderSlow();
	updateToolbar();
	updateLoadTrack();
	updateDocumentTitle();
	if (tab?.home) renderNewTab();
}

function updateToolbar() {
	const tab = activeTab();
	const switchedTab = tab?.id !== state.lastToolbarTabId;
	state.lastToolbarTabId = tab?.id || null;
	const addressFocused = document.activeElement === dom.address && !switchedTab;

	if (tab && !tab.home && !addressFocused) {
		dom.address.value = tab.url || "";
	} else if (tab?.home && !addressFocused) {
		dom.address.value = "";
	}

	dom.addressClear.hidden = !dom.address.value;
	dom.address.title = tab?.url || "";
	dom.back.disabled = !tab || (tab.index <= 0 && !tab.homeReturn);
	dom.forward.disabled = !tab || tab.index >= tab.entries.length - 1;

	dom.reload.classList.toggle("loading", Boolean(tab?.loading));
	dom.reload.title = tab?.loading ? "Stop loading" : "Reload (Ctrl + R)";
	dom.reload.setAttribute(
		"aria-label",
		tab?.loading ? "Stop loading" : "Reload"
	);

	if (tab?.url) {
		try {
			const protocol = new URL(tab.url).protocol;
			dom.siteIcon.replaceChildren(
				icon(protocol === "https:" ? "i-lock" : "i-globe")
			);
			dom.siteIcon.classList.toggle("secure", protocol === "https:");
		} catch {
			dom.siteIcon.replaceChildren(icon("i-globe"));
		}
	} else {
		dom.siteIcon.replaceChildren(icon("i-search"));
		dom.siteIcon.classList.remove("secure");
	}

	updateBookmarkButton();
	updateProxyBadge();
	updateDocumentTitle();
}

function updateBookmarkButton() {
	const tab = activeTab();
	const bookmarked = Boolean(tab?.url && isBookmarked(tab.url));
	dom.bookmarkToggle.disabled = !tab?.url;
	dom.bookmarkToggle.setAttribute("aria-pressed", String(bookmarked));
	dom.bookmarkToggle.title = bookmarked
		? "Remove bookmark (Ctrl + D)"
		: "Bookmark this page (Ctrl + D)";
	dom.bookmarkToggle.setAttribute(
		"aria-label",
		bookmarked ? "Remove bookmark" : "Bookmark this page"
	);
}

function documentTitle() {
	const tab = activeTab();
	if (tab && !tab.home && tab.title) return `${tab.title} — Horizon`;
	return "Horizon Browser";
}

function updateDocumentTitle() {
	document.title = documentTitle();
}

function updateLoadTrack() {
	const tab = activeTab();
	dom.loadTrack.classList.toggle("loading", Boolean(tab?.loading));
}

function renderError() {
	const tab = activeTab();
	if (!tab || !tab.error) {
		dom.pageError.hidden = true;
		return;
	}
	dom.errorTitle.textContent =
		tab.error.title || "This page couldn't be loaded";
	dom.errorMessage.textContent =
		tab.error.message || "The connection was interrupted.";
	if (tab.error.detail) {
		dom.errorDetail.textContent = tab.error.detail;
		dom.errorDetail.hidden = false;
	} else {
		dom.errorDetail.hidden = true;
	}
	dom.pageError.hidden = false;
}

function renderSlow() {
	const tab = activeTab();
	dom.slowBanner.hidden = !(
		tab?.slow &&
		tab.loading &&
		!tab.error &&
		!tab.home
	);
}

// ---------------------------------------------------------------------------
// Rendering: bookmarks bar, new tab, panel

function wireOpenButton(button, item, options = {}) {
	button.addEventListener("click", (event) => {
		if (!item.url) return;
		if (event.ctrlKey || event.metaKey) {
			createTab({ url: item.url, activate: false });
		} else if (event.shiftKey || !state.activeId) {
			createTab({ url: item.url, activate: true });
		} else {
			loadTab(activeTab(), item.url);
		}
		closePanel();
	});
	if (options.middleClick) {
		button.addEventListener("auxclick", (event) => {
			if (event.button === 1 && item.url) {
				event.preventDefault();
				createTab({ url: item.url, activate: false });
			}
		});
	}
}

function renderBookmarksBar() {
	dom.bookmarksBar.replaceChildren();
	dom.bookmarksBar.hidden = !state.settings.showBookmarksBar;
	if (!state.settings.showBookmarksBar) return;

	if (state.bookmarks.length === 0) {
		dom.bookmarksBar.append(
			element(
				"span",
				"bookmarks-empty",
				"Bookmark pages with the star in the address bar."
			)
		);
		return;
	}

	for (const bookmark of state.bookmarks.slice(0, 40)) {
		const chip = element("button", "bookmark-chip");
		chip.type = "button";
		chip.title = bookmark.url;
		chip.append(
			createFavicon(bookmark.favicon, bookmark.title, "tab-favicon"),
			element("span", "tab-title", bookmark.title || displayHost(bookmark.url))
		);
		wireOpenButton(chip, bookmark, { middleClick: true });
		dom.bookmarksBar.append(chip);
	}
}

function renderNewTab() {
	if (!activeTab()?.home) return;

	dom.ntShortcuts.replaceChildren();
	if (state.bookmarks.length === 0) {
		const empty = element("div", "empty-card");
		empty.append(
			icon("i-bookmark"),
			element(
				"span",
				"",
				"Save pages with the bookmark button and they will appear here."
			)
		);
		dom.ntShortcuts.append(empty);
	} else {
		const sorted = [...state.bookmarks]
			.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
			.slice(0, 8);
		for (const bookmark of sorted) {
			const shortcut = element("button", "shortcut");
			shortcut.type = "button";
			shortcut.title = bookmark.url;
			shortcut.append(
				createFavicon(bookmark.favicon, bookmark.title, "favicon-tile"),
				element(
					"span",
					"shortcut-title",
					bookmark.title || displayHost(bookmark.url)
				),
				element("span", "shortcut-host", displayHost(bookmark.url))
			);
			wireOpenButton(shortcut, bookmark, { middleClick: true });
			dom.ntShortcuts.append(shortcut);
		}
	}

	dom.ntRecent.replaceChildren();
	const recent = historyForHost();
	if (recent.length === 0) {
		const item = element("li", "empty-card");
		item.append(
			icon("i-clock"),
			element("span", "", "Pages you visit will show up here for quick access.")
		);
		dom.ntRecent.append(item);
	} else {
		for (const entry of recent) {
			const item = element("li", "");
			const button = element("button", "recent-item");
			button.type = "button";
			button.title = entry.url;
			const copy = element("span", "recent-copy");
			copy.append(
				element("span", "recent-title", entry.title || displayHost(entry.url)),
				element("span", "recent-host", displayHost(entry.url))
			);
			button.append(
				createFavicon(entry.favicon, entry.title, "favicon-tile"),
				copy,
				element("span", "recent-time", relativeTime(entry.visitedAt))
			);
			wireOpenButton(button, entry, { middleClick: true });
			item.append(button);
			dom.ntRecent.append(item);
		}
	}
}

function relativeTime(timestamp) {
	const diff = Date.now() - timestamp;
	const minute = 60 * 1000;
	const hour = 60 * minute;
	const day = 24 * hour;
	if (diff < minute) return "now";
	if (diff < hour) return `${Math.floor(diff / minute)}m`;
	if (diff < day) return `${Math.floor(diff / hour)}h`;
	if (diff < 7 * day) return `${Math.floor(diff / day)}d`;
	return new Date(timestamp).toLocaleDateString(undefined, {
		month: "short",
		day: "numeric",
	});
}

function openPanel(kind) {
	state.panelKind = kind;
	clearTimeout(state.panelCloseTimer);
	dom.panel.hidden = false;
	dom.panel.setAttribute("aria-hidden", "false");
	dom.scrim.hidden = false;
	requestAnimationFrame(() => dom.panel.classList.add("open"));
	dom.panelFilter.value = "";
	renderPanel();
	requestAnimationFrame(() => dom.panelFilter.focus());
	closeMenu();
	closeTabMenu();
}

function closePanel() {
	state.panelKind = null;
	dom.panel.classList.remove("open");
	dom.panel.setAttribute("aria-hidden", "true");
	dom.scrim.hidden = true;
	clearTimeout(state.panelCloseTimer);
	state.panelCloseTimer = setTimeout(() => {
		dom.panel.hidden = true;
	}, 260);
}

function renderPanel() {
	if (!state.panelKind) return;
	const kind = state.panelKind;
	const filter = dom.panelFilter.value.trim().toLowerCase();

	dom.panelTitle.textContent = kind === "bookmarks" ? "Bookmarks" : "History";
	dom.panelClear.hidden = kind !== "history";
	dom.panelPrimary.hidden = kind !== "bookmarks";
	dom.panelPrimary.replaceChildren(icon("i-plus"));
	dom.panelPrimary.title = "Bookmark the current page";
	dom.panelPrimary.setAttribute("aria-label", "Bookmark the current page");
	dom.panelFilter.placeholder =
		kind === "bookmarks" ? "Filter bookmarks" : "Search history";

	const source = kind === "bookmarks" ? state.bookmarks : state.history;
	dom.panelSubtitle.textContent =
		kind === "bookmarks"
			? `${source.length} saved ${source.length === 1 ? "page" : "pages"}`
			: `${source.length} ${source.length === 1 ? "visit" : "visits"}`;

	const filtered = filter
		? source.filter((item) => {
				const haystack = `${item.title} ${item.url}`.toLowerCase();
				return haystack.includes(filter);
			})
		: source;

	dom.panelList.replaceChildren();
	dom.panelEmpty.hidden = filtered.length > 0;

	if (filtered.length === 0) {
		dom.panelEmpty.replaceChildren();
		dom.panelEmpty.append(
			icon(kind === "bookmarks" ? "i-bookmark" : "i-clock"),
			element(
				"p",
				"",
				source.length === 0
					? kind === "bookmarks"
						? "No bookmarks yet. Open a page and press Ctrl + D, or use the + button above."
						: "No browsing history yet."
					: "Nothing matches this filter."
			)
		);
		return;
	}

	if (kind === "history") {
		let lastGroup = "";
		for (const entry of filtered) {
			const group = historyGroup(entry.visitedAt);
			if (group !== lastGroup) {
				lastGroup = group;
				dom.panelList.append(element("div", "panel-group-label", group));
			}
			dom.panelList.append(panelItem(entry, "history"));
		}
	} else {
		for (const bookmark of filtered) {
			dom.panelList.append(panelItem(bookmark, "bookmarks"));
		}
	}
}

function historyGroup(timestamp) {
	const now = new Date();
	const date = new Date(timestamp);
	const startOfToday = new Date(
		now.getFullYear(),
		now.getMonth(),
		now.getDate()
	).getTime();
	const startOfYesterday = startOfToday - 24 * 60 * 60 * 1000;
	if (timestamp >= startOfToday) return "Today";
	if (timestamp >= startOfYesterday) return "Yesterday";
	return date.toLocaleDateString(undefined, {
		weekday: "short",
		month: "short",
		day: "numeric",
		year: date.getFullYear() === now.getFullYear() ? undefined : "numeric",
	});
}

function panelItem(entry, kind) {
	const row = element("div", "panel-item");
	const open = element("button", "panel-item-main");
	open.type = "button";
	open.title = entry.url;
	const copy = element("span", "panel-item-copy");
	copy.append(
		element("span", "panel-item-title", entry.title || displayHost(entry.url)),
		element(
			"span",
			"panel-item-url",
			`${displayHost(entry.url)}${kind === "history" ? ` · ${relativeTime(entry.visitedAt)}` : ""}`
		)
	);
	open.append(createFavicon(entry.favicon, entry.title, "favicon-tile"), copy);
	wireOpenButton(open, entry, { middleClick: true });

	const remove = element("button", "panel-item-action");
	remove.type = "button";
	remove.title =
		kind === "bookmarks" ? "Remove bookmark" : "Remove from history";
	remove.setAttribute("aria-label", remove.title);
	remove.append(icon("i-trash"));
	remove.addEventListener("click", () => {
		if (kind === "bookmarks") {
			removeBookmark(entry.id);
		} else {
			state.history = state.history.filter((item) => item.id !== entry.id);
			saveHistory(state.history);
			renderPanel();
			updateSettingsCounts();
			renderNewTab();
		}
	});

	row.append(open, remove);
	return row;
}

function clearHistoryData() {
	if (state.history.length === 0) {
		toast("History is already empty.");
		return;
	}
	if (!window.confirm("Clear all browsing history? This cannot be undone."))
		return;
	state.history = [];
	clearHistory();
	renderNewTab();
	renderPanel();
	updateSettingsCounts();
	settingsFeedback("Browsing history cleared.");
	toast("Browsing history cleared.");
}

// ---------------------------------------------------------------------------
// Address bar suggestions

function closeSuggestions() {
	state.suggestions = [];
	state.suggestionIndex = -1;
	dom.suggestions.hidden = true;
	dom.suggestions.replaceChildren();
	dom.address.setAttribute("aria-expanded", "false");
	dom.address.removeAttribute("aria-activedescendant");
}

function buildSuggestions(query) {
	const template = getSearchTemplate(state.settings);
	const items = [];
	const seen = new Set();
	const lowered = query.toLowerCase();

	if (looksLikeUrl(query)) {
		const parsed = parseAddress(query, template);
		if (parsed?.kind === "url") {
			items.push({
				kind: "url",
				title: "Go to this address",
				url: parsed.url,
				subtitle: parsed.url,
				icon: "i-globe",
			});
		}
	}

	for (const bookmark of state.bookmarks) {
		if (items.length >= MAX_SUGGESTIONS - 1) break;
		if (
			bookmark.url.toLowerCase().includes(lowered) ||
			bookmark.title.toLowerCase().includes(lowered)
		) {
			if (seen.has(bookmark.url)) continue;
			seen.add(bookmark.url);
			items.push({
				kind: "bookmark",
				title: bookmark.title,
				url: bookmark.url,
				subtitle: displayHost(bookmark.url),
				icon: "i-bookmark",
			});
		}
	}

	for (const entry of state.history) {
		if (items.length >= MAX_SUGGESTIONS - 1) break;
		if (
			entry.url.toLowerCase().includes(lowered) ||
			entry.title.toLowerCase().includes(lowered)
		) {
			if (seen.has(entry.url)) continue;
			seen.add(entry.url);
			items.push({
				kind: "history",
				title: entry.title,
				url: entry.url,
				subtitle: displayHost(entry.url),
				icon: "i-clock",
			});
		}
	}

	const engine = SEARCH_ENGINES.find(
		(item) => item.id === state.settings.searchEngine
	);
	const fallbackToGoogle =
		!engine ||
		(engine.id === "custom" &&
			!isValidSearchTemplate(state.settings.customSearchTemplate));
	items.push({
		kind: "search",
		title: `Search for “${query}”`,
		url: buildSearchUrl(query, template),
		subtitle: fallbackToGoogle ? "Google" : engine.name,
		icon: "i-search",
	});

	return items.slice(0, MAX_SUGGESTIONS);
}

function renderSuggestions() {
	dom.suggestions.replaceChildren();
	if (state.suggestions.length === 0) {
		closeSuggestions();
		return;
	}

	for (const [index, item] of state.suggestions.entries()) {
		const button = element("button", "suggestion");
		button.type = "button";
		button.setAttribute("role", "option");
		button.id = `suggestion-${index}`;

		const iconBox = element("span", "suggestion-icon");
		iconBox.append(icon(item.icon));
		const copy = element("span", "suggestion-copy");

		if (item.kind === "search") {
			const action = element("span", "suggestion-action");
			action.append(
				document.createTextNode("Search "),
				element("strong", "", item.subtitle),
				document.createTextNode(
					` for “${item.title.replace(/^Search for “|”$/g, "")}”`
				)
			);
			copy.append(action);
		} else {
			copy.append(
				element("span", "suggestion-title", item.title),
				element("span", "suggestion-url", item.subtitle)
			);
		}

		button.append(iconBox, copy);
		button.addEventListener("mousedown", (event) => event.preventDefault());
		button.addEventListener("mouseenter", () => setSuggestionIndex(index));
		button.addEventListener("click", () => chooseSuggestion(index));
		dom.suggestions.append(button);
	}

	setSuggestionIndex(state.suggestionIndex >= 0 ? state.suggestionIndex : 0);
	dom.suggestions.hidden = false;
	dom.address.setAttribute("aria-expanded", "true");
}

function setSuggestionIndex(index) {
	const buttons = [...dom.suggestions.querySelectorAll(".suggestion")];
	if (buttons.length === 0) return;
	state.suggestionIndex = (index + buttons.length) % buttons.length;
	buttons.forEach((button, i) => {
		button.classList.toggle("active", i === state.suggestionIndex);
		button.setAttribute("aria-selected", String(i === state.suggestionIndex));
	});
	const current = buttons[state.suggestionIndex];
	dom.address.setAttribute("aria-activedescendant", current.id);
	current.scrollIntoView({ block: "nearest" });
}

function chooseSuggestion(index) {
	const item = state.suggestions[index];
	if (!item) return;
	closeSuggestions();
	dom.address.blur();
	navigateTo(item.url);
}

function updateAddressSuggestions() {
	const query = dom.address.value.trim();
	dom.addressClear.hidden = !dom.address.value;
	if (!query) {
		closeSuggestions();
		return;
	}
	state.suggestions = buildSuggestions(query);
	state.suggestionIndex = 0;
	renderSuggestions();
}

function navigateInput(input) {
	const parsed = parseAddress(input, getSearchTemplate(state.settings));
	if (!parsed) return;
	const tab = activeTab();
	if (!tab) {
		createTab({ url: parsed.url, activate: true });
		return;
	}
	loadTab(tab, parsed.url);
}

function navigateTo(url) {
	if (!isProxyableUrl(url)) {
		toast("Only http and https addresses can be opened.");
		return;
	}
	const tab = activeTab();
	if (tab) loadTab(tab, url);
	else createTab({ url, activate: true });
}

function focusAddress() {
	closeMenu();
	closeTabMenu();
	if (state.panelKind) closePanel();
	dom.address.focus();
	dom.address.select();
}

// ---------------------------------------------------------------------------
// Settings

function buildSettingsForm() {
	const engineSelect = document.getElementById("setting-search-engine");
	engineSelect.replaceChildren();
	for (const engine of SEARCH_ENGINES) {
		const option = document.createElement("option");
		option.value = engine.id;
		option.textContent = engine.name;
		engineSelect.append(option);
	}

	const zoomSelect = document.getElementById("setting-zoom");
	zoomSelect.replaceChildren();
	for (let zoom = 50; zoom <= 200; zoom += 10) {
		const option = document.createElement("option");
		option.value = String(zoom);
		option.textContent = `${zoom}%`;
		zoomSelect.append(option);
	}

	for (const radio of dom.settingsForm.querySelectorAll(
		'input[name="theme"]'
	)) {
		radio.addEventListener("change", () => {
			if (!radio.checked) return;
			state.settings.theme = radio.value;
			saveSettings(state.settings);
			applyTheme();
		});
	}

	document
		.getElementById("setting-bookmarks-bar")
		.addEventListener("change", (event) => {
			state.settings.showBookmarksBar = event.target.checked;
			saveSettings(state.settings);
			renderBookmarksBar();
		});

	engineSelect.addEventListener("change", () => {
		state.settings.searchEngine = engineSelect.value;
		const customRow = document.getElementById("custom-engine-row");
		customRow.hidden = engineSelect.value !== "custom";
		if (engineSelect.value !== "custom") {
			saveSettings(state.settings);
			state.suggestions = [];
		}
	});

	const customInput = document.getElementById("setting-custom-engine");
	const customError = document.getElementById("custom-engine-error");
	customInput.addEventListener("keydown", (event) => {
		if (event.key === "Enter") event.preventDefault();
	});
	customInput.addEventListener("input", () => {
		const value = customInput.value.trim();
		if (!value) {
			customError.hidden = true;
			return;
		}
		if (!isValidSearchTemplate(value)) {
			customError.textContent = "Include %s and use an http or https address.";
			customError.hidden = false;
			return;
		}
		customError.hidden = true;
		state.settings.customSearchTemplate = value;
		state.settings.searchEngine = "custom";
		engineSelect.value = "custom";
		saveSettings(state.settings);
	});

	const homepageSelect = document.getElementById("setting-homepage");
	const homepageRow = document.getElementById("homepage-row");
	const homepageInput = document.getElementById("setting-homepage-url");
	const homepageError = document.getElementById("homepage-error");
	homepageInput.addEventListener("keydown", (event) => {
		if (event.key === "Enter") event.preventDefault();
	});

	homepageSelect.addEventListener("change", () => {
		homepageRow.hidden = homepageSelect.value !== "custom";
		if (homepageSelect.value === "newtab") {
			state.settings.homePage = "newtab";
			homepageError.hidden = true;
			saveSettings(state.settings);
		} else if (isProxyableUrl(homepageInput.value.trim())) {
			state.settings.homePage = homepageInput.value.trim();
			homepageError.hidden = true;
			saveSettings(state.settings);
		} else {
			homepageInput.focus();
		}
	});

	homepageInput.addEventListener("input", () => {
		const value = homepageInput.value.trim();
		if (!value) {
			homepageError.hidden = true;
			return;
		}
		if (!isProxyableUrl(value)) {
			homepageError.textContent = "Enter a complete http or https address.";
			homepageError.hidden = false;
			return;
		}
		homepageError.hidden = true;
		state.settings.homePage = value;
		saveSettings(state.settings);
	});

	document
		.getElementById("setting-restore")
		.addEventListener("change", (event) => {
			state.settings.restoreSession = event.target.checked;
			saveSettings(state.settings);
			if (!event.target.checked) clearSession();
			else saveSessionNow();
		});

	zoomSelect.addEventListener("change", () => {
		state.settings.defaultZoom = Number(zoomSelect.value);
		saveSettings(state.settings);
	});

	document
		.getElementById("clear-history")
		.addEventListener("click", clearHistoryData);
	document.getElementById("clear-bookmarks").addEventListener("click", () => {
		if (state.bookmarks.length === 0) {
			toast("There are no bookmarks to clear.");
			return;
		}
		if (!window.confirm("Remove all bookmarks?")) return;
		state.bookmarks = [];
		clearBookmarks();
		updateBookmarkButton();
		renderBookmarksBar();
		renderNewTab();
		updateSettingsCounts();
		if (state.panelKind === "bookmarks") renderPanel();
		settingsFeedback("Bookmarks cleared.");
		toast("Bookmarks cleared.");
	});
	document.getElementById("reset-data").addEventListener("click", () => {
		if (
			!window.confirm(
				"Reset Horizon? This removes all tabs, history, bookmarks and settings from this browser."
			)
		)
			return;
		clearAllData();
		location.reload();
	});
	document.getElementById("export-data").addEventListener("click", exportData);
	document
		.getElementById("import-data")
		.addEventListener("click", () =>
			document.getElementById("import-file").click()
		);
	document
		.getElementById("import-file")
		.addEventListener("change", importDataFile);

	document.getElementById("proxy-retry").addEventListener("click", () => {
		state.proxy.ready = false;
		state.proxy.error = null;
		proxyPromise = null;
		updateProxyBadge();
		updateProxyStatusText();
		ensureProxy()
			.then(() => {
				settingsFeedback("Proxy reconnected.");
				toast("Proxy reconnected.");
				updateProxyStatusText();
			})
			.catch(() => {
				settingsFeedback("Could not reconnect to the proxy.");
				toast("Could not reconnect to the proxy.", "error");
				updateProxyStatusText();
			});
	});
}

function populateSettingsForm() {
	const feedback = document.getElementById("settings-feedback");
	if (feedback) feedback.hidden = true;
	for (const radio of dom.settingsForm.querySelectorAll(
		'input[name="theme"]'
	)) {
		radio.checked = radio.value === state.settings.theme;
	}
	document.getElementById("setting-bookmarks-bar").checked =
		state.settings.showBookmarksBar;
	document.getElementById("setting-restore").checked =
		state.settings.restoreSession;
	document.getElementById("setting-zoom").value = String(
		state.settings.defaultZoom
	);

	const engineSelect = document.getElementById("setting-search-engine");
	engineSelect.value = state.settings.searchEngine;
	const customRow = document.getElementById("custom-engine-row");
	const customInput = document.getElementById("setting-custom-engine");
	customRow.hidden = state.settings.searchEngine !== "custom";
	customInput.value = state.settings.customSearchTemplate || "";
	document.getElementById("custom-engine-error").hidden = true;

	const homepageSelect = document.getElementById("setting-homepage");
	const homepageRow = document.getElementById("homepage-row");
	const homepageInput = document.getElementById("setting-homepage-url");
	const customHome = state.settings.homePage !== "newtab";
	homepageSelect.value = customHome ? "custom" : "newtab";
	homepageRow.hidden = !customHome;
	homepageInput.value = customHome ? state.settings.homePage : "";
	document.getElementById("homepage-error").hidden = true;

	updateSettingsCounts();
	updateProxyStatusText();
}

function settingsFeedback(message) {
	const node = document.getElementById("settings-feedback");
	if (!node) return;
	node.textContent = message;
	node.hidden = false;
	clearTimeout(state.settingsFeedbackTimer);
	state.settingsFeedbackTimer = setTimeout(() => {
		node.hidden = true;
	}, 3500);
}

function updateSettingsCounts() {
	const historyCount = document.getElementById("history-count");
	const bookmarkCount = document.getElementById("bookmark-count");
	if (historyCount) {
		historyCount.textContent =
			state.history.length === 0
				? "No visits recorded."
				: `${state.history.length} ${state.history.length === 1 ? "visit" : "visits"} recorded.`;
	}
	if (bookmarkCount) {
		bookmarkCount.textContent =
			state.bookmarks.length === 0
				? "No bookmarks saved."
				: `${state.bookmarks.length} ${state.bookmarks.length === 1 ? "bookmark" : "bookmarks"} saved.`;
	}
}

function openSettings(section) {
	if (state.panelKind) closePanel();
	populateSettingsForm();
	if (typeof dom.settingsDialog.showModal === "function") {
		dom.settingsDialog.showModal();
	}
	if (section) {
		const target = document.getElementById(section);
		target?.scrollIntoView({ block: "start" });
	}
}

function exportData() {
	const payload = {
		app: "Horizon Browser",
		version: VERSION,
		exportedAt: new Date().toISOString(),
		settings: state.settings,
		bookmarks: state.bookmarks,
		history: state.history,
	};
	const blob = new Blob([JSON.stringify(payload, null, 2)], {
		type: "application/json",
	});
	const url = URL.createObjectURL(blob);
	const link = document.createElement("a");
	link.href = url;
	link.download = `horizon-backup-${new Date().toISOString().slice(0, 10)}.json`;
	document.body.append(link);
	link.click();
	link.remove();
	setTimeout(() => URL.revokeObjectURL(url), 2000);
	settingsFeedback("Exported your Horizon data.");
	toast("Exported your Horizon data.");
}

async function importDataFile(event) {
	const file = event.target.files?.[0];
	event.target.value = "";
	if (!file) return;
	try {
		const data = JSON.parse(await file.text());
		if (!data || typeof data !== "object") throw new Error("Invalid file.");
		if (
			!window.confirm(
				"Replace your current bookmarks, history and preferences with this file?"
			)
		)
			return;

		state.bookmarks = sanitizeBookmarks(data.bookmarks);
		state.history = sanitizeHistory(data.history);
		state.settings = sanitizeSettings({
			...state.settings,
			...(data.settings && typeof data.settings === "object"
				? data.settings
				: {}),
		});
		saveBookmarks(state.bookmarks);
		saveHistory(state.history);
		saveSettings(state.settings);
		applyTheme();
		if (!state.settings.restoreSession) clearSession();
		else saveSessionNow();
		populateSettingsForm();
		renderBookmarksBar();
		renderNewTab();
		updateBookmarkButton();
		updateToolbar();
		if (state.panelKind) renderPanel();
		settingsFeedback("Import complete.");
		toast("Import complete.");
	} catch (error) {
		settingsFeedback(`Import failed: ${error.message || error}`);
		toast(`Import failed: ${error.message || error}`);
	}
}

// ---------------------------------------------------------------------------
// Menus, find, dialogs

function positionFloatingMenu(menuEl, anchor) {
	const rect = anchor.getBoundingClientRect();
	menuEl.hidden = false;
	const menuRect = menuEl.getBoundingClientRect();
	const top = Math.min(
		rect.bottom + 6,
		window.innerHeight - menuRect.height - 8
	);
	const right = Math.min(
		Math.max(8, window.innerWidth - rect.right),
		Math.max(8, window.innerWidth - menuRect.width - 8)
	);
	menuEl.style.top = `${Math.max(8, top)}px`;
	menuEl.style.right = `${right}px`;
}

function toggleMenu() {
	if (!dom.menu.hidden) {
		closeMenu();
		return;
	}
	closeTabMenu();
	positionFloatingMenu(dom.menu, dom.menuToggle);
	dom.menuToggle.setAttribute("aria-expanded", "true");
	const fullscreenItem = dom.menu.querySelector(
		'[data-action="fullscreen"] span'
	);
	if (fullscreenItem) {
		fullscreenItem.textContent = document.fullscreenElement
			? "Exit fullscreen"
			: "Fullscreen";
	}
}

function closeMenu() {
	dom.menu.hidden = true;
	dom.menuToggle.setAttribute("aria-expanded", "false");
}

function openTabMenu(event, tab) {
	closeMenu();
	dom.tabMenu.replaceChildren();
	const actions = [
		{ label: "Reload", action: () => (activateTab(tab.id), reloadTab(tab)) },
		{ label: "Duplicate", action: () => duplicateTab(tab.id) },
		{
			label: isBookmarked(tab.url) ? "Remove bookmark" : "Bookmark this page",
			action: () => {
				activateTab(tab.id);
				toggleBookmark();
			},
			hidden: !tab.url,
		},
		{ label: "Close other tabs", action: () => closeOtherTabs(tab.id) },
		{ label: "Close tab", action: () => closeTab(tab.id), danger: true },
	];

	for (const item of actions) {
		if (item.hidden) continue;
		const button = element(
			"button",
			`menu-item${item.danger ? " danger" : ""}`
		);
		button.type = "button";
		button.setAttribute("role", "menuitem");
		button.append(element("span", "", item.label));
		button.addEventListener("click", () => {
			closeTabMenu();
			item.action();
		});
		dom.tabMenu.append(button);
	}

	dom.tabMenu.style.top = `${Math.max(8, Math.min(event.clientY, window.innerHeight - 220))}px`;
	dom.tabMenu.style.left = `${Math.max(8, Math.min(event.clientX, window.innerWidth - 230))}px`;
	dom.tabMenu.hidden = false;
}

function closeTabMenu() {
	dom.tabMenu.hidden = true;
}

function openFind() {
	if (state.panelKind) closePanel();
	const tab = activeTab();
	if (!tab || tab.home) {
		toast("Open a web page to search within it.");
		return;
	}
	state.findOpen = true;
	dom.findBar.hidden = false;
	dom.findInput.value = state.findQuery;
	requestAnimationFrame(() => {
		dom.findInput.focus();
		dom.findInput.select();
	});
}

function closeFind() {
	state.findOpen = false;
	dom.findBar.hidden = true;
	dom.findStatus.textContent = "";
	dom.findStatus.classList.remove("no-match");
}

function performFind(backwards = false) {
	const tab = activeTab();
	const query = dom.findInput.value;
	state.findQuery = query;
	if (!tab?.frame || !query) {
		dom.findStatus.textContent = "";
		return;
	}
	try {
		const found = tab.frame.contentWindow.find(query, false, backwards, true);
		dom.findStatus.textContent = found ? "Found" : "No matches";
		dom.findStatus.classList.toggle("no-match", !found);
	} catch {
		dom.findStatus.textContent = "Unavailable";
		dom.findStatus.classList.add("no-match");
	}
}

function renderShortcuts() {
	dom.shortcutsBody.replaceChildren();
	const groups = [
		{
			title: "Navigation",
			items: [
				["Focus address bar: ", ["Ctrl", "L"]],
				["Back: ", ["Alt", "←"]],
				["Forward: ", ["Alt", "→"]],
				["Reload: ", ["Ctrl", "R"]],
				["Home: ", ["Alt", "Home"]],
				["Find in page: ", ["Ctrl", "F"]],
			],
		},
		{
			title: "Tabs",
			items: [
				["New tab: ", ["Ctrl", "T"]],
				["Close tab: ", ["Ctrl", "W"]],
				["Reopen closed tab: ", ["Ctrl", "Shift", "T"]],
				["Next tab: ", ["Ctrl", "Tab"]],
				["Previous tab: ", ["Ctrl", "Shift", "Tab"]],
				["Switch to tab 1–9: ", ["Ctrl", "1…9"]],
			],
		},
		{
			title: "Page",
			items: [
				["Bookmark page: ", ["Ctrl", "D"]],
				["Open history: ", ["Ctrl", "H"]],
				["Toggle bookmarks bar: ", ["Ctrl", "Shift", "B"]],
				["Zoom in: ", ["Ctrl", "+"]],
				["Zoom out: ", ["Ctrl", "−"]],
				["Reset zoom: ", ["Ctrl", "0"]],
				["Fullscreen: ", ["F11"]],
			],
		},
	];

	for (const group of groups) {
		const wrapper = element("div", "shortcut-group");
		wrapper.append(element("h3", "", group.title));
		for (const [label, keys] of group.items) {
			const row = element("div", "shortcut-row");
			row.append(element("span", "", label));
			const keyWrap = element("span", "shortcut-keys");
			keys.forEach((key, index) => {
				if (index > 0) keyWrap.append(element("span", "shortcut-plus", "+"));
				keyWrap.append(element("kbd", "", key));
			});
			row.append(keyWrap);
			wrapper.append(row);
		}
		dom.shortcutsBody.append(wrapper);
	}
}

function toggleFullscreen() {
	if (document.fullscreenElement) {
		document.exitFullscreen?.().catch(() => {});
	} else {
		dom.html.requestFullscreen?.().catch(() => {
			toast("Fullscreen isn't available in this browser.", "error");
		});
	}
}

// ---------------------------------------------------------------------------
// Session persistence

function saveSessionSoon() {
	clearTimeout(state.saveTimer);
	state.saveTimer = setTimeout(saveSessionNow, 400);
}

function saveSessionNow() {
	if (!state.settings.restoreSession) {
		clearSession();
		return;
	}
	const payload = {
		activeTabId: state.activeId,
		tabs: state.tabs.map((tab) => ({
			id: tab.id,
			url: tab.url,
			title: tab.title,
			favicon: tab.favicon,
			entries: tab.entries.slice(-60),
			index: tab.index,
			zoom: tab.zoom,
			home: tab.home,
		})),
	};
	saveSession(payload);
}

// ---------------------------------------------------------------------------
// Toasts and global events

function toast(message, kind = "success") {
	const node = element("div", `toast ${kind}`);
	node.append(
		icon(kind === "error" ? "i-alert" : "i-check"),
		element("span", "", message)
	);
	dom.toasts.append(node);
	while (dom.toasts.children.length > 3) {
		dom.toasts.firstElementChild?.remove();
	}
	setTimeout(() => {
		node.classList.add("leaving");
		setTimeout(() => node.remove(), 220);
	}, 2600);
}

function isEditable(target) {
	return (
		target instanceof HTMLElement &&
		(target.isContentEditable ||
			target.tagName === "INPUT" ||
			target.tagName === "TEXTAREA" ||
			target.tagName === "SELECT")
	);
}

function handleGlobalKeydown(event) {
	const mod = event.ctrlKey || event.metaKey;
	const key = event.key.toLowerCase();

	if (
		(dom.settingsDialog.open || dom.shortcutsDialog.open) &&
		key !== "escape"
	) {
		return;
	}

	if (mod && key === "l") {
		event.preventDefault();
		focusAddress();
		return;
	}
	if (mod && key === "t" && !event.shiftKey) {
		event.preventDefault();
		createTab({ activate: true, focusAddress: true });
		return;
	}
	if (mod && event.shiftKey && key === "t") {
		event.preventDefault();
		reopenClosedTab();
		return;
	}
	if (mod && key === "w") {
		event.preventDefault();
		if (state.activeId) closeTab(state.activeId);
		return;
	}
	if (mod && key === "r") {
		event.preventDefault();
		reloadTab();
		return;
	}
	if (mod && key === "d") {
		event.preventDefault();
		toggleBookmark();
		return;
	}
	if (mod && key === "f") {
		event.preventDefault();
		openFind();
		return;
	}
	if (mod && key === "h") {
		event.preventDefault();
		openPanel("history");
		return;
	}
	if (mod && event.shiftKey && key === "b") {
		event.preventDefault();
		state.settings.showBookmarksBar = !state.settings.showBookmarksBar;
		saveSettings(state.settings);
		renderBookmarksBar();
		toast(
			state.settings.showBookmarksBar
				? "Bookmarks bar shown."
				: "Bookmarks bar hidden."
		);
		return;
	}
	if (mod && (key === "+" || key === "=")) {
		event.preventDefault();
		setZoom("in");
		return;
	}
	if (mod && key === "-") {
		event.preventDefault();
		setZoom("out");
		return;
	}
	if (mod && key === "0") {
		event.preventDefault();
		setZoom("reset");
		return;
	}
	if (mod && /^[1-9]$/.test(key)) {
		event.preventDefault();
		const index = Number(key) - 1;
		selectTabByIndex(index === 8 ? state.tabs.length - 1 : index);
		return;
	}
	if (event.ctrlKey && key === "tab") {
		event.preventDefault();
		selectRelativeTab(event.shiftKey ? -1 : 1);
		return;
	}
	if (event.altKey && key === "arrowleft") {
		event.preventDefault();
		goBack();
		return;
	}
	if (event.altKey && key === "arrowright") {
		event.preventDefault();
		goForward();
		return;
	}
	if (event.altKey && key === "home") {
		event.preventDefault();
		goHome();
		return;
	}
	if (key === "f5") {
		event.preventDefault();
		reloadTab();
		return;
	}
	if (key === "f6") {
		event.preventDefault();
		focusAddress();
		return;
	}
	if (key === "f11") {
		event.preventDefault();
		toggleFullscreen();
		return;
	}
	if (key === "escape") {
		if (!dom.tabMenu.hidden) {
			closeTabMenu();
			return;
		}
		if (!dom.menu.hidden) {
			closeMenu();
			return;
		}
		if (!dom.suggestions.hidden) {
			closeSuggestions();
			dom.address.blur();
			return;
		}
		if (state.findOpen) {
			closeFind();
			return;
		}
		if (state.panelKind) {
			closePanel();
			return;
		}
		if (dom.settingsDialog.open) {
			dom.settingsDialog.close();
			return;
		}
		if (dom.shortcutsDialog.open) {
			dom.shortcutsDialog.close();
		}
	}
}

function goHome() {
	const tab = activeTab();
	if (!tab) {
		createTab({ activate: true, focusAddress: true });
		return;
	}
	if (
		state.settings.homePage !== "newtab" &&
		isProxyableUrl(state.settings.homePage)
	) {
		loadTab(tab, state.settings.homePage);
		return;
	}
	showHomeTab(tab);
}

function showHomeTab(tab) {
	if (tab.url) {
		tab.homeReturn = { url: tab.url, title: tab.title };
	}
	tab.home = true;
	tab.url = null;
	tab.error = null;
	tab.loading = false;
	tab.slow = false;
	tab.title = "New Tab";
	tab.favicon = null;
	tab.faviconCandidates = [];
	tab.navSeq += 1;
	tab.lastDeepSync = 0;
	clearTabTimers(tab);
	try {
		tab.frame?.contentWindow?.stop();
	} catch {
		// The frame may not have navigated yet.
	}
	closeFind();
	renderTabs();
	refreshActiveUI();
	updateToolbar();
	saveSessionSoon();
}

// ---------------------------------------------------------------------------
// Event wiring

function bindEvents() {
	dom.newTab.addEventListener("click", () =>
		createTab({ activate: true, focusAddress: true })
	);
	dom.back.addEventListener("click", () => goBack());
	dom.forward.addEventListener("click", () => goForward());
	dom.reload.addEventListener("click", () => reloadTab());
	dom.home.addEventListener("click", goHome);
	dom.bookmarkToggle.addEventListener("click", toggleBookmark);
	dom.menuToggle.addEventListener("click", (event) => {
		event.stopPropagation();
		toggleMenu();
	});

	dom.addressForm.addEventListener("submit", (event) => {
		event.preventDefault();
		const value = dom.address.value;
		closeSuggestions();
		dom.address.blur();
		navigateInput(value);
	});

	dom.address.addEventListener("focus", () => {
		state.lastFocusWasAddress = true;
		dom.address.select();
	});

	dom.address.addEventListener("input", updateAddressSuggestions);

	dom.address.addEventListener("keydown", (event) => {
		if (event.key === "ArrowDown") {
			if (dom.suggestions.hidden) updateAddressSuggestions();
			if (!dom.suggestions.hidden) {
				event.preventDefault();
				setSuggestionIndex(state.suggestionIndex + 1);
			}
		} else if (event.key === "ArrowUp") {
			if (!dom.suggestions.hidden) {
				event.preventDefault();
				setSuggestionIndex(state.suggestionIndex - 1);
			}
		} else if (event.key === "Enter") {
			if (!dom.suggestions.hidden && state.suggestionIndex >= 0) {
				event.preventDefault();
				chooseSuggestion(state.suggestionIndex);
			}
		} else if (event.key === "Escape") {
			closeSuggestions();
			dom.address.blur();
		}
	});

	dom.address.addEventListener("blur", () => {
		setTimeout(() => {
			if (document.activeElement !== dom.address) closeSuggestions();
			const tab = activeTab();
			if (!tab) return;
			dom.address.value = tab.home ? "" : tab.url || "";
			dom.addressClear.hidden = !dom.address.value;
		}, 130);
	});

	dom.addressClear.addEventListener("click", () => {
		dom.address.value = "";
		dom.addressClear.hidden = true;
		closeSuggestions();
		dom.address.focus();
	});

	dom.ntSearch.addEventListener("submit", (event) => {
		event.preventDefault();
		const value = dom.ntInput.value;
		if (!value.trim()) return;
		dom.ntInput.value = "";
		navigateInput(value);
	});

	document
		.getElementById("nt-settings")
		.addEventListener("click", () => openSettings());
	document
		.getElementById("nt-shortcuts-help")
		.addEventListener("click", () => dom.shortcutsDialog.showModal());

	document.querySelectorAll("[data-open-panel]").forEach((button) => {
		button.addEventListener("click", () => openPanel(button.dataset.openPanel));
	});

	dom.panelClose.addEventListener("click", closePanel);
	dom.scrim.addEventListener("click", closePanel);
	dom.panelFilter.addEventListener("input", renderPanel);
	dom.panelPrimary.addEventListener("click", addCurrentBookmark);
	dom.panelClear.addEventListener("click", clearHistoryData);

	dom.errorRetry.addEventListener("click", () => {
		const tab = activeTab();
		if (tab?.url) loadTab(tab, tab.url, { skipEntry: true });
		else goHome();
	});
	dom.errorHome.addEventListener("click", goHome);
	dom.slowStop.addEventListener("click", () => stopLoading());
	dom.slowRetry.addEventListener("click", () => {
		const tab = activeTab();
		if (tab?.url) loadTab(tab, tab.url, { skipEntry: true });
		else reloadTab();
	});

	dom.findInput.addEventListener("input", () => performFind(false));
	dom.findInput.addEventListener("keydown", (event) => {
		if (event.key === "Enter") {
			event.preventDefault();
			performFind(event.shiftKey);
		} else if (event.key === "Escape") {
			event.preventDefault();
			closeFind();
		}
	});
	dom.findNext.addEventListener("click", () => performFind(false));
	dom.findPrev.addEventListener("click", () => performFind(true));
	dom.findClose.addEventListener("click", closeFind);

	dom.menu.addEventListener("click", (event) => {
		const button = event.target.closest("button");
		if (!button) return;
		closeMenu();
		if (button.dataset.panel) {
			openPanel(button.dataset.panel);
			return;
		}
		switch (button.dataset.action) {
			case "new-tab":
				createTab({ activate: true, focusAddress: true });
				break;
			case "home":
				goHome();
				break;
			case "bookmark":
				toggleBookmark();
				break;
			case "find":
				openFind();
				break;
			case "zoom-in":
				setZoom("in");
				break;
			case "zoom-out":
				setZoom("out");
				break;
			case "zoom-reset":
				setZoom("reset");
				break;
			case "fullscreen":
				toggleFullscreen();
				break;
			case "shortcuts":
				renderShortcuts();
				dom.shortcutsDialog.showModal();
				break;
			case "settings":
				openSettings();
				break;
		}
	});

	document.addEventListener("click", (event) => {
		if (
			!dom.menu.hidden &&
			!dom.menu.contains(event.target) &&
			event.target !== dom.menuToggle
		) {
			closeMenu();
		}
		if (!dom.tabMenu.hidden && !dom.tabMenu.contains(event.target)) {
			closeTabMenu();
		}
	});

	document.addEventListener("keydown", handleGlobalKeydown);

	window.addEventListener("online", () => {
		dom.offlineBanner.hidden = true;
		if (state.proxy.error) {
			state.proxy.error = null;
			proxyPromise = null;
			ensureProxy().catch(() => {});
		}
		updateProxyBadge();
		toast("You're back online.");
	});
	window.addEventListener("offline", () => {
		dom.offlineBanner.hidden = false;
		updateProxyBadge();
	});

	window.addEventListener("beforeunload", saveSessionNow);

	document.addEventListener("fullscreenchange", () => {
		const fullscreenItem = dom.menu.querySelector(
			'[data-action="fullscreen"] span'
		);
		if (fullscreenItem) {
			fullscreenItem.textContent = document.fullscreenElement
				? "Exit fullscreen"
				: "Fullscreen";
		}
	});

	window.addEventListener("resize", () => {
		updateTabSizing();
		if (!dom.menu.hidden) positionFloatingMenu(dom.menu, dom.menuToggle);
	});
}

// ---------------------------------------------------------------------------
// Boot

function boot() {
	applyTheme();
	buildSettingsForm();
	populateSettingsForm();
	renderShortcuts();

	if (!navigator.onLine) dom.offlineBanner.hidden = false;

	const session = state.settings.restoreSession ? loadSession() : null;
	if (session) {
		restoreTabs(session);
	} else {
		createTab({ activate: true });
	}

	renderBookmarksBar();
	updateProxyBadge();
	updateProxyStatusText();
	ensureProxy().catch(() => {
		// The badge and navigation errors surface the failure.
	});

	state.frameTimer = setInterval(() => {
		const tab = activeTab();
		if (tab && !tab.home && tab.frame) syncTabFromFrame(tab);
	}, 800);
}

bindEvents();
boot();
