// ═══════════════════════════════════════════
//  DUCK2 — App (engine lives in duck-core.js)
// ═══════════════════════════════════════════
const $ = id => document.getElementById(id);
const MAX_LINK = 2048;                 // dar.vin's long_url limit
const IMGUR_UPLOAD = "https://api.imgur.com/3/image";
const IMGUR_MAX = 20e6;                // Imgur's limit for a plain image
const LOCKED_PNG_MAX = 4.9e6;          // Imgur turns PNGs over 5 MB into JPEGs, which would wreck the data
const LOCKED_IMAGE_MAX = 4.85e6;       // bigger images are scaled down before they are locked
const SHRINK_EDGE = 2560;

let mode = "encrypt", timer, gen = 0, viewGen = 0, attachSeq = 0;
const drafts = { encrypt: "", decrypt: "" };
let attachment = null;     // { id, file, type, name, size, url }
let share = null;          // the last link made in Encrypt, with its alternatives
let altOpen = "";          // which "other way to share" is open
let resultValue = "";      // what the Result card's Copy button copies
let resultBlob = "";       // object URL shown in the Result card
let imagesEnabled = false;
let config = null;
const pasteCache = new Map();
let ui;

const INTRO = {
    encrypt: () => imagesEnabled
        ? "Write a note or add an image, then create a link to send."
        : "Write a note, then create a link to send.",
    decrypt: () => "Paste a dar.vin link, a share link, a short code or a full Duck code.",
};

function initUI() {
    ui = {
        input: $("input"), pass: $("pass"), composer: $("composer"),
        btnEnc: $("mode-enc"), btnDec: $("mode-dec"),
        btnTheme: $("btn-theme"), btnPaste: $("btn-paste"), btnClear: $("btn-clear"),
        btnImage: $("btn-image"), fileInput: $("file-input"),
        attachment: $("attachment"), attachmentImg: $("attachment-img"), attachmentMeta: $("attachment-meta"),
        btnRemoveImage: $("btn-remove-image"),
        btnShowPass: $("btn-show-pass"), btnClearPass: $("btn-clear-pass"),
        btnGo: $("btn-go"), btnShowFull: $("btn-show-full"),
        btnCopy: $("btn-copy"), btnOpen: $("btn-open"),
        lblInput: $("lbl-input"), passHint: $("pass-hint"),
        strength: $("strength"), strengthLabel: $("strength-label"),
        result: $("result"), resultTitle: $("result-title"), resultEmpty: $("result-empty"),
        shortOutput: $("short-output"), shortNote: $("short-note"),
        output: $("output"), outputImage: $("output-image"), outputImg: $("output-img"),
        alts: $("alts"), altButtons: [...document.querySelectorAll("[data-alt]")],
        altPanel: $("alt-panel"), altValue: $("alt-value"), altHint: $("alt-hint"), btnCopyAlt: $("btn-copy-alt"),
        statChars: $("stat-chars"), status: $("stat-status"),
        viewLoading: $("view-loading"), viewLock: $("view-lock"), viewLockTitle: $("view-lock-title"),
        viewPass: $("view-pass"), viewShowPass: $("view-show-pass"), viewUnlock: $("view-unlock"), viewError: $("view-error"),
        viewContent: $("view-content"), viewTitle: $("view-title"), viewText: $("view-text"), viewImg: $("view-img"),
        viewCopy: $("view-copy"), viewDownload: $("view-download"),
        viewFail: $("view-fail"), viewFailMsg: $("view-fail-msg"),
    };
}

