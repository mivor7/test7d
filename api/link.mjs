// dar.vin short links. The API key stays on the server; the browser only ever
// sees the short link. Set DARVIN_API_KEY (scope links:write) in the project's
// environment variables.
const DARVIN = "https://dar.vin";
const USER_AGENT = "duck2 (https://github.com/mivor7/test7d)";
const MAX_URL = 2048; // dar.vin's long_url limit
const SLUG_RE = /^[A-Za-z0-9_-]{1,100}$/;
const IMGUR_PATH_RE = /^\/[A-Za-z0-9]{5,12}\.(?:png|jpe?g|gif|webp|avif|bmp)$/i;
// Everything this app links to keeps its payload after the "#".
const APP_HASH_RE = /^#(?:n~[A-Za-z0-9_-]+|i~[A-Za-z0-9]{5,12}|[A-Za-z0-9_-]{1,64})$/;

function json(body, status = 200, headers = {}) {
    return new Response(JSON.stringify(body), {
        status,
        headers: {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
            ...headers,
        },
    });
}

// Only shorten links to this deployment or to a direct Imgur image, so the
// key can't be used as an open shortener.
function isAllowedTarget(raw, request) {
    let url;
    try { url = new URL(raw); } catch { return false; }
    if (url.username || url.password) return false;
    if (url.hostname === "i.imgur.com") {
        return url.protocol === "https:" && !url.search && !url.hash && IMGUR_PATH_RE.test(url.pathname);
    }
    let self;
    try { self = new URL(request.url); } catch { return false; }
    const local = self.hostname === "localhost" || self.hostname === "127.0.0.1";
    return url.host === self.host
        && (url.protocol === "https:" || (local && url.protocol === "http:"))
        && !url.search
        && APP_HASH_RE.test(url.hash);
}

function slugFrom(value) {
    const slug = String(value || "").trim().replace(/^(?:https?:\/\/)?(?:www\.)?dar\.vin\//i, "");
    return SLUG_RE.test(slug) ? slug : "";
}

// POST { url } → { slug, url: "https://dar.vin/<slug>" }
export async function POST(request) {
    const key = process.env.DARVIN_API_KEY;
    if (!key) return json({ error: "dar.vin is not configured" }, 503);

    let body;
    try { body = await request.json(); } catch { return json({ error: "Expected JSON" }, 400); }
    const target = typeof body?.url === "string" ? body.url.trim() : "";
    if (!target || target.length > MAX_URL) return json({ error: "Missing or too long url" }, 400);
    if (!isAllowedTarget(target, request)) return json({ error: "That link can't be shortened here" }, 400);

    let upstream;
    try {
        upstream = await fetch(`${DARVIN}/api/v3/links`, {
            method: "POST",
            headers: {
                authorization: `Bearer ${key}`,
                "content-type": "application/json",
                accept: "application/json",
                "user-agent": USER_AGENT,
            },
            body: JSON.stringify({ long_url: target }),
        });
    } catch {
        return json({ error: "dar.vin is unreachable" }, 502);
    }
    const data = await upstream.json().catch(() => null);

    if (upstream.status === 429) {
        const retry = upstream.headers.get("retry-after");
        return json({ error: "dar.vin rate limit reached" }, 429, retry ? { "retry-after": retry } : {});
    }
    const slug = slugFrom((data?.data ?? data)?.short_url);
    if (!upstream.ok || !slug) return json({ error: "dar.vin could not shorten the link" }, 502);

    return json({ slug, url: `${DARVIN}/${slug}` }, 201);
}

// GET ?slug=<slug> → { slug, url } where url is where the short link points.
// Lets the Decrypt tab open a pasted dar.vin link (browsers can't read
// cross-origin redirects).
export async function GET(request) {
    const slug = slugFrom(new URL(request.url).searchParams.get("slug"));
    if (!slug) return json({ error: "Missing slug" }, 400);

    let upstream;
    try {
        upstream = await fetch(`${DARVIN}/${slug}`, {
            redirect: "manual",
            headers: { "user-agent": USER_AGENT },
        });
    } catch {
        return json({ error: "dar.vin is unreachable" }, 502);
    }
    const location = upstream.headers.get("location");
    if (upstream.status >= 300 && upstream.status < 400 && location) {
        return json({ slug, url: new URL(location, `${DARVIN}/`).href });
    }
    if (upstream.status === 404) return json({ error: "Link not found" }, 404);
    return json({ error: "Could not resolve the link" }, 502);
}
