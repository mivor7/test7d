// Public settings the page needs before it can share images and short links.
// The Imgur Client-ID is not a secret: browser uploads must send it, and it
// only identifies the app (Imgur rate-limits per Client-ID and per IP).
export function GET() {
    return new Response(JSON.stringify({
        imgurClientId: process.env.IMGUR_CLIENT_ID || "",
        darvin: Boolean(process.env.DARVIN_API_KEY),
    }), {
        headers: {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "public, max-age=60",
        },
    });
}
