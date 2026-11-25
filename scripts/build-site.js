#!/usr/bin/env node
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

const DEFAULT_OUTPUT = "public/sites/index";
const DEFAULT_BUILDS = [
	{ input: "src/client/browser.html", output: "public/sites/index" },
	{ input: "src/client/credits-content.html", output: "public/sites/credits" },
];

function fail(message) {
	console.error(`Build failed: ${message}`);
	process.exitCode = 1;
}

async function buildOne(inputArgument, outputArgument) {
	const inputPath = resolve(process.cwd(), inputArgument);
	const outputPath = resolve(process.cwd(), outputArgument);

	let html;
	try {
		html = await readFile(inputPath, "utf8");
	} catch (error) {
		fail(
			`cannot read ${relative(process.cwd(), inputPath)} (${error.code || error.message})`
		);
		return;
	}

	if (!html.trim()) {
		fail(`${relative(process.cwd(), inputPath)} is empty`);
		return;
	}

	const encoded = Buffer.from(html, "utf8").toString("base64");
	const temporaryPath = `${outputPath}.${process.pid}.tmp`;

	try {
		await mkdir(dirname(outputPath), { recursive: true });
		await writeFile(temporaryPath, encoded, "utf8");
		await rename(temporaryPath, outputPath);
	} catch (error) {
		await rm(temporaryPath, { force: true }).catch(() => {});
		fail(
			`cannot write ${relative(process.cwd(), outputPath)} (${error.code || error.message})`
		);
		return;
	}

	console.log(
		`Built ${relative(process.cwd(), inputPath)} -> ${relative(process.cwd(), outputPath)} (${html.length.toLocaleString("en-US")} UTF-16 code units, ${encoded.length.toLocaleString("en-US")} Base64 characters)`
	);
}

async function main() {
	const args = process.argv.slice(2);

	if (args.length === 0) {
		for (const job of DEFAULT_BUILDS) {
			await buildOne(job.input, job.output);
		}
		return;
	}

	if (args.length <= 2) {
		await buildOne(args[0], args[1] || DEFAULT_OUTPUT);
		return;
	}

	fail("usage: npm run build [-- <input.html> [output-file]]");
}

await main();
