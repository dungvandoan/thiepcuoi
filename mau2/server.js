const http = require("http");
const https = require("https");

const port = Number(process.env.PORT || 3000);
const upstreamOrigin = "https://cinelove.me";

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

const server = http.createServer((req, res) => {
  if (!req.url) {
    res.statusCode = 400;
    res.end("Bad Request");
    return;
  }

  if (req.url === "/" || req.url === "/index.html") {
    res.statusCode = 302;
    res.setHeader("Location", "/template/pc/thiep-valentine-1");
    res.end();
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
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(
    `Proxy running: http://localhost:${port}/template/pc/thiep-valentine-1\n`
  );
});