// ── Small helpers ──
function setStatus(text, kind = "") {
    ui.status.textContent = text;
    ui.status.className = "status" + (kind ? " " + kind : "");
}
function fitTextarea(el, min = 72) {
    el.style.height = "0px";
    el.style.height = `${Math.max(min, el.scrollHeight + el.offsetHeight - el.clientHeight)}px`;
}
function formatSize(n) {
    return n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`;
}
const EXT = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/avif": "avif", "image/bmp": "bmp" };
const appLink = fragment => `${location.origin}${location.pathname}#${fragment}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
// Network failures surface as one error the UI knows how to explain.
const net = (url, opts) => fetch(url, opts).catch(() => { throw new Error("FETCH_FAILED"); });

const ERRORS = {
    MISSING_PASS: "This is locked. Enter the passphrase.",
    WRONG_PASS: "That passphrase does not open it.",
    INVALID_OR_PASS: "That code could not be opened. Check the passphrase.",
    NOT_FOUND: "Nothing is stored for that link any more.",
    FETCH_FAILED: "Could not fetch it. Check your connection and try again.",
    FOREIGN_LINK: "That dar.vin link does not point to a Duck2 note.",
    PASTE_FAILED: "Could not store the note on pastes.dev. Try again, or use Show full code.",
    IMGUR_OFF: "Image sharing is not set up on this site yet.",
    IMGUR_LIMIT: "Imgur's upload limit was reached. Try again later.",
    IMGUR_FAILED: "Imgur did not accept the upload. Try again.",
    IMGUR_CHANGED: "Imgur changed the uploaded file, so the locked image could not be kept. Try a smaller image.",
    IMGUR_UNVERIFIED: "The image was uploaded but could not be checked. Try again.",
    TOO_BIG: "That image is too large. Try a smaller one.",
    BAD_IMAGE: "That image could not be read.",
};
const errorText = e => ERRORS[e?.message] || "That is not a valid Duck2 link or code.";

// ── Services ──
function loadConfig() {
    config ||= fetch("/api/config")
        .then(r => (r.ok ? r.json() : {}))
        .catch(() => ({}))
        .then(c => ({ imgurClientId: typeof c?.imgurClientId === "string" ? c.imgurClientId : "", darvin: !!c?.darvin }));
    return config;
}
async function fetchPaste(id) {
    if (pasteCache.has(id)) return pasteCache.get(id);
    const res = await net(`/api/paste?id=${encodeURIComponent(id)}`);
    if (res.status === 404) throw new Error("NOT_FOUND");
    if (!res.ok) throw new Error("FETCH_FAILED");
    const code = normalize((await res.json()).code || "");
    if (!isDuckCode(code)) throw new Error("INVALID_DATA");
    pasteCache.set(id, code);
    return code;
}
async function uploadPaste(code) {
    const res = await fetch("/api/paste", {
        method: "POST",
        headers: { "content-type": "text/plain; charset=utf-8" },
        body: code,
    }).catch(() => null);
    const data = res ? await res.json().catch(() => ({})) : {};
    if (!res?.ok || !data.id) throw new Error("PASTE_FAILED");
    pasteCache.set(data.id, code);
    return data.id;
}
// Never throws: a link that can't be shortened is still a working link.
async function shorten(url) {
    if (!(await loadConfig()).darvin) return { error: "off" };
    try {
        const res = await fetch("/api/link", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ url }),
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.url) return { url: data.url };
        return { error: res.status === 429 ? "limit" : "failed" };
    } catch {
        return { error: "failed" };
    }
}
async function resolveDarvin(slug) {
    const res = await net(`/api/link?slug=${encodeURIComponent(slug)}`);
    if (res.status === 404) throw new Error("NOT_FOUND");
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.url) throw new Error("FETCH_FAILED");
    return data.url;
}
async function imgurUpload(blob, name) {
    const { imgurClientId } = await loadConfig();
    if (!imgurClientId) throw new Error("IMGUR_OFF");
    const form = new FormData();
    form.append("image", blob, name);
    form.append("type", "file");
    const res = await fetch(IMGUR_UPLOAD, {
        method: "POST",
        headers: { authorization: `Client-ID ${imgurClientId}` },
        body: form,
    }).catch(() => { throw new Error("IMGUR_FAILED"); });
    if (res.status === 429) throw new Error("IMGUR_LIMIT");
    const data = await res.json().catch(() => ({}));
    const m = /^https:\/\/i\.imgur\.com\/([A-Za-z0-9]{5,12})\.([a-z0-9]+)$/i.exec(data?.data?.link || "");
    if (!res.ok || !m) throw new Error("IMGUR_FAILED");
    return { id: m[1], link: m[0] };
}
async function fetchContainer(id) {
    const res = await net(`https://i.imgur.com/${id}.png`);
    // Imgur answers a deleted image with a redirect to its "removed" picture.
    if (res.status === 404 || /\/removed\.\w+$/.test(res.url)) throw new Error("NOT_FOUND");
    if (!res.ok) throw new Error("FETCH_FAILED");
    return unpackPng(await res.arrayBuffer());
}
// Read the upload back before handing out a link, so a re-encoded image
// fails here instead of on the recipient's screen.
async function verifyContainer(id, payload) {
    for (let attempt = 1; ; attempt++) {
        let back;
        try { back = await fetchContainer(id); }
        catch (e) {
            if (e.message === "CORRUPT") throw new Error("IMGUR_CHANGED");
            if (attempt >= 4) throw new Error("IMGUR_UNVERIFIED");
            await sleep(1500);
            continue;
        }
        if (back.length !== payload.length || back.some((b, i) => b !== payload[i])) throw new Error("IMGUR_CHANGED");
        return;
    }
}
async function shrinkImage(file) {
    let bmp;
    try { bmp = await createImageBitmap(file); } catch { throw new Error("BAD_IMAGE"); }
    let scale = Math.min(1, SHRINK_EDGE / Math.max(bmp.width, bmp.height));
    for (let i = 0; i < 6; i++, scale *= 0.8) {
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(bmp.width * scale));
        canvas.height = Math.max(1, Math.round(bmp.height * scale));
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#fff"; // JPEG has no transparency
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
        const blob = await new Promise(r => canvas.toBlob(r, "image/jpeg", 0.85));
        if (blob && blob.size <= LOCKED_IMAGE_MAX) {
            bmp.close?.();
            return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: "image/jpeg" };
        }
    }
    bmp.close?.();
    throw new Error("TOO_BIG");
}

