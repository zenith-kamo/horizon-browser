import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { hostname } from "node:os";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { createSecureContext } from "node:tls";
import { createPublicKey, X509Certificate } from "node:crypto";
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

// Certificates published by lego's CERTIFICATE_DIR layout:
// <CERTIFICATE_DIR>/<domain>/<domain>.key, <domain>.crt and fullchain.pem.
// Several certificates share one server. OpenSSL only offers the first
// certificate of a context, so SNI selects the matching context explicitly.
const DEFAULT_CERTIFICATE_DIR = "/etc/lego-production/certificates";
const LEGACY_TLS = {
	key: join(DEFAULT_CERTIFICATE_DIR, "horizon.myaddr.tools.key"),
	cert: join(DEFAULT_CERTIFICATE_DIR, "fullchain.pem"),
};

const SCALAR_KEY_NAMES = [
	"HTTPS_KEY_PATH",
	"TLS_KEY_PATH",
	"SSL_KEY_PATH",
	"HTTPS_KEY",
	"TLS_KEY",
	"SSL_KEY",
];
const SCALAR_CERT_NAMES = [
	"HTTPS_CERT_PATH",
	"TLS_CERT_PATH",
	"SSL_CERT_PATH",
	"HTTPS_CERT",
	"TLS_CERT",
	"SSL_CERT",
];
const LIST_KEY_NAMES = ["HTTPS_KEY_PATHS", "TLS_KEY_PATHS", "SSL_KEY_PATHS"];
const LIST_CERT_NAMES = [
	"HTTPS_CERT_PATHS",
	"TLS_CERT_PATHS",
	"SSL_CERT_PATHS",
];
const BLOCK_PATTERN =
	/-----BEGIN [A-Z0-9 ]+-----([\s\S]*?)-----END [A-Z0-9 ]+-----/g;
const CERTIFICATE_PATTERN =
	/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;

function firstEnv(names) {
	for (const name of names) {
		const value = process.env[name];
		if (value && value.trim()) return { name, value: value.trim() };
	}
	return null;
}

