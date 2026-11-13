const LEGACY_PASTE_URL = "https://paste.rs";
const PASTES_DEV_URL = "https://api.pastes.dev";
const USER_AGENT = "duck2 (https://github.com/mivor7/test7d)";

function json(body, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
        },
    });
}

function extractPasteId(value) {
    const text = (value || "").trim();
    if (!text) return "";

    try {
        const url = new URL(text);
        const id = url.pathname.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean).pop() || "";
        const knownHost = url.hostname === "paste.rs"
            || url.hostname === "pastes.dev"
            || url.hostname === "api.pastes.dev";
        if (knownHost && /^[A-Za-z0-9_-]+$/.test(id)) return id;
    } catch {
        // Fall back to raw short code parsing.
    }

    return /^[A-Za-z0-9_-]+$/.test(text) ? text : "";
}

function pasteIdFromUpload(upstream, bodyText) {
    const fromHeader = extractPasteId(upstream.headers.get("location") || "");
    if (fromHeader) return fromHeader;

    try {
        const parsed = JSON.parse(bodyText);
        if (parsed && typeof parsed.key === "string") return extractPasteId(parsed.key);
    } catch {
        // pastes.dev also returns the key as plain text in some responses.
    }

    return extractPasteId(bodyText);
}

async function readUpstream(url) {
    return fetch(url, {
        headers: {
            accept: "text/plain",
            "user-agent": USER_AGENT,
        },
    });
}

export async function POST(request) {
    const body = await request.text();
    if (!body.trim()) return json({ error: "Missing body" }, 400);

    // paste.rs answers POST / with 400, so new shares go to pastes.dev.
    const upstream = await fetch(`${PASTES_DEV_URL}/post`, {
        method: "POST",
        headers: {
            "content-type": "text/plain; charset=utf-8",
            "user-agent": USER_AGENT,
        },
        body,
    });

    const uploaded = (await upstream.text()).trim();
    const id = pasteIdFromUpload(upstream, uploaded);
    if (!upstream.ok || !id) return json({ error: "Upstream paste failed" }, 502);

    return json({
        id,
        url: `https://pastes.dev/${id}`,
        partial: false,
    }, 201);
}

export async function GET(request) {
    const url = new URL(request.url);
    const id = extractPasteId(url.searchParams.get("id"));
    if (!id) return json({ error: "Missing paste id" }, 400);

    const current = await readUpstream(`${PASTES_DEV_URL}/${id}`);
    if (current.ok) return json({ id, code: await current.text() });

    // Codes published before the host change still live on paste.rs.
    const legacy = await readUpstream(`${LEGACY_PASTE_URL}/${id}`);
    if (legacy.ok) return json({ id, code: await legacy.text() });

    if (current.status === 404 && legacy.status === 404) return json({ error: "Paste not found" }, 404);
    return json({ error: "Upstream fetch failed" }, 502);
}
