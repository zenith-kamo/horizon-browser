import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { hostname } from "node:os";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import express from "express";
import wisp from "wisp-server-node";

import { uvPath } from "@titaniumnetwork-dev/ultraviolet";
import { epoxyPath } from "@mercuryworkshop/epoxy-transport";
import { baremuxPath } from "@mercuryworkshop/bare-mux/node";

const app = express();
// Load the frontend first and prioritize it over UV.
app.use(express.static("./src/client"));
// Serve published pages directly. These files never pass through UV.
app.use(express.static("./public", { index: false }));
// Load vendor files last.
// The vendor's uv.config.js won't conflict with our uv.config.js inside the client directory.
app.use("/uv/", express.static(uvPath));
app.use("/epoxy/", express.static(epoxyPath));
app.use("/baremux/", express.static(baremuxPath));

// Favicons are fetched through the app origin. Cross-origin icons are often
// blocked by COEP, so the tab strip never gets a usable image when the icon is
// loaded directly from a third-party CDN.
const FAVICON_TIMEOUT_MS = 6000;
const FAVICON_MAX_BYTES = 512 * 1024;
const FAVICON_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FAVICON_CACHE_LIMIT = 300;
const faviconCache = new Map();

function isPrivateAddress(address) {
	if (isIP(address) === 4) {
		const [a, b] = address.split(".").map(Number);
		return (
			a === 0 ||
			a === 10 ||
			a === 127 ||
			a >= 224 ||
			(a === 100 && b >= 64 && b <= 127) ||
			(a === 169 && b === 254) ||
			(a === 172 && b >= 16 && b <= 31) ||
			(a === 192 && b === 0) ||
			(a === 192 && b === 168) ||
			(a === 198 && (b === 18 || b === 19)) ||
			(a === 198 && b === 51) ||
			(a === 203 && b === 0)
		);
	}

	if (isIP(address) === 6) {
		const normalized = address.toLowerCase();
		if (normalized === "::" || normalized === "::1") return true;
		if (/^f[cd]/.test(normalized)) return true;
		if (/^fe[89ab]/.test(normalized)) return true;
		if (normalized.startsWith("::ffff:")) {
			return isPrivateAddress(normalized.slice(7));
		}
		return false;
	}

	return true;
}

async function assertPublicFaviconUrl(url) {
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("Unsupported favicon protocol");
	}
	if (url.username || url.password) {
		throw new Error("Credentials are not allowed");
	}

	const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
	if (
		!host ||
		host === "localhost" ||
		host.endsWith(".localhost") ||
		host.endsWith(".local") ||
		host.endsWith(".internal") ||
		host === "metadata.google.internal"
	) {
		throw new Error("Private favicon host");
	}

	const records = await lookup(host, { all: true, verbatim: true });
	if (
		!records.length ||
		records.some((record) => isPrivateAddress(record.address))
	) {
		throw new Error("Private favicon address");
	}
}

function sniffFaviconType(buffer, declaredType) {
	if (
		buffer.length >= 8 &&
		buffer[0] === 0x89 &&
		buffer[1] === 0x50 &&
		buffer[2] === 0x4e &&
		buffer[3] === 0x47
	) {
		return "image/png";
	}
	if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8) {
		return "image/jpeg";
	}
	if (buffer.length >= 6 && buffer.toString("ascii", 0, 4) === "GIF8") {
		return "image/gif";
	}
	if (
		buffer.length >= 12 &&
		buffer.toString("ascii", 0, 4) === "RIFF" &&
		buffer.toString("ascii", 8, 12) === "WEBP"
	) {
		return "image/webp";
	}
	if (
		buffer.length >= 4 &&
		buffer[0] === 0 &&
		buffer[1] === 0 &&
		buffer[2] === 1
	) {
		return "image/x-icon";
	}

	const head = buffer.toString("utf8", 0, Math.min(buffer.length, 1024));
	if (/<svg[\s>]/i.test(head) || /<\?xml[^>]*>[\s\S]*<svg/i.test(head)) {
		return "image/svg+xml";
	}

	if (declaredType?.startsWith("image/")) return declaredType;
	return null;
}

