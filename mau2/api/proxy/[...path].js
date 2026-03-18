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

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function getForwardHeaders(req) {
  const headers = {};
  for (const [key, value] of Object.entries(req.headers || {})) {
    if (value === undefined) continue;
    if (key.toLowerCase() === "host") continue;
    if (key.toLowerCase() === "connection") continue;
    if (key.toLowerCase() === "content-length") continue;
    headers[key] = value;
  }
  headers["accept-encoding"] = "identity";
  return headers;
}

export const config = {
  api: {
    bodyParser: false,
    externalResolver: true,
  },
};

export default async function handler(req, res) {
  try {
    const pathParts = Array.isArray(req.query.path)
      ? req.query.path
      : typeof req.query.path === "string"
        ? [req.query.path]
        : [];

    const pathname = `/${pathParts.join("/")}`;
    const rawQuery = req.url?.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
    const upstreamUrl = new URL(pathname + rawQuery, upstreamOrigin);

    const method = (req.method || "GET").toUpperCase();
    const headers = getForwardHeaders(req);

    let body;
    if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
      body = await readRequestBody(req);
    }

    const upstreamRes = await fetch(upstreamUrl.toString(), {
      method,
      headers,
      body,
      redirect: "manual",
    });

    res.statusCode = upstreamRes.status;

    upstreamRes.headers.forEach((value, key) => {
      const lower = key.toLowerCase();
      if (lower === "content-encoding") return;
      if (lower === "transfer-encoding") return;
      if (lower === "content-length") return;

      if (lower === "location") {
        if (value.startsWith(upstreamOrigin)) {
          res.setHeader("location", value.slice(upstreamOrigin.length) || "/");
          return;
        }
      }

      if (lower === "set-cookie") {
        const existing = res.getHeader("set-cookie");
        const next = rewriteSetCookie(value);
        if (!existing) {
          res.setHeader("set-cookie", next);
        } else if (Array.isArray(existing)) {
          res.setHeader("set-cookie", [...existing, next]);
        } else {
          res.setHeader("set-cookie", [existing, next]);
        }
        return;
      }

      res.setHeader(key, value);
    });

    const arrayBuffer = await upstreamRes.arrayBuffer();
    res.end(Buffer.from(arrayBuffer));
  } catch (e) {
    res.statusCode = 502;
    res.setHeader("content-type", "text/plain; charset=utf-8");
    res.end("Bad Gateway");
  }
}

