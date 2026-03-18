const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

const port = Number(process.env.PORT || 5000);
const rootDir = __dirname;
const upstreamOrigin = "https://cinelove.me";

const rewriteToIndex = new Set(["/", "/index.html", "/template/pc/thiep-cuoi-2"]);

const contentTypeByExt = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
  [".ico", "image/x-icon"],
  [".mp3", "audio/mpeg"],
  [".wav", "audio/wav"],
  [".ttf", "font/ttf"],
  [".otf", "font/otf"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

function safeResolvePath(urlPathname) {
  const decoded = decodeURIComponent(urlPathname);
  const normalized = path.posix.normalize(decoded);
  const withoutLeading = normalized.replace(/^\/+/, "");
  const resolved = path.join(rootDir, ...withoutLeading.split("/"));
  const relative = path.relative(rootDir, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return resolved;
}

function sendFile(res, filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return false;

    const ext = path.extname(filePath).toLowerCase();
    const contentType = contentTypeByExt.get(ext) || "application/octet-stream";

    res.statusCode = 200;
    res.setHeader("content-type", contentType);
    res.setHeader("content-length", stat.size);
    fs.createReadStream(filePath).pipe(res);
    return true;
  } catch {
    return false;
  }
}

function rewriteSetCookie(value) {
  if (Array.isArray(value)) return value.map(rewriteSetCookie);
  if (typeof value !== "string") return value;
  return value
    .split(";")
    .map((part) => part.trim())
    .filter((part) => {
      const lower = part.toLowerCase();
      if (lower.startsWith("domain=")) return false;
      if (lower === "secure") return false;
      return true;
    })
    .join("; ");
}

function proxyToUpstream(req, res) {
  if (!req.url) {
    res.statusCode = 400;
    res.end("Bad Request");
    return;
  }

  const upstreamUrl = new URL(req.url, upstreamOrigin);

  const headers = { ...req.headers };
  delete headers.host;
  headers["accept-encoding"] = "identity";

  const upstreamReq = https.request(
    upstreamUrl,
    { method: req.method, headers },
    (upstreamRes) => {
      const outHeaders = { ...upstreamRes.headers };

      if (outHeaders.location) {
        const location = Array.isArray(outHeaders.location)
          ? outHeaders.location[0]
          : outHeaders.location;
        if (typeof location === "string" && location.startsWith(upstreamOrigin)) {
          outHeaders.location = location.slice(upstreamOrigin.length) || "/";
        }
      }

      if (outHeaders["set-cookie"]) {
        outHeaders["set-cookie"] = rewriteSetCookie(outHeaders["set-cookie"]);
      }

      res.writeHead(upstreamRes.statusCode || 502, outHeaders);
      upstreamRes.pipe(res);
    }
  );

  upstreamReq.on("error", () => {
    if (!res.headersSent) res.writeHead(502);
    res.end("Bad Gateway");
  });

  req.pipe(upstreamReq);
}

const server = http.createServer((req, res) => {
  if (!req.url) {
    res.statusCode = 400;
    res.end("Bad Request");
    return;
  }

  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  let pathname = url.pathname;

  if (rewriteToIndex.has(pathname)) pathname = "/index.html";

  let filePath = safeResolvePath(pathname);
  if (!filePath) {
    res.statusCode = 400;
    res.end("Bad Request");
    return;
  }

  if (pathname.endsWith("/")) filePath = path.join(filePath, "index.html");

  if (sendFile(res, filePath)) return;

  proxyToUpstream(req, res);
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`http://localhost:${port}/template/pc/thiep-cuoi-2\n`);
});