async function readFaviconBody(response, requestUrl) {
	const declaredType = (response.headers.get("content-type") || "")
		.split(";")[0]
		.trim()
		.toLowerCase();
	const contentLength = Number(response.headers.get("content-length") || 0);
	if (contentLength > FAVICON_MAX_BYTES) {
		throw new Error("Favicon is too large");
	}
	if (!response.body) throw new Error("Favicon has no body");

	const reader = response.body.getReader();
	const chunks = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > FAVICON_MAX_BYTES) {
				throw new Error("Favicon is too large");
			}
			chunks.push(Buffer.from(value));
		}
	} finally {
		reader.releaseLock();
	}

	const buffer = Buffer.concat(chunks);
	const type = sniffFaviconType(buffer, declaredType);
	if (!type) {
		throw new Error(
			`Unexpected favicon type: ${declaredType || "unknown"} (${requestUrl})`
		);
	}
	return { buffer, type };
}

async function fetchFaviconResource(startUrl) {
	let current = new URL(startUrl);

	for (let redirects = 0; redirects <= 3; redirects += 1) {
		await assertPublicFaviconUrl(current);
		const response = await fetch(current, {
			redirect: "manual",
			signal: AbortSignal.timeout(FAVICON_TIMEOUT_MS),
			headers: {
				Accept:
					"image/avif,image/webp,image/png,image/svg+xml,image/*,*/*;q=0.5",
				Referer: `${current.origin}/`,
				"User-Agent":
					"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 Horizon/1.0",
			},
		});

		if (response.status >= 300 && response.status < 400) {
			const location = response.headers.get("location");
			if (!location || redirects === 3) {
				throw new Error("Too many favicon redirects");
			}
			current = new URL(location, current);
			continue;
		}

		if (!response.ok) {
			throw new Error(`Favicon request failed with ${response.status}`);
		}
		return await readFaviconBody(response, current);
	}

	throw new Error("Too many favicon redirects");
}

function rememberFavicon(key, image) {
	faviconCache.set(key, {
		...image,
		expiresAt: Date.now() + FAVICON_CACHE_TTL_MS,
	});
	while (faviconCache.size > FAVICON_CACHE_LIMIT) {
		faviconCache.delete(faviconCache.keys().next().value);
	}
}

app.get("/api/favicon", async (request, response) => {
	const raw =
		typeof request.query.url === "string" ? request.query.url.trim() : "";
	if (!raw || raw.length > 2048) {
		response.status(400).end();
		return;
	}

	let target;
	try {
		target = new URL(raw);
	} catch {
		response.status(400).end();
		return;
	}

	const key = target.href;
	const cached = faviconCache.get(key);
	if (cached && cached.expiresAt > Date.now()) {
		response.set({
			"Cache-Control": "public, max-age=86400",
			"Content-Type": cached.type,
			"Cross-Origin-Resource-Policy": "same-origin",
			"X-Content-Type-Options": "nosniff",
			"Content-Security-Policy":
				"default-src 'none'; style-src 'unsafe-inline'; sandbox",
		});
		response.send(cached.buffer);
		return;
	}

	try {
		const image = await fetchFaviconResource(target);
		rememberFavicon(key, image);
		response.set({
			"Cache-Control": "public, max-age=86400",
			"Content-Type": image.type,
			"Cross-Origin-Resource-Policy": "same-origin",
			"X-Content-Type-Options": "nosniff",
			"Content-Security-Policy":
				"default-src 'none'; style-src 'unsafe-inline'; sandbox",
		});
		response.send(image.buffer);
	} catch {
		response.set("Cache-Control", "public, max-age=60");
		response.status(404).end();
	}
});

// Error for everything else
app.use((req, res) => {
	res.status(404);
	res.sendFile(join(process.cwd(), "src/client/404.html"));
});

const DEFAULT_TLS = {
	key: "/etc/lego-production/certificates/horizon.myaddr.tools.key",
	cert: "/etc/lego-production/certificates/fullchain.pem",
};

function firstEnv(...names) {
	for (const name of names) {
		const value = process.env[name];
		if (value && value.trim()) return { name, value: value.trim() };
	}
	return null;
}

