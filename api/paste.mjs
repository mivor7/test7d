const PASTE_BASE_URL = "https://paste.rs";

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
        const id = url.pathname.replace(/^\/+|\/+$/g, "");
        if (url.hostname === "paste.rs" && /^[A-Za-z0-9_-]+$/.test(id)) return id;
    } catch {
        // Fall back to raw short code parsing.
    }

    return /^[A-Za-z0-9_-]+$/.test(text) ? text : "";
}

export async function POST(request) {
    const body = await request.text();
    if (!body.trim()) return json({ error: "Missing body" }, 400);

    const upstream = await fetch(`${PASTE_BASE_URL}/`, {
        method: "POST",
        headers: { "content-type": "text/plain; charset=utf-8" },
        body,
    });

    const location = (await upstream.text()).trim();
    const id = extractPasteId(location);

    if ((!upstream.ok && upstream.status !== 206) || !id) {
        return json({ error: "Upstream paste failed" }, 502);
    }

    return json({
        id,
        url: `${PASTE_BASE_URL}/${id}`,
        partial: upstream.status === 206,
    }, upstream.status === 206 ? 206 : 201);
}

export async function GET(request) {
    const url = new URL(request.url);
    const id = extractPasteId(url.searchParams.get("id"));
    if (!id) return json({ error: "Missing paste id" }, 400);

    const upstream = await fetch(`${PASTE_BASE_URL}/${id}`);
    if (upstream.status === 404) return json({ error: "Paste not found" }, 404);
    if (!upstream.ok) return json({ error: "Upstream fetch failed" }, 502);

    const code = await upstream.text();
    return json({ id, code });
}
