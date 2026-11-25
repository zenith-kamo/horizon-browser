/**
 * Address parsing and proxy URL helpers.
 *
 * Kept free of DOM access so the behaviour can be tested with Node.
 */

export const SEARCH_ENGINES = [
	{
		id: "google",
		name: "Google",
		template: "https://www.google.com/search?q=%s",
	},
	{
		id: "duckduckgo",
		name: "DuckDuckGo",
		template: "https://duckduckgo.com/?q=%s",
	},
	{
		id: "bing",
		name: "Bing",
		template: "https://www.bing.com/search?q=%s",
	},
	{
		id: "brave",
		name: "Brave Search",
		template: "https://search.brave.com/search?q=%s",
	},
	{
		id: "startpage",
		name: "Startpage",
		template: "https://www.startpage.com/sp/search?query=%s",
	},
	{
		id: "ecosia",
		name: "Ecosia",
		template: "https://www.ecosia.org/search?q=%s",
	},
	{
		id: "custom",
		name: "Custom",
		template: "",
	},
];

const HTTP_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * Resolve the search template selected in settings.
 * @param {{searchEngine?: string, customSearchTemplate?: string}} settings
 * @returns {string}
 */
export function getSearchTemplate(settings = {}) {
	const engine = SEARCH_ENGINES.find(
		(item) => item.id === settings.searchEngine
	);
	if (engine && engine.id !== "custom") return engine.template;

	const custom = String(settings.customSearchTemplate || "").trim();
	return isValidSearchTemplate(custom) ? custom : SEARCH_ENGINES[0].template;
}

/**
 * @param {string} template
 * @returns {boolean}
 */
export function isValidSearchTemplate(template) {
	if (typeof template !== "string" || !template.includes("%s")) return false;
	try {
		const url = new URL(template.replace("%s", "horizon"));
		return HTTP_PROTOCOLS.has(url.protocol);
	} catch {
		return false;
	}
}

/**
 * @param {string} query
 * @param {string} template
 * @returns {string}
 */
export function buildSearchUrl(query, template) {
	const trimmed = String(query).trim();
	return template.split("%s").join(encodeURIComponent(trimmed));
}

/**
 * @param {string} value
 * @returns {boolean}
 */
export function hasExplicitProtocol(value) {
	return /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(value);
}

/**
 * Whether an address is safe and useful to load through the proxy.
 * @param {string} value
 * @returns {boolean}
 */
export function isProxyableUrl(value) {
	try {
		return HTTP_PROTOCOLS.has(new URL(value).protocol);
	} catch {
		return false;
	}
}

/**
 * Parse user input into a navigation target.
 *
 * Supported:
 *  - full http(s) URLs
 *  - schemeless domains, IP addresses, localhost and host:port
 *  - search queries for everything else
 *
 * @param {string} input
 * @param {string} searchTemplate
 * @returns {{kind: "url" | "search", url: string, query?: string} | null}
 */
export function parseAddress(input, searchTemplate) {
	const value = String(input ?? "").trim();
	if (!value) return null;

	// host:port must be checked before explicit protocols because
	// "localhost:8080" would otherwise look like the "localhost:" scheme.
	const hostPort = /^([a-zA-Z\d.-]+|\[[a-fA-F\d:]+\]):(\d{1,5})(\/.*)?$/.exec(
		value
	);
	if (hostPort) {
		try {
			const url = new URL(`http://${value}`);
			if (isPlausibleHost(url.hostname)) {
				return { kind: "url", url: url.toString() };
			}
		} catch {
			// Fall through.
		}
	}

	if (hasExplicitProtocol(value)) {
		try {
			const url = new URL(value);
			if (HTTP_PROTOCOLS.has(url.protocol)) {
				return { kind: "url", url: url.toString() };
			}
		} catch {
			// Fall through to search. Unsupported schemes are never executed.
		}
		return asSearch(value, searchTemplate);
	}

	// Protocol-relative input such as //example.com
	if (value.startsWith("//")) {
		try {
			const url = new URL(`https:${value}`);
			if (url.hostname) return { kind: "url", url: url.toString() };
		} catch {
			// Fall through.
		}
	}

	// host:port (but not a hostname ending in a number without a dot)

	try {
		const url = new URL(`http://${value}`);
		if (isPlausibleHost(url.hostname)) {
			if (!isLocalHost(url.hostname) && !url.port) {
				url.protocol = "https:";
			}
			return { kind: "url", url: url.toString() };
		}
	} catch {
		// Fall through to search.
	}

	return asSearch(value, searchTemplate);
}

