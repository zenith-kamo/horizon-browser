import test from "node:test";
import assert from "node:assert/strict";

import {
	buildSearchUrl,
	extractProxyUrl,
	isProxyableUrl,
	isValidSearchTemplate,
	looksLikeUrl,
	parseAddress,
} from "../src/client/js/url.js";

const engine = "https://search.example/?q=%s";

test("full URLs keep their scheme and path", () => {
	assert.deepEqual(parseAddress("https://example.com/a?b=1#c", engine), {
		kind: "url",
		url: "https://example.com/a?b=1#c",
	});
});

test("schemeless domains become http URLs", () => {
	assert.equal(parseAddress("example.com", engine).url, "https://example.com/");
	assert.equal(
		parseAddress("example.com:3000/path", engine).url,
		"http://example.com:3000/path"
	);
	assert.equal(
		parseAddress("localhost:8080", engine).url,
		"http://localhost:8080/"
	);
	assert.equal(parseAddress("192.168.1.4", engine).url, "http://192.168.1.4/");
});

test("plain text becomes an encoded search query", () => {
	assert.deepEqual(parseAddress("hello world", engine), {
		kind: "search",
		query: "hello world",
		url: "https://search.example/?q=hello%20world",
	});
});

test("unsupported schemes are searched, never executed", () => {
	const parsed = parseAddress("javascript:alert(1)", engine);
	assert.equal(parsed.kind, "search");
	assert.match(parsed.url, /^https:\/\/search\.example\//);
	assert.equal(isProxyableUrl(parsed.url), true);
	assert.equal(isProxyableUrl("javascript:alert(1)"), false);
});

test("URL lookalike detection", () => {
	assert.equal(looksLikeUrl("example.com"), true);
	assert.equal(looksLikeUrl("https://example.com/a"), true);
	assert.equal(looksLikeUrl("localhost:8080"), true);
	assert.equal(looksLikeUrl("hello world"), false);
	assert.equal(looksLikeUrl("not a url"), false);
});

test("search templates must be http(s) and contain %s", () => {
	assert.equal(isValidSearchTemplate("https://x.example/?q=%s"), true);
	assert.equal(isValidSearchTemplate("https://x.example/?q="), false);
	assert.equal(isValidSearchTemplate("javascript:%s"), false);
	assert.equal(
		buildSearchUrl("a b", "https://x.example/?q=%s"),
		"https://x.example/?q=a%20b"
	);
});

test("proxied iframe URLs are decoded", () => {
	const encode = (value) => {
		let out = "";
		for (let i = 0; i < value.length; i++) {
			out += i % 2 ? String.fromCharCode(value.charCodeAt(i) ^ 2) : value[i];
		}
		return encodeURIComponent(out);
	};
	const decode = (value) => {
		const [path, ...rest] = value.split("?");
		const decoded = decodeURIComponent(path);
		let out = "";
		for (let i = 0; i < decoded.length; i++) {
			out +=
				i % 2 ? String.fromCharCode(decoded.charCodeAt(i) ^ 2) : decoded[i];
		}
		return out + (rest.length ? `?${rest.join("?")}` : "");
	};
	const url = "https://example.com/a b?x=1#z";
	const href = `http://localhost:8080/uv/service/${encode(url)}`;
	assert.equal(extractProxyUrl(href, "/uv/service/", decode), url);
	assert.equal(
		extractProxyUrl(`${href}?horizon_reload=123`, "/uv/service/", decode),
		url
	);
	assert.equal(
		extractProxyUrl("https://example.com/", "/uv/service/", decode),
		null
	);
});