function readTlsValue(source) {
	if (source.value.includes("-----BEGIN")) {
		return source.value.replace(/\\n/g, "\n");
	}

	const filePath = resolve(process.cwd(), source.value);
	try {
		return readFileSync(filePath, "utf8");
	} catch (error) {
		throw new Error(
			`cannot read ${source.name} (${filePath}) (${error.code || error.message})`
		);
	}
}

function resolveTlsOptions() {
	const setting = (process.env.HTTPS || "").trim().toLowerCase();
	if (["0", "false", "no", "off", "disabled"].includes(setting)) {
		return null;
	}

	const required = ["1", "true", "yes", "on", "required", "force"].includes(
		setting
	);
	const keySource = firstEnv(
		"HTTPS_KEY_PATH",
		"TLS_KEY_PATH",
		"SSL_KEY_PATH",
		"HTTPS_KEY",
		"TLS_KEY",
		"SSL_KEY"
	);
	const certSource = firstEnv(
		"HTTPS_CERT_PATH",
		"TLS_CERT_PATH",
		"SSL_CERT_PATH",
		"HTTPS_CERT",
		"TLS_CERT",
		"SSL_CERT"
	);

	if (!keySource && !certSource) {
		const defaultFilesExist =
			existsSync(DEFAULT_TLS.key) && existsSync(DEFAULT_TLS.cert);
		if (!defaultFilesExist) {
			if (required) {
				throw new Error(
					"HTTPS was requested, but no certificate was found. Set HTTPS_KEY_PATH and HTTPS_CERT_PATH."
				);
			}
			return null;
		}

		return {
			key: readTlsValue({ name: "default key", value: DEFAULT_TLS.key }),
			cert: readTlsValue({
				name: "default certificate",
				value: DEFAULT_TLS.cert,
			}),
		};
	}

	if (!keySource || !certSource) {
		throw new Error(
			"Both a private key and a certificate are required for HTTPS. Set HTTPS_KEY_PATH and HTTPS_CERT_PATH."
		);
	}

	return {
		key: readTlsValue(keySource),
		cert: readTlsValue(certSource),
	};
}

function createAppServer() {
	const tlsOptions = resolveTlsOptions();
	if (tlsOptions) {
		return { server: createHttpsServer(tlsOptions), protocol: "https" };
	}
	return { server: createHttpServer(), protocol: "http" };
}

let appServer;
try {
	appServer = createAppServer();
} catch (error) {
	console.error(`[Horizon] TLS setup failed: ${error.message}`);
	process.exit(1);
}

const { server, protocol } = appServer;

server.on("request", (req, res) => {
	res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
	res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
	app(req, res);
});
server.on("upgrade", (req, socket, head) => {
	if (req.url.endsWith("/wisp/")) {
		wisp.routeRequest(req, socket, head);
		return;
	}
	socket.end();
});

const portValue = (process.env.PORT || "8080").trim();
const port = Number(portValue);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
	console.error(`[Horizon] Invalid PORT: ${portValue}`);
	process.exit(1);
}
const host = (process.env.HOST || "").trim() || "0.0.0.0";

server.on("listening", () => {
	const address = server.address();
	const shownAddress =
		address.family === "IPv6" ? `[${address.address}]` : address.address;

	console.log(`${protocol.toUpperCase()} server listening on:`);
	console.log(`\t${protocol}://localhost:${address.port}`);
	console.log(`\t${protocol}://${hostname()}:${address.port}`);
	console.log(`\t${protocol}://${shownAddress}:${address.port}`);
});

server.on("error", (error) => {
	console.error(`[Horizon] Server error: ${error.message}`);
	process.exit(1);
});

let shuttingDown = false;
function shutdown(signal) {
	if (shuttingDown) return;
	shuttingDown = true;
	console.log(`${signal} received: closing ${protocol.toUpperCase()} server`);
	server.close(() => process.exit(0));
	setTimeout(() => {
		console.error("[Horizon] Forced shutdown after timeout.");
		process.exit(1);
	}, 10000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

server.listen({ port, host });