/**
 * @param {string} query
 * @param {string} template
 */
function asSearch(query, template) {
	return {
		kind: "search",
		query,
		url: buildSearchUrl(query, template),
	};
}

/**
 * @param {string} hostname
 * @returns {boolean}
 */
function isLocalHost(hostname) {
	return (
		hostname === "localhost" ||
		/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) ||
		(hostname.startsWith("[") && hostname.endsWith("]"))
	);
}

function isPlausibleHost(hostname) {
	if (!hostname) return false;
	if (hostname === "localhost") return true;
	if (hostname.includes(".")) return true;
	// IPv4 and bracketed IPv6 hosts.
	if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return true;
	if (hostname.startsWith("[") && hostname.endsWith("]")) return true;
	return false;
}

/**
 * Does the input look like something the user intends as a URL?
 * Used for address bar suggestions.
 * @param {string} input
 * @returns {boolean}
 */
export function looksLikeUrl(input) {
	const value = String(input ?? "").trim();
	if (!value || (/\s/.test(value) && !/^https?:\/\//i.test(value)))
		return false;
	if (/^https?:\/\//i.test(value)) return true;
	if (value.startsWith("//")) return true;
	if (/^localhost(:\d+)?(\/|$)/i.test(value)) return true;
	if (/^(\d{1,3}\.){3}\d{1,3}(:\d+)?(\/|$)/.test(value)) return true;
	return /^[^\s/]+\.[^\s/]{2,}(\/|$|\?|#)/.test(value);
}

/**
 * Extract the original URL from a proxied iframe location.
 * @param {string} href
 * @param {string} prefix
 * @param {(value: string) => string} decode
 * @returns {string | null}
 */
export function extractProxyUrl(href, prefix, decode) {
	if (!href || !prefix || !href.includes(prefix)) return null;

	const index = href.indexOf(prefix);
	const encoded = href.slice(index + prefix.length).split("?")[0];
	if (!encoded) return null;

	const candidates = [];
	try {
		candidates.push(decode(encoded));
	} catch {
		// Try the percent-decoded form below.
	}
	try {
		candidates.push(decode(decodeURIComponent(encoded)));
	} catch {
		// Ignore malformed encodings.
	}

	for (const candidate of candidates) {
		if (candidate && isProxyableUrl(candidate)) return candidate;
	}
	return null;
}

/**
 * @param {string} url
 * @returns {string}
 */
export function hostFromUrl(url) {
	try {
		return new URL(url).hostname.replace(/^www\./, "");
	} catch {
		return "";
	}
}

/**
 * Friendly hostname shown on tabs, bookmarks and history rows.
 * @param {string} url
 * @returns {string}
 */
export function displayHost(url) {
	const host = hostFromUrl(url);
	return host || url;
}

/**
 * @param {string | null | undefined} url
 * @returns {string}
 */
export function initialForUrl(url) {
	const host = hostFromUrl(url || "");
	const source = host || String(url || "");
	const match = source.match(/[a-zA-Z0-9]/);
	return (match ? match[0] : "?").toUpperCase();
}

/**
 * Stable hue for a site tile.
 * @param {string} value
 * @returns {number}
 */
export function hueFor(value) {
	let hash = 0;
	for (let i = 0; i < value.length; i++) {
		hash = (hash * 31 + value.charCodeAt(i)) | 0;
	}
	return Math.abs(hash) % 360;
}
