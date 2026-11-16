// ═══════════════════════════════════════════
//  DUCK2 — Engine (no DOM, no network)
// ═══════════════════════════════════════════
const Z85 = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ.-:+=^!/*?&<>()[]{}@%$#";
const Z85_MAP = new Map([...Z85].map((c, i) => [c, i]));
const ITERATIONS = 600000, SALT_LEN = 16, IV_LEN = 12;
// Envelope: "D2" + version + flags. F_FILE marks a binary payload (an image)
// that is stored uncompressed with its MIME type in front.
const M0 = 68, M1 = 50, VER = 1, F_ENC = 1, F_FILE = 2;
const normalize = s => (s || "").replace(/\s+/g, "");

// Images a viewer may render. Anything else is only offered as a download,
// so a crafted payload can never become a same-origin SVG or HTML page.
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/bmp"];

// Share links carry their payload after the "#", so it never reaches a server
// log. "~" is outside both Z85 and base64url, so these never clash with a
// full Duck code or a pastes.dev id.
const LINK_NOTE = "n~";   // n~<base64url envelope>: the whole note lives in the link
const LINK_IMAGE = "i~";  // i~<imgur id>: an encrypted image stored inside a PNG on Imgur
const IMGUR_ID_RE = /^[A-Za-z0-9]{5,12}$/;
const SLUG_RE = /^[A-Za-z0-9_-]{1,100}$/;

function isDuckCode(s) {
    s = normalize(s);
    if (s.length < 2) return false;
    const last = s.charCodeAt(s.length - 1) - 48;
    if (last < 0 || last > 4 || (s.length - 1) % 5 !== 0) return false;
    for (let i = 0; i < s.length - 1; i++) if (!Z85_MAP.has(s[i])) return false;
    return true;
}
function z85Encode(u8) {
    const pad = (4 - u8.length % 4) % 4, data = new Uint8Array(u8.length + pad);
    data.set(u8); const view = new DataView(data.buffer); let str = "";
    for (let i = 0; i < data.length; i += 4) {
        let val = view.getUint32(i, false), chunk = "";
        for (let j = 0; j < 5; j++) { chunk = Z85[val % 85] + chunk; val = Math.floor(val / 85); }
        str += chunk;
    }
    return str + pad;
}
function z85Decode(s) {
    s = normalize(s); if (!s) return new Uint8Array(0);
    const pad = parseInt(s.slice(-1), 10);
    if (pad < 0 || pad > 4) throw new Error("Bad padding");
    const body = s.slice(0, -1);
    if (body.length % 5 !== 0) throw new Error("Bad length");
    const bytes = new Uint8Array((body.length / 5) * 4), view = new DataView(bytes.buffer);
    let bi = 0;
    for (let i = 0; i < body.length; i += 5) {
        let val = 0;
        for (let j = 0; j < 5; j++) {
            const idx = Z85_MAP.get(body[i + j]);
            if (idx === undefined) throw new Error("Bad char");
            val = val * 85 + idx;
        }
        view.setUint32(bi, val, false); bi += 4;
    }
    return bytes.slice(0, bytes.length - pad);
}
function b64urlEncode(u8) {
    let bin = "";
    for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(s) {
    if (!/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) throw new Error("Bad base64");
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "==".slice(0, (4 - s.length % 4) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}
const pipeBytes = async (u8, stream) => new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(stream)).arrayBuffer());
const compress = async txt => pipeBytes(new TextEncoder().encode(txt), new CompressionStream("deflate-raw"));
const decompress = async u8 => new TextDecoder().decode(await pipeBytes(u8, new DecompressionStream("deflate-raw")));

async function deriveKey(pass, salt) {
    const raw = await crypto.subtle.importKey("raw", new TextEncoder().encode(pass), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: ITERATIONS, hash: "SHA-256" },
        raw, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
// salt ‖ iv ‖ AES-GCM(ciphertext + tag)
async function seal(plain, pass) {
    const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
    const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
    const enc = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await deriveKey(pass, salt), plain));
    const out = new Uint8Array(SALT_LEN + IV_LEN + enc.length);
    out.set(salt, 0); out.set(iv, SALT_LEN); out.set(enc, SALT_LEN + IV_LEN);
    return out;
}
async function unseal(body, pass) {
    if (!pass) throw new Error("MISSING_PASS");
    if (body.length < SALT_LEN + IV_LEN + 16) throw new Error("CORRUPT");
    const salt = body.slice(0, SALT_LEN), iv = body.slice(SALT_LEN, SALT_LEN + IV_LEN);
    const key = await deriveKey(pass, salt);
    try { return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, body.slice(SALT_LEN + IV_LEN))); }
    catch { throw new Error("WRONG_PASS"); }
}
function packEnvelope(body, flags) {
    const out = new Uint8Array(body.length + 4);
    out[0] = M0; out[1] = M1; out[2] = VER; out[3] = flags;
    out.set(body, 4); return out;
}
function unpackEnvelope(data) {
    if (data.length >= 4 && data[0] === M0 && data[1] === M1 && data[2] === VER)
        return { encrypted: (data[3] & F_ENC) !== 0, file: (data[3] & F_FILE) !== 0, body: data.slice(4) };
    return null;
}
// true / false when the envelope says so; null for pre-envelope codes,
// which can only be told apart by trying to open them.
function isLocked(data) {
    const env = unpackEnvelope(data);
    return env ? env.encrypted : null;
}

// ── Notes ──
async function sealNote(text, pass) {
    const compressed = await compress(text);
    return pass ? packEnvelope(await seal(compressed, pass), F_ENC) : packEnvelope(compressed, 0);
}
async function openNote(data, pass) {
    const env = unpackEnvelope(data);
    if (env) {
        if (env.file) throw new Error("IS_FILE");
        return decompress(env.encrypted ? await unseal(env.body, pass) : env.body);
    }
    if (pass) return decompress(await unseal(data, pass));
    try { return await decompress(data); } catch { throw new Error("INVALID_OR_PASS"); }
}
const duckEncrypt = async (text, pass) => z85Encode(await sealNote(text, pass));
const duckDecrypt = async (code, pass) => openNote(z85Decode(code), pass);

// ── Files (images) ──
// plain = mimeLength(1) ‖ mime ‖ bytes
async function sealFile(bytes, mime, pass) {
    const m = new TextEncoder().encode(mime);
    if (m.length > 255) throw new Error("BAD_TYPE");
    const plain = new Uint8Array(1 + m.length + bytes.length);
    plain[0] = m.length; plain.set(m, 1); plain.set(bytes, 1 + m.length);
    return pass ? packEnvelope(await seal(plain, pass), F_FILE | F_ENC) : packEnvelope(plain, F_FILE);
}
async function openFile(data, pass) {
    const env = unpackEnvelope(data);
    if (!env || !env.file) throw new Error("CORRUPT");
    const plain = env.encrypted ? await unseal(env.body, pass) : env.body;
    const n = plain[0];
    if (plain.length < 1 + n) throw new Error("CORRUPT");
    const mime = new TextDecoder().decode(plain.subarray(1, 1 + n));
    return { mime: IMAGE_TYPES.includes(mime) ? mime : "application/octet-stream", bytes: plain.slice(1 + n) };
}

// ── PNG container ──
// Imgur only hosts real images, so a locked image travels as the pixels of a
// lossless RGB PNG: uint32 length ‖ payload ‖ zero padding. The decoder takes
// any 8-bit RGB/RGBA PNG with any row filters, in case Imgur re-encodes it.
const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
    }
    return t;
})();
function crc32(u8) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
}
const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];
function pngChunk(type, data) {
    const out = new Uint8Array(12 + data.length), view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
}
async function packPng(payload) {
    const pixels = Math.ceil((4 + payload.length) / 3);
    const width = Math.max(1, Math.ceil(Math.sqrt(pixels)));
    const height = Math.ceil(pixels / width);
    const row = width * 3;
    const data = new Uint8Array(row * height);
    new DataView(data.buffer).setUint32(0, payload.length);
    data.set(payload, 4);
    const raw = new Uint8Array((row + 1) * height); // filter byte 0 (None) on every row
    for (let y = 0; y < height; y++) raw.set(data.subarray(y * row, (y + 1) * row), y * (row + 1) + 1);
    const ihdr = new Uint8Array(13), hv = new DataView(ihdr.buffer);
    hv.setUint32(0, width); hv.setUint32(4, height);
    ihdr[8] = 8; ihdr[9] = 2; // 8-bit truecolour, default compression/filter/interlace
    const idat = await pipeBytes(raw, new CompressionStream("deflate"));
    return new Blob([new Uint8Array(PNG_SIG), pngChunk("IHDR", ihdr), pngChunk("IDAT", idat), pngChunk("IEND", new Uint8Array(0))], { type: "image/png" });
}
async function unpackPng(buffer) {
    const u8 = new Uint8Array(buffer), view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    if (u8.length < 8 || PNG_SIG.some((b, i) => u8[i] !== b)) throw new Error("CORRUPT");
    let pos = 8, width = 0, height = 0, depth = 0, ctype = -1, interlace = 0;
    const idat = [];
    while (pos + 12 <= u8.length) {
        const len = view.getUint32(pos);
        const type = String.fromCharCode(u8[pos + 4], u8[pos + 5], u8[pos + 6], u8[pos + 7]);
        if (pos + 12 + len > u8.length) throw new Error("CORRUPT");
        const body = u8.subarray(pos + 8, pos + 8 + len);
        if (type === "IHDR") {
            width = view.getUint32(pos + 8); height = view.getUint32(pos + 12);
            depth = body[8]; ctype = body[9]; interlace = body[12];
        } else if (type === "IDAT") idat.push(body);
        else if (type === "IEND") break;
        pos += 12 + len;
    }
    if (depth !== 8 || interlace !== 0 || (ctype !== 2 && ctype !== 6) || !width || !height || !idat.length) throw new Error("CORRUPT");
    const bpp = ctype === 6 ? 4 : 3, stride = width * bpp;
    let raw;
    try { raw = await pipeBytes(new Uint8Array(await new Blob(idat).arrayBuffer()), new DecompressionStream("deflate")); }
    catch { throw new Error("CORRUPT"); }
    if (raw.length < (stride + 1) * height) throw new Error("CORRUPT");
    const out = new Uint8Array(width * height * 3);
    let prev = new Uint8Array(stride), cur = new Uint8Array(stride), o = 0;
    for (let y = 0, p = 0; y < height; y++, p += stride + 1) {
        const filter = raw[p];
        for (let x = 0; x < stride; x++) {
            const v = raw[p + 1 + x];
            const a = x >= bpp ? cur[x - bpp] : 0, b = prev[x], c = x >= bpp ? prev[x - bpp] : 0;
            switch (filter) {
                case 0: cur[x] = v; break;
                case 1: cur[x] = v + a; break;
                case 2: cur[x] = v + b; break;
                case 3: cur[x] = v + ((a + b) >> 1); break;
                case 4: {
                    const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
                    cur[x] = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
                    break;
                }
                default: throw new Error("CORRUPT");
            }
        }
        if (bpp === 3) { out.set(cur, o); o += stride; }
        else for (let x = 0; x < stride; x += 4) { out[o++] = cur[x]; out[o++] = cur[x + 1]; out[o++] = cur[x + 2]; }
        [prev, cur] = [cur, prev];
    }
    const len = new DataView(out.buffer).getUint32(0);
    if (len > out.length - 4) throw new Error("CORRUPT");
    return out.slice(4, 4 + len);
}

// ── References ──
// Everything a user might paste or open, normalised to one of:
//   { kind: "inline", data }   n~ payload (note, or legacy full code in a link)
//   { kind: "image",  id }     i~ encrypted image on Imgur
//   { kind: "direct", url }    a plain i.imgur.com image
//   { kind: "paste",  id }     pastes.dev / paste.rs short code
//   { kind: "darvin", slug }   dar.vin short link, resolved by the server
function parseFragment(frag) {
    if (frag.startsWith(LINK_NOTE)) {
        try { const data = b64urlDecode(frag.slice(2)); return data.length ? { kind: "inline", data } : null; }
        catch { return null; }
    }
    if (frag.startsWith(LINK_IMAGE)) return IMGUR_ID_RE.test(frag.slice(2)) ? { kind: "image", id: frag.slice(2) } : null;
    if (isDuckCode(frag)) return { kind: "inline", data: z85Decode(frag) };
    return null;
}
function parseShareRef(raw, { host = globalThis.location?.host, allowDarvin = true } = {}) {
    const t = (raw || "").trim();
    if (!t) return null;
    // URLs first: ":", "/" and "." are Z85 characters, so a URL can pass for a Duck code.
    let url = null;
    if (/^https?:\/\//i.test(t)) { try { url = new URL(t); } catch { return null; } }
    else if (/^(?:www\.)?dar\.vin\//i.test(t)) { try { url = new URL("https://" + t); } catch { return null; } }
    if (!url) return parseFragment(normalize(t)) || (/^[A-Za-z0-9_-]+$/.test(t) ? { kind: "paste", id: t } : null);

    const hostname = url.hostname.replace(/^www\./, "");
    const parts = url.pathname.split("/").filter(Boolean);
    if (hostname === "dar.vin") {
        return allowDarvin && parts.length === 1 && SLUG_RE.test(parts[0]) ? { kind: "darvin", slug: parts[0] } : null;
    }
    if (hostname === "i.imgur.com") {
        const m = /^\/([A-Za-z0-9]{5,12})\.(png|jpe?g|gif|webp|avif|bmp)$/i.exec(url.pathname);
        return m ? { kind: "direct", url: `https://i.imgur.com/${m[1]}.${m[2]}` } : null;
    }
    if (["paste.rs", "pastes.dev", "api.pastes.dev"].includes(hostname)) {
        const id = parts[parts.length - 1] || "";
        return /^[A-Za-z0-9_-]+$/.test(id) && id !== "web" ? { kind: "paste", id } : null;
    }
    // A share link from any Duck2 deployment carries its payload after the #.
    let frag = "";
    try { frag = decodeURIComponent(url.hash.slice(1)); } catch { return null; }
    const inner = parseFragment(normalize(frag));
    if (inner) return inner;
    // Older share links (page#pasteId) only count on this site.
    return url.host === host && /^[A-Za-z0-9_-]+$/.test(frag) ? { kind: "paste", id: frag } : null;
}
