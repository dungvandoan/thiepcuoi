const fs = require("fs");
const path = require("path");
const https = require("https");
const crypto = require("crypto");

const projectRoot = __dirname;
const entryPath = path.join(projectRoot, "index.original.html");
const outIndexPath = path.join(projectRoot, "index.html");

const allowedHosts = new Map([
  ["cinelove.me", ""],
  ["assets.cinelove.me", "__ext/assets.cinelove.me"],
  ["img.cinelove.me", "__ext/img.cinelove.me"],
  ["fonts.googleapis.com", "__ext/fonts.googleapis.com"],
  ["fonts.gstatic.com", "__ext/fonts.gstatic.com"],
]);

const skipHosts = new Set(["www.googletagmanager.com"]);

function sha1(input) {
  return crypto.createHash("sha1").update(input).digest("hex").slice(0, 12);
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function isTextLike(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return (
    ext === ".html" ||
    ext === ".js" ||
    ext === ".css" ||
    ext === ".json" ||
    ext === ".map" ||
    ext === ".svg" ||
    ext === ".txt" ||
    ext === ".xml"
  );
}

function safeJoin(base, urlPathname, urlSearch) {
  let p = urlPathname || "/";
  if (!p.startsWith("/")) p = `/${p}`;

  let finalPath = p.replace(/\/+$/, "");
  if (finalPath === "") finalPath = "/index.html";

  const ext = path.extname(finalPath);
  if (urlSearch) {
    const h = sha1(urlSearch);
    if (ext) {
      finalPath = finalPath.slice(0, -ext.length) + `__q__${h}` + ext;
    } else {
      finalPath = finalPath + `__q__${h}`;
    }
  }

  const parts = finalPath.split("/").filter(Boolean);
  return path.join(base, ...parts);
}

function toWebPath(filePath) {
  return "/" + filePath.replace(/\\/g, "/");
}

function normalizeUrl(raw) {
  try {
    if (raw.startsWith("//")) return new URL("https:" + raw);
    if (raw.startsWith("/")) return new URL("https://cinelove.me" + raw);
    return new URL(raw);
  } catch {
    return null;
  }
}

function extractUrls(text) {
  const found = new Set();

  const attrRe = /\b(?:src|href)\s*=\s*(["'])(?<u>[^"'<>]+)\1/gi;
  for (const m of text.matchAll(attrRe)) {
    const u = m.groups?.u;
    if (!u) continue;
    found.add(u);
  }

  const urlFnRe = /url\(\s*(?:(["'])(?<u1>[^"']+)\1|(?<u2>[^)\s]+))\s*\)/gi;
  for (const m of text.matchAll(urlFnRe)) {
    const u = m.groups?.u1 || m.groups?.u2;
    if (!u) continue;
    found.add(u);
  }

  const httpRe = /https?:\/\/[^\s"'<>()[\]]+/gi;
  for (const m of text.matchAll(httpRe)) {
    found.add(m[0]);
  }

  return [...found]
    .map((u) => u.trim())
    .filter(Boolean)
    .filter((u) => !u.startsWith("data:"))
    .filter((u) => !u.startsWith("javascript:"))
    .filter((u) => !u.startsWith("mailto:"));
}

function shouldHandleUrl(urlObj) {
  const host = urlObj.hostname;
  if (skipHosts.has(host)) return false;
  if (!allowedHosts.has(host)) return false;
  if (host === "cinelove.me") {
    const p = urlObj.pathname;
    if (
      p.startsWith("/_next/") ||
      p.startsWith("/images/") ||
      p.startsWith("/favicon") ||
      p.startsWith("/template/") ||
      p.startsWith("/templates/") ||
      p.startsWith("/resources/") ||
      p.startsWith("/gifts/") ||
      p.startsWith("/assets/")
    ) {
      return true;
    }
    return false;
  }
  return true;
}

function download(urlObj) {
  return new Promise((resolve, reject) => {
    https
      .get(urlObj, (res) => {
        if (
          res.statusCode &&
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          const next = normalizeUrl(res.headers.location);
          if (!next) return reject(new Error("Bad redirect"));
          res.resume();
          download(next).then(resolve, reject);
          return;
        }

        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode || 0}`));
          return;
        }

        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks)));
        res.on("error", reject);
      })
      .on("error", reject);
  });
}

function replaceAllKnownHosts(text) {
  let out = text;
  out = out.replaceAll("https://cinelove.me/", "/");
  out = out.replaceAll("http://cinelove.me/", "/");
  out = out.replaceAll("https://assets.cinelove.me/", "/__ext/assets.cinelove.me/");
  out = out.replaceAll("https://img.cinelove.me/", "/__ext/img.cinelove.me/");
  out = out.replaceAll(
    "https://fonts.googleapis.com/",
    "/__ext/fonts.googleapis.com/"
  );
  out = out.replaceAll(
    "https://fonts.gstatic.com/",
    "/__ext/fonts.gstatic.com/"
  );
  return out;
}

function shouldHashQuery(hostname, pathname) {
  if (hostname === "img.cinelove.me") return true;
  if (hostname === "fonts.googleapis.com") return true;
  if (hostname === "cinelove.me") {
    if (pathname === "/_next/image") return true;
  }
  return false;
}

function rewriteLocalQueryUrls(text) {
  return text.replace(
    /\/__ext\/(img\.cinelove\.me|fonts\.googleapis\.com)(?<p>\/[^\s"'<>)]*?)\?(?<q>[^\s"'<>)]*)/g,
    (_m, host, p, q) => {
      const search = "?" + q;
      const localPath = safeJoin(`__ext/${host}`, p, search);
      return toWebPath(localPath);
    }
  );
}

async function run() {
  if (!fs.existsSync(entryPath)) {
    process.stderr.write("Missing index.original.html\n");
    process.exitCode = 1;
    return;
  }

  const entryHtml = fs.readFileSync(entryPath, "utf8");
  const queue = [];
  const seen = new Set();
  const urlToLocalWebPath = new Map();

  function enqueue(raw) {
    const u = normalizeUrl(raw);
    if (!u) return;
    if (!shouldHandleUrl(u)) return;
    const key = u.toString();
    if (seen.has(key)) return;
    seen.add(key);
    queue.push(u);
  }

  for (const u of extractUrls(entryHtml)) enqueue(u);

  const concurrency = 10;
  let active = 0;
  let index = 0;
  let downloaded = 0;

  async function worker() {
    while (true) {
      const i = index++;
      if (i >= queue.length) return;
      const u = queue[i];

      const hostBase = allowedHosts.get(u.hostname) ?? null;
      if (hostBase === null) continue;

      const localPath = safeJoin(
        hostBase,
        u.pathname,
        shouldHashQuery(u.hostname, u.pathname) ? u.search : ""
      );
      const absPath = path.join(projectRoot, localPath);
      const webPath = toWebPath(localPath);
      urlToLocalWebPath.set(u.toString(), webPath);

      if (fs.existsSync(absPath)) {
        if (isTextLike(absPath)) {
          try {
            const existing = fs.readFileSync(absPath, "utf8");
            const rewritten = rewriteLocalQueryUrls(replaceAllKnownHosts(existing));
            if (rewritten !== existing) fs.writeFileSync(absPath, rewritten, "utf8");
            for (const nu of extractUrls(rewritten)) enqueue(nu);
          } catch {
            continue;
          }
        }
        continue;
      }

      ensureDir(path.dirname(absPath));

      try {
        const buf = await download(u);
        if (isTextLike(absPath)) {
          const text = rewriteLocalQueryUrls(replaceAllKnownHosts(buf.toString("utf8")));
          fs.writeFileSync(absPath, text, "utf8");
          for (const nu of extractUrls(text)) enqueue(nu);
        } else {
          fs.writeFileSync(absPath, buf);
        }
        downloaded += 1;
        if (downloaded % 50 === 0) {
          process.stdout.write(`Downloaded ${downloaded} files...\n`);
        }
      } catch {
        continue;
      }
    }
  }

  const workers = [];
  for (let i = 0; i < concurrency; i++) workers.push(worker());
  while (active < concurrency) active++;
  await Promise.all(workers);

  let outHtml = entryHtml;
  outHtml = outHtml.replace(/<base\b[^>]*>/i, "");
  outHtml = rewriteLocalQueryUrls(replaceAllKnownHosts(outHtml));

  fs.writeFileSync(outIndexPath, outHtml, "utf8");
  process.stdout.write(`Done. Downloaded ${downloaded} files.\n`);
}

run();
