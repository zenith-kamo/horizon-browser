// This file overwrites the stock UV config.js

self.__uv$config = {
	prefix: "/uv/service/",
	encodeUrl: Ultraviolet.codec.xor.encode,
	// The frontend appends ?horizon_reload=<timestamp> to the proxy URL to
	// force a real navigation when reloading/re-entering the same page. Strip
	// that marker before decoding so it never leaks into the proxied page URL.
	decodeUrl(value) {
		if (typeof value !== "string") return value;
		return Ultraviolet.codec.xor.decode(value.split("?horizon_reload=")[0]);
	},
	handler: "/uv/uv.handler.js",
	client: "/uv/uv.client.js",
	bundle: "/uv/uv.bundle.js",
	config: "/uv/uv.config.js",
	sw: "/uv/uv.sw.js",
};