function readTlsValue(source, { asPath = false } = {}) {
	if (!asPath) {
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

// Splits a path list on commas, semicolons, pipes or whitespace.
function splitList(value) {
	return value
		.split(/\s*,\s*|\s+|;|\|/g)
		.map((entry) => entry.trim())
		.filter(Boolean);
}

function loadPemBlocks(values, pattern = BLOCK_PATTERN) {
	const blocks = [];
	for (const value of values) {
		for (const match of value.matchAll(pattern)) {
			blocks.push(match[0].trim());
		}
	}
	if (!blocks.length) throw new Error("no PEM block found");
	return blocks;
}

// Extracts the host names a certificate is valid for (SAN, otherwise CN).
function certificateNames(cert) {
	try {
		const parsed = new X509Certificate(cert);
		const names = new Set();
		if (parsed.subjectAltName) {
			for (const entry of parsed.subjectAltName.split(",")) {
				const match = /^DNS:(.+)$/i.exec(entry.trim());
				if (match) names.add(match[1].trim().toLowerCase());
			}
		}
		const commonName = /(?:^|\n)CN=([^\n]+)/.exec(parsed.subject || "");
		if (commonName) names.add(commonName[1].trim().toLowerCase());
		return [...names].filter((name) => name && !name.includes("*"));
	} catch {
		return [];
	}
}

// Decides whether a certificate belongs to a private key by comparing the
// public key derived from each one.
function matchesKey(cert, key) {
	try {
		return (
			new X509Certificate(cert).publicKey.export({
				type: "spki",
				format: "pem",
			}) === createPublicKey(key).export({ type: "spki", format: "pem" })
		);
	} catch {
		return false;
	}
}

function buildSniIndex(certificates) {
	const index = new Map();
	for (const certificate of certificates) {
		for (const name of certificateNames(certificate.leaf)) {
			if (!index.has(name)) index.set(name, certificate.context);
		}
	}
	return index;
}

// Turns loaded certificates into TLS options. The first certificate is the
// default, the rest are handed to OpenSSL so unknown hosts still get a
// certificate while SNICallback resolves the exact match.
function withSni(certificates) {
	const index = buildSniIndex(certificates);
	const names = certificates
		.map((certificate) => certificate.domain)
		.join(", ");

	console.log(`[Horizon] HTTPS certificates: ${names}`);
	if (!index.size) {
		console.warn(
			"[Horizon] Could not read certificate host names; relying on trust store matching."
		);
	}

	return {
		key: certificates.map((certificate) => certificate.key).join("\n"),
		cert: certificates.map((certificate) => certificate.cert).join("\n"),
		SNICallback(servername, callback) {
			const context = index.get(String(servername).toLowerCase());
			callback(null, context);
		},
	};
}

// Reads a certificate file and keeps every certificate block, so fullchain.pem
// and cert.pem are both accepted.
function loadCertificateChain(filePath, name) {
	let pem;
	try {
		pem = readFileSync(filePath, "utf8");
	} catch (error) {
		throw new Error(`cannot read ${name} (${filePath})`);
	}
	return loadPemBlocks([pem]);
}

function loadCertificateDir(root) {
	if (!existsSync(root)) {
		throw new Error(`certificate directory ${root} was not found`);
	}

	const entries = readdirSync(root, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort();

	const certificates = [];
	const errors = [];

	for (const domain of entries) {
		const directory = join(root, domain);
		const keyPath = join(directory, `${domain}.key`);
		const certPath = join(directory, `${domain}.crt`);
		const fullchainPath = join(directory, "fullchain.pem");

		if (!existsSync(keyPath)) continue;

		try {
			const [key] = loadPemBlocks([
				readTlsValue({ name: "key", value: keyPath }, { asPath: true }),
			]);

			// fullchain.pem already contains the leaf, so read it first.
			const certBlocks = existsSync(fullchainPath)
				? loadCertificateChain(fullchainPath, `${domain} fullchain`)
				: loadCertificateChain(certPath, `${domain} certificate`);
			const leaf = certBlocks.find((block) => matchesKey(block, key));
			if (!leaf) {
				throw new Error("certificate does not match the private key");
			}

			const chain = [leaf, ...certBlocks.filter((block) => block !== leaf)];
			certificates.push({
				domain,
				key,
				cert: chain.join("\n"),
				leaf,
				context: createSecureContext({ key, cert: chain.join("\n") }),
			});
		} catch (error) {
			errors.push(`${domain}: ${error.message}`);
		}
	}

	return { certificates, errors };
}

function resolveTlsOptions() {
	const setting = (process.env.HTTPS || "").trim().toLowerCase();
	if (["0", "false", "no", "off", "disabled"].includes(setting)) {
		return null;
	}

	const required = ["1", "true", "yes", "on", "required", "force"].includes(
		setting
	);

	const keyPathList = firstEnv(LIST_KEY_NAMES);
	const certPathList = firstEnv(LIST_CERT_NAMES);

	// Several certificates share one port: every certificate gets its own
	// secure context and SNI picks the matching one.
	if (keyPathList || certPathList) {
		if (!keyPathList || !certPathList) {
			throw new Error(
				"Both HTTPS_KEY_PATHS and HTTPS_CERT_PATHS are required when using multiple certificates."
			);
		}

		const keyPaths = splitList(keyPathList.value);
		const certPaths = splitList(certPathList.value);
		if (!keyPaths.length || !certPaths.length) {
			throw new Error(
				"HTTPS_KEY_PATHS and HTTPS_CERT_PATHS must not be empty."
			);
		}
		if (keyPaths.length !== certPaths.length) {
			throw new Error(
				`HTTPS_KEY_PATHS has ${keyPaths.length} entries but HTTPS_CERT_PATHS has ${certPaths.length}. Each key needs its own certificate.`
			);
		}

		const certificates = keyPaths.map((keyPath, index) => {
			const certPath = certPaths[index];
			const [key] = loadPemBlocks([
				readTlsValue(
					{ name: `${keyPathList.name} entry`, value: keyPath },
					{ asPath: true }
				),
			]);
			const certBlocks = loadPemBlocks(
				[
					readTlsValue(
						{ name: `${certPathList.name} entry`, value: certPath },
						{ asPath: true }
					),
				],
				CERTIFICATE_PATTERN
			);
			const leaf = certBlocks.find((block) => matchesKey(block, key));
			if (!leaf) {
				throw new Error(`${certPath} does not match the key ${keyPath}`);
			}
			const chain = [leaf, ...certBlocks.filter((block) => block !== leaf)];
			return {
				domain: certPath,
				key,
				cert: chain.join("\n"),
				leaf,
				context: createSecureContext({ key, cert: chain.join("\n") }),
			};
		});

		return withSni(certificates);
	}

	const keySource = firstEnv(SCALAR_KEY_NAMES);
	const certSource = firstEnv(SCALAR_CERT_NAMES);

	if (!keySource && !certSource) {
		// A lego certificate directory takes precedence over the legacy layout.
		const certificateDir = firstEnv(["HTTPS_CERTIFICATE_DIR"]);
		const defaultDir = certificateDir
			? certificateDir.value
			: DEFAULT_CERTIFICATE_DIR;
		if (certificateDir || existsSync(defaultDir)) {
			const { certificates, errors } = loadCertificateDir(
				resolve(process.cwd(), defaultDir)
			);
			if (certificates.length) {
				if (errors.length) {
					console.warn(`[Horizon] Skipped certificates: ${errors.join("; ")}`);
				}
				return withSni(certificates);
			}
			if (certificateDir) {
				throw new Error(
					`no usable certificate found in ${defaultDir}${errors.length ? ` (${errors.join("; ")})` : ""}`
				);
			}
		}

		const legacyFilesExist =
			existsSync(LEGACY_TLS.key) && existsSync(LEGACY_TLS.cert);
		if (!legacyFilesExist) {
			if (required) {
				throw new Error(
					"HTTPS was requested, but no certificate was found. Set HTTPS_CERTIFICATE_DIR or HTTPS_KEY_PATH and HTTPS_CERT_PATH."
				);
			}
			return null;
		}

		return {
			key: loadPemBlocks([
				readTlsValue(
					{ name: "default key", value: LEGACY_TLS.key },
					{ asPath: true }
				),
			]).join("\n"),
			cert: loadCertificateChain(LEGACY_TLS.cert, "default certificate").join(
				"\n"
			),
		};
	}

	if (!keySource || !certSource) {
		throw new Error(
			"Both a private key and a certificate are required for HTTPS. Set HTTPS_KEY_PATH and HTTPS_CERT_PATH."
		);
	}

	const [key] = loadPemBlocks([
		readTlsValue(keySource, {
			asPath: !keySource.value.includes("-----BEGIN"),
		}),
	]);
	const chain = loadPemBlocks(
		[
			readTlsValue(certSource, {
				asPath: !certSource.value.includes("-----BEGIN"),
			}),
		],
		CERTIFICATE_PATTERN
	);
	if (!chain.some((block) => matchesKey(block, key))) {
		throw new Error(
			"the private key does not match any certificate in the configured file."
		);
	}

	return { key, cert: chain.join("\n") };
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