// ── Opening anything ──
// A "sealed" item is fetched but not yet opened: { type, data | url, locked }.
async function loadRef(ref, progress = () => {}) {
    if (ref.kind === "darvin") {
        progress("Following the dar.vin link…");
        const inner = parseShareRef(await resolveDarvin(ref.slug), { allowDarvin: false });
        if (!inner) throw new Error("FOREIGN_LINK");
        return loadRef(inner, progress);
    }
    if (ref.kind === "direct") return { type: "image", url: ref.url, locked: false };
    if (ref.kind === "image") {
        progress("Fetching the image…");
        const data = await fetchContainer(ref.id);
        return { type: "image", data, locked: isLocked(data) };
    }
    let data = ref.data;
    if (ref.kind === "paste") {
        progress("Fetching the note…");
        data = z85Decode(await fetchPaste(ref.id));
    }
    return { type: unpackEnvelope(data)?.file ? "image" : "note", data, locked: isLocked(data) };
}
async function openSealed(sealed, pass) {
    if (sealed.url) return { type: "image", url: sealed.url };
    if (sealed.type === "image") {
        const { mime, bytes } = await openFile(sealed.data, pass);
        return { type: "image", url: URL.createObjectURL(new Blob([bytes], { type: mime })), mime, local: true };
    }
    return { type: "note", text: await openNote(sealed.data, pass) };
}
function setLink(a, opened) {
    if (opened.local) {
        a.href = opened.url;
        a.download = `duck2-image.${EXT[opened.mime] || "bin"}`;
        a.removeAttribute("target");
    } else {
        a.href = opened.url;
        a.removeAttribute("download");
        a.target = "_blank";
    }
}

