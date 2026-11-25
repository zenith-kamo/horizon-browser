/**
 * Persistence helpers. Every access to localStorage is guarded so private
 * modes or storage quota errors cannot break the browser UI.
 */

import { SEARCH_ENGINES, isProxyableUrl } from "./url.js";

export const STORAGE_KEYS = {
	settings: "horizon.settings.v1",
	bookmarks: "horizon.bookmarks.v1",
	history: "horizon.history.v1",
	session: "horizon.session.v1",
};

export const DEFAULT_SETTINGS = {
	theme: "system",
	searchEngine: "google",
	customSearchTemplate: "",
	homePage: "newtab",
	restoreSession: true,
	showBookmarksBar: true,
	defaultZoom: 100,
};

const MAX_HISTORY = 500;
const MAX_BOOKMARKS = 500;
const MAX_SESSION_TABS = 20;
const MAX_TAB_ENTRIES = 60;

export function uid() {
	if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function readJSON(key) {
	try {
		const raw = localStorage.getItem(key);
		if (!raw) return null;
		return JSON.parse(raw);
	} catch (error) {
		console.warn(`[horizon] Could not read ${key}`, error);
		return null;
	}
}

function writeJSON(key, value) {
	try {
		localStorage.setItem(key, JSON.stringify(value));
		return true;
	} catch (error) {
		console.warn(`[horizon] Could not write ${key}`, error);
		return false;
	}
}

function safeString(value, fallback = "") {
	return typeof value === "string" ? value : fallback;
}

function safeTimestamp(value, fallback = Date.now()) {
	return Number.isFinite(value) ? value : fallback;
}

// ---------------------------------------------------------------------------
// Settings

export function loadSettings() {
	const stored = readJSON(STORAGE_KEYS.settings);
	return sanitizeSettings(stored);
}

export function sanitizeSettings(input) {
	const source = input && typeof input === "object" ? input : {};
	const settings = { ...DEFAULT_SETTINGS };

	if (["system", "dark", "light"].includes(source.theme)) {
		settings.theme = source.theme;
	}
	if (
		typeof source.searchEngine === "string" &&
		SEARCH_ENGINES.some((engine) => engine.id === source.searchEngine)
	) {
		settings.searchEngine = source.searchEngine;
	}
	if (typeof source.customSearchTemplate === "string") {
		settings.customSearchTemplate = source.customSearchTemplate;
	}
	if (source.homePage === "newtab" || isProxyableUrl(source.homePage)) {
		settings.homePage = source.homePage;
	}
	if (typeof source.restoreSession === "boolean") {
		settings.restoreSession = source.restoreSession;
	}
	if (typeof source.showBookmarksBar === "boolean") {
		settings.showBookmarksBar = source.showBookmarksBar;
	}
	const zoom = Number(source.defaultZoom);
	if (Number.isFinite(zoom)) {
		settings.defaultZoom = Math.min(
			200,
			Math.max(50, Math.round(zoom / 10) * 10)
		);
	}

	return settings;
}

export function saveSettings(settings) {
	return writeJSON(STORAGE_KEYS.settings, settings);
}

// ---------------------------------------------------------------------------
// Bookmarks

export function loadBookmarks() {
	return sanitizeBookmarks(readJSON(STORAGE_KEYS.bookmarks));
}

export function sanitizeBookmarks(input) {
	if (!Array.isArray(input)) return [];
	const seen = new Set();
	const bookmarks = [];
	for (const item of input) {
		if (!item || typeof item !== "object") continue;
		if (!isProxyableUrl(item.url)) continue;
		if (seen.has(item.url)) continue;
		seen.add(item.url);
		bookmarks.push({
			id: safeString(item.id) || uid(),
			title: safeString(item.title).slice(0, 300) || item.url,
			url: item.url,
			favicon: isSafeIcon(item.favicon) ? item.favicon : null,
			createdAt: safeTimestamp(item.createdAt),
		});
		if (bookmarks.length >= MAX_BOOKMARKS) break;
	}
	return bookmarks;
}

export function saveBookmarks(bookmarks) {
	return writeJSON(STORAGE_KEYS.bookmarks, bookmarks.slice(0, MAX_BOOKMARKS));
}

// ---------------------------------------------------------------------------
// History

export function loadHistory() {
	return sanitizeHistory(readJSON(STORAGE_KEYS.history));
}

export function sanitizeHistory(input) {
	if (!Array.isArray(input)) return [];
	const history = [];
	for (const item of input) {
		if (!item || typeof item !== "object") continue;
		if (!isProxyableUrl(item.url)) continue;
		history.push({
			id: safeString(item.id) || uid(),
			title: safeString(item.title).slice(0, 300) || item.url,
			url: item.url,
			favicon: isSafeIcon(item.favicon) ? item.favicon : null,
			visitedAt: safeTimestamp(item.visitedAt),
		});
		if (history.length >= MAX_HISTORY) break;
	}
	return history;
}

export function saveHistory(history) {
	return writeJSON(STORAGE_KEYS.history, history.slice(0, MAX_HISTORY));
}

// ---------------------------------------------------------------------------
// Session

export function loadSession() {
	const session = readJSON(STORAGE_KEYS.session);
	if (!session || typeof session !== "object") return null;
	if (!Array.isArray(session.tabs) || session.tabs.length === 0) return null;

	const tabs = session.tabs
		.slice(0, MAX_SESSION_TABS)
		.map(sanitizeSessionTab)
		.filter(Boolean);
	if (tabs.length === 0) return null;

	const activeTabId = tabs.some((tab) => tab.id === session.activeTabId)
		? session.activeTabId
		: tabs[0].id;

	return { activeTabId, tabs };
}

function sanitizeSessionTab(input) {
	if (!input || typeof input !== "object") return null;

	const entries = Array.isArray(input.entries)
		? input.entries
				.filter((entry) => entry && isProxyableUrl(entry.url))
				.slice(-MAX_TAB_ENTRIES)
				.map((entry) => ({
					url: entry.url,
					title: safeString(entry.title) || entry.url,
				}))
		: [];

	let index = Number.isInteger(input.index) ? input.index : entries.length - 1;
	if (index < 0 || index >= entries.length) index = entries.length - 1;

	let url = isProxyableUrl(input.url) ? input.url : null;
	if (url && entries.length === 0) {
		entries.push({ url, title: safeString(input.title) || url });
		index = 0;
	}

	const zoom = Number(input.zoom);
	return {
		id: safeString(input.id) || uid(),
		url,
		title: safeString(input.title).slice(0, 300) || (url ? url : "New Tab"),
		favicon: isSafeIcon(input.favicon) ? input.favicon : null,
		entries,
		index,
		zoom: Number.isFinite(zoom)
			? Math.min(200, Math.max(50, Math.round(zoom)))
			: null,
		home: !url,
	};
}

export function saveSession(session) {
	return writeJSON(STORAGE_KEYS.session, session);
}

export function clearHistory() {
	try {
		localStorage.removeItem(STORAGE_KEYS.history);
	} catch {
		// Ignore.
	}
}

export function clearBookmarks() {
	try {
		localStorage.removeItem(STORAGE_KEYS.bookmarks);
	} catch {
		// Ignore.
	}
}

export function clearSession() {
	try {
		localStorage.removeItem(STORAGE_KEYS.session);
	} catch {
		// Ignore.
	}
}

export function clearAllData() {
	try {
		for (const key of Object.values(STORAGE_KEYS)) {
			localStorage.removeItem(key);
		}
		localStorage.removeItem("horizon.closedTabs.v1");
	} catch {
		// Ignore.
	}
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
