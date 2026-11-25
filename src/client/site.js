"use strict";

/**
 * Delayed content loader for the public page.
 *
 * The build command writes Base64, UTF-8 encoded HTML documents to
 * sites/index and sites/credits. After the delay configured on the page, this
 * script fetches the matching payload, decodes it, and either replaces the
 * article body (fragment) or replaces the document (a complete HTML page).
 */
(() => {
	const page = document.documentElement;
	const CONTENT_URL = page.dataset.contentUrl?.trim() || "sites/index";
	const delayValue = page.dataset.contentDelay;
	const parsedDelay = delayValue === undefined ? 5000 : Number(delayValue);
	const START_DELAY_MS =
		Number.isFinite(parsedDelay) && parsedDelay >= 0 ? parsedDelay : 5000;
	const FETCH_TIMEOUT_MS = 12000;

	const status = document.getElementById("load-status");
	const statusText = document.getElementById("load-status-text");
	const retryButton = document.getElementById("load-retry");

	let loading = false;
	let started = false;

	function setStatus(message, { error = false, retry = false } = {}) {
		if (!status || !statusText) return;
		statusText.textContent = message;
		status.hidden = false;
		status.classList.toggle("is-error", error);
		if (retryButton) retryButton.hidden = !retry;
	}

	function hideStatus() {
		if (status) status.hidden = true;
	}

	function decodeBase64Utf8(value) {
		const compact = value.replace(/\s+/g, "");
		if (!compact) throw new Error("The content file is empty.");
		if (compact.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) {
			throw new Error("The content file is not valid Base64.");
		}

		const binary = atob(compact);
		const bytes = new Uint8Array(binary.length);
		for (let index = 0; index < binary.length; index += 1) {
			bytes[index] = binary.charCodeAt(index);
		}

		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	}

	function isCompleteDocument(html, parsed) {
		return (
			/<(?:!doctype\s+html|html[\s>])/i.test(html) ||
			Boolean(parsed.head.querySelector("title, link[rel='stylesheet']"))
		);
	}

	function sanitizeFragment(root) {
		root
			.querySelectorAll("script, iframe, object, embed, base, meta")
			.forEach((node) => node.remove());

		root.querySelectorAll("*").forEach((element) => {
			for (const attribute of [...element.attributes]) {
				if (/^on/i.test(attribute.name)) {
					element.removeAttribute(attribute.name);
				}
				if (
					(attribute.name === "href" || attribute.name === "src") &&
					/^\s*javascript:/i.test(attribute.value)
				) {
					element.removeAttribute(attribute.name);
				}
			}
		});

		return root;
	}

	function embedFragment(html) {
		const target = document.getElementById("article-content");
		if (!target) throw new Error("The article container is missing.");

		const parsed = new DOMParser().parseFromString(html, "text/html");
		const fragment = sanitizeFragment(parsed.body);
		const nodes = [...fragment.childNodes].map((node) =>
			document.importNode(node, true)
		);

		target.replaceChildren(...nodes);
		hideStatus();
	}

	function embedContent(html) {
		const parsed = new DOMParser().parseFromString(html, "text/html");

		if (isCompleteDocument(html, parsed)) {
			// A complete document owns its styles and scripts. Let the browser
			// parse it normally so script order and relative URLs are preserved.
			document.open();
			document.write(html);
			document.close();
			return;
		}

		embedFragment(html);
	}

	async function loadContent() {
		if (loading) return;
		loading = true;
		setStatus("コンテンツを読み込んでいます…");

		const controller = new AbortController();
		const timeout = window.setTimeout(
			() => controller.abort(),
			FETCH_TIMEOUT_MS
		);

		try {
			const url = new URL(CONTENT_URL, document.baseURI);
			const response = await fetch(url, {
				cache: "no-store",
				signal: controller.signal,
				headers: { Accept: "text/plain" },
			});

			if (!response.ok) {
				throw new Error(`Content request failed with HTTP ${response.status}.`);
			}

			const encoded = await response.text();
			const html = decodeBase64Utf8(encoded);
			if (!html.trim()) throw new Error("The decoded content is empty.");

			embedContent(html);
		} catch (error) {
			const reason =
				error && error.name === "AbortError"
					? "読み込みがタイムアウトしました。"
					: "追加コンテンツを読み込めませんでした。";
			setStatus(`${reason} このまま記事をご覧いただけます。`, {
				error: true,
				retry: true,
			});
			console.error("[Horizon] Delayed content failed:", error);
		} finally {
			window.clearTimeout(timeout);
			loading = false;
		}
	}

	function scheduleLoad() {
		if (started) return;
		started = true;
		window.setTimeout(loadContent, START_DELAY_MS);
	}

	if (retryButton) {
		retryButton.addEventListener("click", () => {
			if (!loading) loadContent();
		});
	}

	if (document.readyState === "complete") {
		scheduleLoad();
	} else {
		window.addEventListener("load", scheduleLoad, { once: true });
	}
})();