// ── Result card ──
function clearResult() {
    ui.shortOutput.hidden = true;
    ui.shortOutput.textContent = "";
    ui.shortNote.hidden = true;
    ui.output.hidden = true;
    ui.output.value = "";
    ui.outputImage.hidden = true;
    ui.outputImg.removeAttribute("src");
    if (resultBlob) { URL.revokeObjectURL(resultBlob); resultBlob = ""; }
    ui.alts.hidden = true;
    closeAlt();
    ui.btnOpen.hidden = true;
    ui.btnCopy.hidden = false;
    ui.btnCopy.disabled = true;
    resultValue = "";
}
function showEmpty() {
    clearResult();
    ui.resultEmpty.hidden = false;
    ui.resultTitle.textContent = mode === "encrypt" ? "Result" : "Message";
}
function showBody(text, title) {
    clearResult();
    ui.resultTitle.textContent = title;
    ui.resultEmpty.hidden = true;
    ui.output.hidden = false;
    ui.output.value = text;
    fitTextarea(ui.output);
    resultValue = text;
    ui.btnCopy.disabled = !text;
}
function showOpened(opened) {
    if (opened.type === "note") { showBody(opened.text, "Message"); return; }
    clearResult();
    ui.resultTitle.textContent = "Image";
    ui.resultEmpty.hidden = true;
    ui.outputImage.hidden = false;
    ui.outputImg.src = opened.url;
    if (opened.local) resultBlob = opened.url;
    setLink(ui.btnOpen, opened);
    ui.btnOpen.textContent = opened.local ? "Download" : "Open";
    ui.btnOpen.dataset.icon = opened.local ? "download" : "external";
    ui.btnOpen.hidden = false;
    ui.btnCopy.hidden = true;
}
function shareNoteText(s) {
    let t = s.kind === "image" && !s.locked
        ? "The link opens the image straight on Imgur. Anyone with it can see the image."
        : s.locked
            ? "Anyone with this link gets a passphrase prompt. Send the passphrase separately."
            : "Anyone with this link can read the note.";
    if (s.stored) t += " This long note is kept on pastes.dev, so the link stops working after about 30 days.";
    if (s.resized) t += " The image was scaled down to fit.";
    return t;
}
function shareStatus(s) {
    if (s.darvin) return ["Short link ready.", "ok"];
    if (s.shortError === "off") return ["Link ready. dar.vin is not set up on this site, so this is the full link.", "ok"];
    if (s.shortError === "limit") return ["dar.vin's rate limit was reached, so here is the full link instead. It works the same.", ""];
    return ["dar.vin could not shorten it right now, so here is the full link instead. It works the same.", ""];
}
function showShare(s) {
    clearResult();
    ui.resultEmpty.hidden = true;
    const link = s.darvin || s.long;
    if (s.darvin) {
        ui.resultTitle.textContent = "Short link";
        ui.shortOutput.hidden = false;
        ui.shortOutput.textContent = s.darvin.replace(/^https?:\/\//, "");
    } else {
        ui.resultTitle.textContent = "Link";
        ui.output.hidden = false;
        ui.output.value = link;
        fitTextarea(ui.output);
    }
    ui.shortNote.hidden = false;
    ui.shortNote.textContent = shareNoteText(s);
    resultValue = link;
    ui.btnCopy.disabled = false;
    setLink(ui.btnOpen, { url: link });
    ui.btnOpen.textContent = "Open";
    ui.btnOpen.dataset.icon = "external";
    ui.btnOpen.hidden = false;
    const available = {
        long: !!s.darvin && !s.imgur,
        imgur: !!s.darvin && !!s.imgur,
        paste: s.kind === "note",
        full: s.kind === "note",
    };
    ui.altButtons.forEach(b => { b.hidden = !available[b.dataset.alt]; });
    ui.alts.hidden = !Object.values(available).some(Boolean);
    const [text, kind] = shareStatus(s);
    setStatus(text, kind);
}
function closeAlt() {
    altOpen = "";
    ui.altPanel.hidden = true;
    ui.altButtons.forEach(b => b.setAttribute("aria-expanded", "false"));
}

// ── Composer ──
function contentKey() {
    return (attachment ? `img:${attachment.id}` : `txt:${ui.input.value}`) + "\u0000" + ui.pass.value;
}
function syncComposer() {
    const img = mode === "encrypt" && !!attachment;
    ui.input.hidden = img;
    ui.attachment.hidden = !img;
    ui.lblInput.textContent = mode === "decrypt" ? "Code" : img ? "Image" : "Message";
}

// A rough guide, not a guarantee: length and variety raise the level,
// repeats and the most common openers lower it.
const STRENGTH = ["", "Weak", "Fair", "Good", "Strong"];
function passStrength(p) {
    if (!p) return 0;
    if (p.length < 8) return 1;
    const kinds = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter(re => re.test(p)).length;
    let score = Math.min(p.length, new Set(p).size * 2) * (1 + kinds) / 2;
    if (/^\d+$/.test(p) || /^(?:pass(?:word)?|qwerty|letmein|welcome|admin|iloveyou|abc|123)/i.test(p)) score /= 3;
    return score < 12 ? 1 : score < 20 ? 2 : score < 30 ? 3 : 4;
}

function updateStats() {
    const img = mode === "encrypt" && !!attachment;
    const n = ui.input.value.length;
    ui.statChars.textContent = img ? formatSize(attachment.size) : n === 1 ? "1 character" : `${n} characters`;
    const busy = ui.btnGo.dataset.busy === "1";
    const hasText = !!ui.input.value.trim();
    if (!busy) ui.btnGo.disabled = mode === "encrypt" ? !(img || hasText) : !parseShareRef(ui.input.value);
    ui.btnShowFull.hidden = mode !== "encrypt" || img;
    ui.btnShowFull.disabled = busy || !hasText;
    ui.btnImage.hidden = mode !== "encrypt" || !imagesEnabled;
    ui.btnClearPass.hidden = !ui.pass.value;
    const level = mode === "encrypt" ? passStrength(ui.pass.value) : 0;
    ui.strength.hidden = !level;
    ui.strength.dataset.level = level;
    ui.strengthLabel.textContent = STRENGTH[level];
    const what = img ? "image" : "note";
    ui.passHint.textContent = mode === "decrypt"
        ? "Enter it here if it was locked."
        : level
            ? `Only someone with this passphrase can open the ${what}. Send it separately from the link.`
            : img
                ? "Optional. Leave it blank and the image goes to Imgur as it is."
                : "Optional. Leave it blank and anyone with the link can read the note.";
}

function setBusy(on) {
    ui.btnGo.dataset.busy = on ? "1" : "";
    ui.btnGo.textContent = on ? "Working…" : (mode === "encrypt" ? "Create link" : "Decrypt");
    updateStats();
}

function themeLabel() {
    const light = document.documentElement.classList.contains("light");
    const label = light ? "Switch to dark theme" : "Switch to light theme";
    ui.btnTheme.setAttribute("aria-label", label);
    ui.btnTheme.title = label;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = light ? "#f3f5fb" : "#080a10";
}

function setPassVisible(input, button, show) {
    const label = show ? "Hide passphrase" : "Show passphrase";
    input.type = show ? "text" : "password";
    button.setAttribute("aria-label", label);
    button.title = label;
    button.setAttribute("aria-pressed", show ? "true" : "false");
}

const app = {
    toggleTheme() {
        const light = !document.documentElement.classList.contains("light");
        const apply = () => {
            document.documentElement.classList.toggle("light", light);
            themeLabel();
        };
        try { localStorage.setItem("duck2-theme", light ? "light" : "dark"); } catch { /* private mode */ }
        // Cross-fade the two themes where the browser can.
        const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        if (document.startViewTransition && !calm) document.startViewTransition(apply);
        else apply();
    },

    syncUi() {
        const enc = mode === "encrypt";
        document.documentElement.dataset.mode = mode;
        syncComposer();
        ui.input.placeholder = enc ? "Write the note you want to share" : "Paste a dar.vin link, a short code or a full Duck code";
        ui.pass.placeholder = enc ? "Leave blank to skip" : "Only if it was locked";
        if (ui.btnGo.dataset.busy !== "1") ui.btnGo.textContent = enc ? "Create link" : "Decrypt";
        ui.resultEmpty.textContent = enc ? "Your link will show up here." : "The note will show up here.";
        if (!ui.resultEmpty.hidden) ui.resultTitle.textContent = enc ? "Result" : "Message";
        ui.btnEnc.setAttribute("aria-selected", enc ? "true" : "false");
        ui.btnDec.setAttribute("aria-selected", enc ? "false" : "true");
        updateStats();
    },

    setMode(next) {
        if (next === mode) return;
        drafts[mode] = ui.input.value;
        mode = next;
        ui.input.value = drafts[mode];
        app.syncUi();
        app.schedule();
    },

    schedule() {
        clearTimeout(timer);
        gen += 1;
        setBusy(false);
        ui.pass.classList.remove("err");
        if (mode === "encrypt") {
            if (share && share.key === contentKey()) { showShare(share); return; }
            share = null;
            showEmpty();
            if (attachment) setStatus(ui.pass.value
                ? "Passphrase set. The image is encrypted here before it goes to Imgur."
                : "Image ready. Create a link to upload it to Imgur.");
            else if (!ui.input.value.trim()) setStatus(INTRO.encrypt());
            else setStatus(ui.pass.value
                ? "Passphrase set. Nothing leaves this page until you create a link."
                : "Ready. Create a link to share it, or show the full code.");
            return;
        }
        const text = ui.input.value;
        showEmpty();
        if (!text.trim()) { setStatus(INTRO.decrypt()); return; }
        const ref = parseShareRef(text);
        if (ref?.kind === "inline") {
            setStatus("Opening the code…", "busy");
            timer = setTimeout(() => app.decrypt(), 250);
            return;
        }
        setStatus(ref ? "Press Decrypt to open it." : INTRO.decrypt());
    },

    async createLink() {
        if (share && share.key === contentKey()) { showShare(share); return; }
        const myGen = ++gen;
        clearTimeout(timer);
        const key = contentKey(), pass = ui.pass.value;
        setBusy(true);
        try {
            let s;
            if (attachment) {
                const att = attachment;
                if (!pass) {
                    if (att.size > IMGUR_MAX) throw new Error("TOO_BIG");
                    setStatus("Uploading to Imgur…", "busy");
                    const up = await imgurUpload(att.file, att.name);
                    s = { kind: "image", locked: false, imgur: up.link, long: up.link };
                } else {
                    setStatus("Locking the image…", "busy");
                    let bytes = new Uint8Array(await att.file.arrayBuffer()), mime = att.type, resized = false;
                    if (bytes.length > LOCKED_IMAGE_MAX) { ({ bytes, mime } = await shrinkImage(att.file)); resized = true; }
                    const env = await sealFile(bytes, mime, pass);
                    const png = await packPng(env);
                    if (png.size > LOCKED_PNG_MAX) throw new Error("TOO_BIG");
                    if (myGen !== gen) return;
                    setStatus("Uploading the locked image to Imgur…", "busy");
                    const up = await imgurUpload(png, "duck2.png");
                    if (myGen !== gen) return;
                    setStatus("Checking the upload…", "busy");
                    await verifyContainer(up.id, env);
                    s = { kind: "image", locked: true, resized, long: appLink(LINK_IMAGE + up.id) };
                }
            } else {
                setStatus(pass ? "Locking the note…" : "Preparing the note…", "busy");
                const env = await sealNote(ui.input.value, pass);
                s = { kind: "note", locked: !!pass, code: z85Encode(env), pasteId: "", long: appLink(LINK_NOTE + b64urlEncode(env)) };
                // dar.vin takes links up to 2048 characters. A longer note is
                // stored on pastes.dev and the link points at that instead.
                if (s.long.length > MAX_LINK) {
                    if (myGen !== gen) return;
                    setStatus("This note is long, so it goes to pastes.dev first…", "busy");
                    s.pasteId = await uploadPaste(s.code);
                    s.long = appLink(s.pasteId);
                    s.stored = true;
                }
            }
            if (myGen !== gen) return;
            setStatus("Shortening with dar.vin…", "busy");
            const short = await shorten(s.long);
            if (myGen !== gen) return;
            s.darvin = short.url || "";
            s.shortError = short.error || "";
            s.key = key;
            share = s;
            showShare(s);
        } catch (e) {
            if (myGen !== gen) return;
            showEmpty();
            setStatus(errorText(e), "error");
        } finally {
            if (myGen === gen) setBusy(false);
        }
    },

    async decrypt() {
        const ref = parseShareRef(ui.input.value);
        if (!ref) return;
        const myGen = ++gen;
        clearTimeout(timer);
        const pass = ui.pass.value;
        setBusy(true);
        try {
            const sealed = await loadRef(ref, msg => { if (myGen === gen) setStatus(msg, "busy"); });
            if (myGen !== gen) return;
            if (sealed.locked) setStatus("Decrypting…", "busy");
            const opened = await openSealed(sealed, pass);
            if (myGen !== gen) {
                if (opened.local) URL.revokeObjectURL(opened.url);
                return;
            }
            showOpened(opened);
            setStatus(sealed.locked ? "Decrypted." : "Opened.", "ok");
        } catch (e) {
            if (myGen !== gen) return;
            showEmpty();
            if (["MISSING_PASS", "WRONG_PASS", "INVALID_OR_PASS"].includes(e.message)) {
                ui.pass.classList.add("err");
                if (e.message !== "INVALID_OR_PASS") ui.pass.focus();
            }
            setStatus(errorText(e), "error");
        } finally {
            if (myGen === gen) setBusy(false);
        }
    },

    async confirm() {
        if (ui.btnGo.disabled) return;
        if (mode === "encrypt") await app.createLink();
        else await app.decrypt();
        // On a phone the result sits below the fold, so bring it into view,
        // unless the passphrase field was just focused to ask for input.
        if (document.activeElement !== ui.pass) ui.result.scrollIntoView({ block: "nearest", behavior: "smooth" });
    },

    // The whole note as a Duck code, without uploading anything.
    async showFull() {
        if (ui.btnShowFull.disabled || attachment) return;
        const myGen = ++gen;
        clearTimeout(timer);
        const pass = ui.pass.value;
        setBusy(true);
        setStatus(pass ? "Locking the note…" : "Preparing the full code…", "busy");
        try {
            const code = await duckEncrypt(ui.input.value, pass);
            if (myGen !== gen) return;
            showBody(code, "Full code");
            setStatus(pass
                ? "Full code is ready and locked with your passphrase. Nothing was uploaded."
                : "Full code is ready. Nothing was uploaded. It works offline and does not expire.", "ok");
        } catch {
            if (myGen !== gen) return;
            showEmpty();
            setStatus("Could not build the full code.", "error");
        } finally {
            if (myGen === gen) setBusy(false);
        }
    },

    async showAlt(which, button) {
        const s = share;
        if (!s) return;
        if (altOpen === which) { closeAlt(); return; }
        if (which === "paste" && !s.pasteId) {
            button.disabled = true;
            setStatus("Creating a pastes.dev code…", "busy");
            try { s.pasteId = await uploadPaste(s.code); }
            catch {
                if (share === s) setStatus("Could not create a pastes.dev code. Try again.", "error");
                return;
            } finally { button.disabled = false; }
            if (share !== s) return;
            showShare(s); // restores the status line
        }
        const text = {
            long: [s.long, s.stored
                ? "The same link without dar.vin."
                : s.kind === "image"
                    ? "The same link without dar.vin. It needs the passphrase too."
                    : "The same link without dar.vin. The note is inside the link itself."],
            imgur: [s.imgur, "Direct image link on Imgur."],
            paste: [s.pasteId, "Paste this code into Decrypt. pastes.dev codes expire after about 30 days."],
            full: [s.code, "The whole note as text. It never expires and opens in Decrypt, even offline."
                + (s.locked ? " It still needs the passphrase." : "")],
        }[which];
        altOpen = which;
        ui.altValue.value = text[0];
        ui.altHint.textContent = text[1];
        ui.altPanel.hidden = false;
        fitTextarea(ui.altValue, 48);
        ui.altButtons.forEach(b => b.setAttribute("aria-expanded", b.dataset.alt === which ? "true" : "false"));
        ui.btnCopyAlt.textContent = "Copy";
    },

    async attachImage(file) {
        if (!file) return;
        if (!(await loadConfig()).imgurClientId) { setStatus(ERRORS.IMGUR_OFF, "error"); return; }
        if (!IMAGE_TYPES.includes(file.type)) {
            setStatus("That file type cannot be shared. Use PNG, JPEG, GIF, WebP, AVIF or BMP.", "error");
            return;
        }
        if (file.size > IMGUR_MAX) { setStatus("That image is over 20 MB, which is more than Imgur takes.", "error"); return; }
        if (mode !== "encrypt") app.setMode("encrypt");
        if (attachment) URL.revokeObjectURL(attachment.url);
        attachment = { id: ++attachSeq, file, type: file.type, name: file.name || "image", size: file.size, url: URL.createObjectURL(file) };
        ui.attachmentImg.src = attachment.url;
        ui.attachmentMeta.textContent = `${attachment.name} · ${formatSize(file.size)}`;
        syncComposer();
        app.schedule();
    },

    removeImage() {
        if (!attachment) return;
        URL.revokeObjectURL(attachment.url);
        attachment = null;
        ui.attachmentImg.removeAttribute("src");
        syncComposer();
        app.schedule();
        ui.input.focus();
    },

    applyExternalText(txt) {
        const text = (txt ?? "").trim();
        const ref = parseShareRef(text);
        // One token that opens something goes to Decrypt; anything else is a note.
        if (ref && (ref.kind === "inline" || !/\s/.test(text))) {
            if (mode !== "decrypt") drafts[mode] = ui.input.value;
            drafts.decrypt = text;
            mode = "decrypt";
            ui.input.value = text;
            app.syncUi();
            app.schedule();
            return;
        }
        if (attachment && mode === "encrypt") app.removeImage();
        ui.input.value = txt ?? "";
        drafts[mode] = ui.input.value;
        app.schedule();
    },

    async paste() {
        // Images first, where the browser lets us read them.
        if (mode === "encrypt" && imagesEnabled && navigator.clipboard?.read) {
            try {
                for (const item of await navigator.clipboard.read()) {
                    const type = item.types.find(t => IMAGE_TYPES.includes(t));
                    if (type) {
                        const blob = await item.getType(type);
                        return app.attachImage(new File([blob], `pasted.${EXT[type]}`, { type }));
                    }
                }
            } catch { /* fall back to text */ }
        }
        try { app.applyExternalText(await navigator.clipboard.readText()); }
        catch { setStatus("Could not read the clipboard. Use the system paste shortcut instead.", "error"); }
    },

    clear() {
        ui.input.value = "";
        drafts[mode] = "";
        if (mode === "encrypt" && attachment) {
            URL.revokeObjectURL(attachment.url);
            attachment = null;
            ui.attachmentImg.removeAttribute("src");
        }
        share = null;
        app.syncUi();
        app.schedule();
        ui.input.focus();
    },

    clearPass() {
        ui.pass.value = "";
        setPassVisible(ui.pass, ui.btnShowPass, false);
        app.schedule();
        ui.pass.focus();
    },

    async copyText(value, button, label) {
        if (!value) return;
        try {
            await navigator.clipboard.writeText(value);
            button.textContent = "Copied";
            button.classList.add("done");
            clearTimeout(button.copyTimer);
            button.copyTimer = setTimeout(() => {
                button.textContent = label;
                button.classList.remove("done");
            }, 1600);
        } catch {
            setStatus("Could not copy automatically. Select the text and copy it.", "error");
        }
    },

    copy() { return app.copyText(resultValue, ui.btnCopy, "Copy"); },
    copyAlt() { return app.copyText(ui.altValue.value, ui.btnCopyAlt, "Copy"); },
};

// ═══════════════════════════════════════════
//  VIEWER — what a share link opens
// ═══════════════════════════════════════════
const viewer = {
    sealed: null,
    blob: "",

    show(part) {
        ui.viewLoading.hidden = part !== "loading";
        ui.viewLock.hidden = part !== "lock";
        ui.viewContent.hidden = part !== "content";
        ui.viewFail.hidden = part !== "fail";
    },

    reset() {
        viewGen += 1;
        this.sealed = null;
        if (this.blob) { URL.revokeObjectURL(this.blob); this.blob = ""; }
        ui.viewImg.removeAttribute("src");
        ui.viewText.textContent = "";
        ui.viewPass.value = "";
        ui.viewPass.classList.remove("err");
        ui.viewError.hidden = true;
        setPassVisible(ui.viewPass, ui.viewShowPass, false);
    },

    async open(raw) {
        document.documentElement.dataset.view = "share";
        this.reset();
        this.show("loading");
        const myGen = viewGen;
        const ref = parseShareRef(raw);
        if (!ref) { this.fail("This link does not contain a Duck2 note."); return; }
        try {
            const sealed = await loadRef(ref, msg => { if (myGen === viewGen) ui.viewLoading.textContent = msg; });
            if (myGen !== viewGen) return;
            this.sealed = sealed;
            if (sealed.locked) { this.ask(); return; }
            this.reveal(await openSealed(sealed, ""));
        } catch (e) {
            if (myGen !== viewGen) return;
            // Old codes do not say whether they are locked; failing to open
            // one without a passphrase is the hint.
            if ((e.message === "INVALID_OR_PASS" || e.message === "MISSING_PASS") && this.sealed) this.ask();
            else this.fail(errorText(e));
        } finally {
            ui.viewLoading.textContent = "Opening…";
        }
    },

    ask() {
        const what = this.sealed.type === "image" ? "image" : "note";
        ui.viewLockTitle.textContent = `This ${what} is locked`;
        document.title = `Locked ${what} — Duck2`;
        this.show("lock");
        ui.viewPass.focus();
    },

    async unlock(e) {
        e.preventDefault();
        const pass = ui.viewPass.value;
        if (!this.sealed || ui.viewUnlock.dataset.busy === "1") return;
        if (!pass) { this.passError("Enter the passphrase."); return; }
        const myGen = viewGen;
        ui.viewUnlock.dataset.busy = "1";
        ui.viewUnlock.textContent = "Unlocking…";
        ui.viewError.hidden = true;
        try {
            const opened = await openSealed(this.sealed, pass);
            if (myGen !== viewGen) return;
            this.reveal(opened);
        } catch (err) {
            if (myGen !== viewGen) return;
            this.passError(err.message === "WRONG_PASS" ? "That passphrase does not open it." : errorText(err));
        } finally {
            ui.viewUnlock.dataset.busy = "";
            ui.viewUnlock.textContent = "Unlock";
        }
    },

    passError(text) {
        ui.viewError.textContent = text;
        ui.viewError.hidden = false;
        ui.viewPass.classList.remove("err");
        void ui.viewPass.offsetWidth; // restart the shake
        ui.viewPass.classList.add("err");
        ui.viewPass.select();
    },

    reveal(opened) {
        const image = opened.type === "image";
        ui.viewTitle.textContent = image ? "Image" : "Note";
        document.title = `${image ? "Image" : "Note"} — Duck2`;
        ui.viewText.hidden = image;
        ui.viewImg.hidden = !image;
        ui.viewCopy.hidden = image;
        ui.viewDownload.hidden = !image;
        if (image) {
            if (opened.local) this.blob = opened.url;
            ui.viewImg.src = opened.url;
            setLink(ui.viewDownload, opened);
            ui.viewDownload.textContent = opened.local ? "Download" : "Open";
            ui.viewDownload.dataset.icon = opened.local ? "download" : "external";
        } else {
            ui.viewText.textContent = opened.text;
        }
        this.show("content");
    },

    fail(text) {
        ui.viewFailMsg.textContent = text;
        document.title = "Duck2";
        this.show("fail");
    },
};

function route() {
    let raw = "";
    try { raw = decodeURIComponent(location.hash.slice(1)); } catch { raw = location.hash.slice(1); }
    if (raw.trim()) { viewer.open(raw); return; }
    viewer.reset();
    delete document.documentElement.dataset.view;
    document.title = "Duck2 — encrypt a note, share a short link";
}

document.addEventListener("DOMContentLoaded", () => {
    initUI();
    themeLabel();
    ui.btnEnc.addEventListener("click", () => app.setMode("encrypt"));
    ui.btnDec.addEventListener("click", () => app.setMode("decrypt"));
    ui.btnTheme.addEventListener("click", () => app.toggleTheme());
    ui.btnPaste.addEventListener("click", () => app.paste());
    ui.btnClear.addEventListener("click", () => app.clear());
    ui.btnImage.addEventListener("click", () => ui.fileInput.click());
    ui.fileInput.addEventListener("change", () => {
        app.attachImage(ui.fileInput.files[0]);
        ui.fileInput.value = "";
    });
    ui.btnRemoveImage.addEventListener("click", () => app.removeImage());
    ui.btnShowPass.addEventListener("click", () => {
        setPassVisible(ui.pass, ui.btnShowPass, ui.pass.type === "password");
        ui.pass.focus();
    });
    ui.btnClearPass.addEventListener("click", () => app.clearPass());
    ui.btnGo.addEventListener("click", () => app.confirm());
    ui.btnShowFull.addEventListener("click", () => app.showFull());
    ui.btnCopy.addEventListener("click", () => app.copy());
    ui.btnCopyAlt.addEventListener("click", () => app.copyAlt());
    ui.altButtons.forEach(b => b.addEventListener("click", () => app.showAlt(b.dataset.alt, b)));
    ui.shortOutput.addEventListener("click", () => app.copy());
    window.addEventListener("resize", () => {
        if (!ui.output.hidden) fitTextarea(ui.output);
        if (!ui.altPanel.hidden) fitTextarea(ui.altValue, 48);
    });
    ui.input.addEventListener("input", () => app.schedule());
    ui.pass.addEventListener("input", () => {
        if (mode === "decrypt" && parseShareRef(ui.input.value)) {
            ui.pass.classList.remove("err");
            showEmpty();
            setStatus("Press Decrypt to try this passphrase.");
            updateStats();
            return;
        }
        app.schedule();
    });
    ui.input.addEventListener("keydown", e => {
        if (e.key === "Enter" && !e.shiftKey && mode === "decrypt" && parseShareRef(ui.input.value)) {
            e.preventDefault();
            app.confirm();
        }
    });

    // Images can also be pasted or dropped straight onto the note.
    document.addEventListener("paste", e => {
        if (document.documentElement.dataset.view || !imagesEnabled) return;
        const file = [...(e.clipboardData?.files || [])].find(f => IMAGE_TYPES.includes(f.type));
        if (!file) return;
        e.preventDefault();
        app.attachImage(file);
    });
    const hasFiles = e => [...(e.dataTransfer?.types || [])].includes("Files");
    ui.composer.addEventListener("dragover", e => {
        if (!imagesEnabled || !hasFiles(e)) return;
        e.preventDefault();
        ui.composer.classList.add("dragging");
    });
    ui.composer.addEventListener("dragleave", e => {
        if (!ui.composer.contains(e.relatedTarget)) ui.composer.classList.remove("dragging");
    });
    ui.composer.addEventListener("drop", e => {
        if (!imagesEnabled || !hasFiles(e)) return;
        e.preventDefault();
        ui.composer.classList.remove("dragging");
        app.attachImage(e.dataTransfer.files[0]);
    });

    ui.viewLock.addEventListener("submit", e => viewer.unlock(e));
    ui.viewPass.addEventListener("input", () => { ui.viewPass.classList.remove("err"); ui.viewError.hidden = true; });
    ui.viewShowPass.addEventListener("click", () => {
        setPassVisible(ui.viewPass, ui.viewShowPass, ui.viewPass.type === "password");
        ui.viewPass.focus();
    });
    ui.viewCopy.addEventListener("click", () => app.copyText(ui.viewText.textContent, ui.viewCopy, "Copy"));

    document.addEventListener("keydown", e => {
        const mod = e.metaKey || e.ctrlKey;
        if (!mod || document.documentElement.dataset.view) return;
        const key = e.key.toLowerCase();
        if (key === "e") { e.preventDefault(); app.setMode("encrypt"); }
        else if (key === "d") { e.preventDefault(); app.setMode("decrypt"); }
        else if (key === "enter") { e.preventDefault(); app.confirm(); }
    });
    // Show the modifier key this platform actually uses.
    const modKey = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent) ? "⌘" : "Ctrl";
    document.querySelectorAll("kbd.mod").forEach(el => { el.textContent = modKey; });
    ui.btnGo.dataset.kbd = `${modKey} ↵`;

    app.syncUi();
    app.schedule();
    loadConfig().then(cfg => {
        imagesEnabled = !!cfg.imgurClientId;
        updateStats();
        if (mode === "encrypt" && !ui.input.value.trim() && !attachment) setStatus(INTRO.encrypt());
    });
    window.addEventListener("hashchange", route);
    route();
    if (!document.documentElement.dataset.view) ui.input.focus();
});

window.app = app;
