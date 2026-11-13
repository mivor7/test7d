// ═══════════════════════════════════════════
//  DUCK2 — Crypto Engine
// ═══════════════════════════════════════════
const Z85 = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ.-:+=^!/*?&<>()[]{}@%$#";
const Z85_MAP = new Map([...Z85].map((c, i) => [c, i]));
const ITERATIONS = 600000, SALT_LEN = 16, IV_LEN = 12;
const M0 = 68, M1 = 50, VER = 1, F_ENC = 1;
const normalize = s => (s || "").replace(/\s+/g, "");

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
const compress = async txt => new Uint8Array(await new Response(new Blob([txt]).stream().pipeThrough(new CompressionStream("deflate-raw"))).arrayBuffer());
const decompress = async u8 => new Response(new Blob([u8]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).text();
async function deriveKey(pass, salt) {
    const raw = await crypto.subtle.importKey("raw", new TextEncoder().encode(pass), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: ITERATIONS, hash: "SHA-256" },
        raw, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
function packEnvelope(body, enc) {
    const out = new Uint8Array(body.length + 4);
    out[0] = M0; out[1] = M1; out[2] = VER; out[3] = enc ? F_ENC : 0;
    out.set(body, 4); return out;
}
function unpackEnvelope(data) {
    if (data.length >= 4 && data[0] === M0 && data[1] === M1 && data[2] === VER)
        return { encrypted: (data[3] & F_ENC) !== 0, body: data.slice(4) };
    return null;
}
async function decryptSealed(body, pass) {
    if (!pass) throw new Error("MISSING_PASS");
    if (body.length < SALT_LEN + IV_LEN + 16) throw new Error("CORRUPT");
    const salt = body.slice(0, SALT_LEN), iv = body.slice(SALT_LEN, SALT_LEN + IV_LEN);
    const sealed = body.slice(SALT_LEN + IV_LEN), key = await deriveKey(pass, salt);
    try { return decompress(new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, sealed))); }
    catch { throw new Error("WRONG_PASS"); }
}
async function duckEncrypt(text, pass) {
    const compressed = await compress(text);
    if (!pass) return z85Encode(packEnvelope(compressed, false));
    const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
    const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
    const key = await deriveKey(pass, salt);
    const enc = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, compressed);
    const buf = new Uint8Array(SALT_LEN + IV_LEN + enc.byteLength);
    buf.set(salt, 0); buf.set(iv, SALT_LEN); buf.set(new Uint8Array(enc), SALT_LEN + IV_LEN);
    return z85Encode(packEnvelope(buf, true));
}
async function duckDecrypt(code, pass) {
    const data = z85Decode(code), env = unpackEnvelope(data);
    if (env) { if (!env.encrypted) return decompress(env.body); return decryptSealed(env.body, pass); }
    if (pass) return decryptSealed(data, pass);
    try { return await decompress(data); } catch { throw new Error("INVALID_OR_PASS"); }
}
function parsePasteRef(raw) {
    const t = (raw || "").trim();
    if (!t || isDuckCode(t)) return "";
    if (/^https?:\/\//i.test(t)) {
        try {
            const url = new URL(t);
            const id = url.pathname.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean).pop() || "";
            const host = url.hostname.replace(/^www\./, "");
            if (["paste.rs", "pastes.dev", "api.pastes.dev"].includes(host) && /^[A-Za-z0-9_-]+$/.test(id) && id !== "web") return id;
        } catch { /* not a usable link */ }
        return "";
    }
    return /^[A-Za-z0-9_-]+$/.test(t) ? t : "";
}

// ═══════════════════════════════════════════
//  APP
// ═══════════════════════════════════════════
const $ = id => document.getElementById(id);
let mode = "encrypt", timer, gen = 0;
let draftDuckCode = "", publishedId = "", publishedFromDuckCode = "";
const drafts = { encrypt: "", decrypt: "" };
const pasteCache = new Map();
let ui;

const INTRO = {
    encrypt: "Write a note. The full code appears here, then you can create a short code to send.",
    decrypt: "Paste a short code or a full Duck code. The note will appear here.",
};

function initUI() {
    ui = {
        input: $("input"), pass: $("pass"),
        btnEnc: $("mode-enc"), btnDec: $("mode-dec"),
        btnTheme: $("btn-theme"), btnPaste: $("btn-paste"), btnClear: $("btn-clear"),
        btnShowPass: $("btn-show-pass"), btnClearPass: $("btn-clear-pass"),
        btnGo: $("btn-go"), btnShowFull: $("btn-show-full"),
        btnCopy: $("btn-copy"), btnCopyFull: $("btn-copy-full"),
        lblInput: $("lbl-input"), passHint: $("pass-hint"),
        resultTitle: $("result-title"), resultEmpty: $("result-empty"),
        shortOutput: $("short-output"), shortNote: $("short-note"),
        output: $("output"), fullDetails: $("full-details"), fullCode: $("full-code"),
        statChars: $("stat-chars"), status: $("stat-status"),
    };
}

function setStatus(text, kind = "") {
    ui.status.textContent = text;
    ui.status.className = "status" + (kind ? " " + kind : "");
}

function fitTextarea(el) {
    el.style.height = "0px";
    el.style.height = `${Math.max(72, el.scrollHeight)}px`;
}

function showEmpty() {
    ui.shortOutput.hidden = true;
    ui.shortOutput.textContent = "";
    ui.shortNote.hidden = true;
    ui.output.hidden = true;
    ui.output.value = "";
    ui.fullDetails.hidden = true;
    ui.fullCode.value = "";
    ui.resultEmpty.hidden = false;
    ui.resultTitle.textContent = mode === "encrypt" ? "Result" : "Message";
    ui.btnCopy.disabled = true;
    ui.btnCopy.textContent = "Copy";
}

function showBody(text, title) {
    ui.resultTitle.textContent = title;
    ui.resultEmpty.hidden = true;
    ui.shortOutput.hidden = true;
    ui.shortNote.hidden = true;
    ui.fullDetails.hidden = true;
    ui.output.hidden = false;
    ui.output.value = text;
    fitTextarea(ui.output);
    ui.btnCopy.disabled = !text;
}

function showShort(id) {
    ui.resultTitle.textContent = "Short code";
    ui.resultEmpty.hidden = true;
    ui.output.hidden = true;
    ui.shortOutput.hidden = false;
    ui.shortOutput.textContent = id;
    ui.shortNote.hidden = false;
    ui.fullDetails.hidden = false;
    ui.fullCode.value = draftDuckCode;
    if (ui.fullDetails.open) fitTextarea(ui.fullCode);
    ui.btnCopy.disabled = !id;
}

function updateStats() {
    const n = ui.input.value.length;
    ui.statChars.textContent = n === 1 ? "1 character" : `${n} characters`;
    const busy = ui.btnGo.dataset.busy === "1";
    const hasText = !!ui.input.value.trim();
    const canDecrypt = !!(isDuckCode(ui.input.value) || parsePasteRef(ui.input.value));
    if (!busy) ui.btnGo.disabled = mode === "encrypt" ? !hasText : !canDecrypt;
    const lockLocal = mode === "encrypt" && !!ui.pass.value;
    ui.btnShowFull.hidden = !lockLocal;
    ui.btnShowFull.disabled = busy || !hasText;
    ui.btnClearPass.hidden = !ui.pass.value;
}

function setBusy(on) {
    ui.btnGo.dataset.busy = on ? "1" : "";
    ui.btnGo.textContent = on ? "Working…" : (mode === "encrypt" ? "Create short code" : "Decrypt");
    updateStats();
}

function themeLabel() {
    const light = document.documentElement.classList.contains("light");
    ui.btnTheme.textContent = light ? "Dark theme" : "Light theme";
}

const app = {
    toggleTheme() {
        const light = !document.documentElement.classList.contains("light");
        document.documentElement.classList.toggle("light", light);
        try { localStorage.setItem("duck2-theme", light ? "light" : "dark"); } catch { /* private mode */ }
        themeLabel();
    },

    syncUi() {
        const enc = mode === "encrypt";
        ui.lblInput.textContent = enc ? "Message" : "Code";
        ui.input.placeholder = enc ? "Write the note you want to share" : "Paste a short code or a full Duck code";
        ui.pass.placeholder = enc ? "Leave blank to skip" : "Only if the note was locked";
        ui.passHint.textContent = enc
            ? "Optional. Leave it blank and anyone with the code can read the note."
            : "Enter it here if the note was locked. Share it separately from the code.";
        if (ui.btnGo.dataset.busy !== "1") ui.btnGo.textContent = enc ? "Create short code" : "Decrypt";
        ui.resultEmpty.textContent = enc ? "The code will show up here." : "The note will show up here.";
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
        updateStats();
        const text = ui.input.value;
        if (!text.trim()) {
            if (mode === "encrypt") {
                draftDuckCode = "";
                publishedId = "";
                publishedFromDuckCode = "";
            }
            showEmpty();
            ui.pass.classList.remove("err");
            setStatus(INTRO[mode]);
            return;
        }
        if (mode === "decrypt") {
            if (isDuckCode(text)) {
                setStatus("Opening the code…");
                timer = setTimeout(() => app.process(), 250);
                return;
            }
            showEmpty();
            if (parsePasteRef(text)) setStatus("Press Decrypt to open this code.");
            else setStatus("Paste a short code or a full Duck code.");
            return;
        }
        if (ui.pass.value) {
            draftDuckCode = "";
            publishedId = "";
            publishedFromDuckCode = "";
            showEmpty();
            setStatus("Passphrase set. Nothing is uploaded until you create a short code. Show the full code if you want to copy it without sharing.");
            return;
        }
        timer = setTimeout(() => app.process(), 200);
    },

    clearOut() { showEmpty(); },

    async resolveDuckCode(ref) {
        if (pasteCache.has(ref)) return pasteCache.get(ref);
        const res = await fetch(`/api/paste?id=${encodeURIComponent(ref)}`);
        if (res.status === 404) throw new Error("PASTE_NOT_FOUND");
        if (!res.ok) throw new Error("FETCH_FAILED");
        const data = await res.json();
        const code = normalize(data.code || "");
        if (!isDuckCode(code)) throw new Error("INVALID_DATA");
        pasteCache.set(ref, code);
        if (data.id) pasteCache.set(data.id, code);
        return code;
    },

    async process() {
        const myGen = ++gen;
        const text = ui.input.value;
        const pass = ui.pass.value;
        if (!text.trim()) { app.schedule(); return; }

        try {
            if (mode === "encrypt") {
                setStatus("Preparing the code…");
                const code = await duckEncrypt(text, pass);
                if (myGen !== gen) return;
                draftDuckCode = code;
                if (publishedFromDuckCode === code && publishedId) {
                    showShort(publishedId);
                    setStatus("Short code ready.", "ok");
                } else {
                    publishedId = "";
                    publishedFromDuckCode = "";
                    showBody(code, "Full code");
                    setStatus(pass
                        ? "Full code is ready and locked with your passphrase. It stays on this page until you create a short code."
                        : "Full code is ready. It works offline and does not expire. Anyone with it can read the note.", "ok");
                }
                ui.pass.classList.remove("err");
            } else {
                setBusy(true);
                let code;
                if (isDuckCode(text)) code = normalize(text);
                else {
                    const ref = parsePasteRef(text);
                    if (!ref) throw new Error("EXPECT_PASTE");
                    setStatus("Fetching the code…");
                    code = await app.resolveDuckCode(ref);
                }
                if (myGen !== gen) return;
                setStatus("Decrypting…");
                const plain = await duckDecrypt(code, pass);
                if (myGen !== gen) return;
                showBody(plain, "Message");
                ui.pass.classList.remove("err");
                setStatus("Decrypted.", "ok");
            }
        } catch (e) {
            if (myGen !== gen) return;
            showEmpty();
            if (e.message === "MISSING_PASS") {
                ui.pass.classList.add("err");
                ui.pass.focus();
                setStatus("This note is locked. Enter the passphrase.", "error");
            } else if (e.message === "WRONG_PASS") {
                ui.pass.classList.add("err");
                ui.pass.focus();
                setStatus("That passphrase does not open this note.", "error");
            } else if (e.message === "INVALID_OR_PASS") {
                ui.pass.classList.add("err");
                setStatus("That code could not be opened. Check the passphrase.", "error");
            } else if (e.message === "FETCH_FAILED") {
                setStatus("Could not fetch that code. Try again.", "error");
            } else if (e.message === "PASTE_NOT_FOUND") {
                setStatus("No note is stored for that code.", "error");
            } else if (e.message !== "EXPECT_PASTE") {
                setStatus("That is not a valid Duck code.", "error");
            }
        } finally {
            if (myGen === gen) setBusy(false);
        }
    },

    async publish() {
        const myGen = gen;
        const code = draftDuckCode;
        if (!code) return;
        setBusy(true);
        setStatus("Creating a short code…");
        try {
            const res = await fetch("/api/paste", {
                method: "POST",
                headers: { "content-type": "text/plain; charset=utf-8" },
                body: code,
            });
            const data = await res.json().catch(() => ({}));
            if (myGen !== gen) return;
            if (!res.ok || !data.id) throw new Error("PUBLISH_FAILED");
            publishedId = data.id;
            publishedFromDuckCode = code;
            showShort(data.id);
            setStatus("Short code created.", "ok");
        } catch {
            if (myGen !== gen) return;
            if (draftDuckCode) showBody(draftDuckCode, "Full code");
            setStatus("Could not create a short code. You can still copy the full code.", "error");
        } finally {
            if (myGen === gen) setBusy(false);
        }
    },

    async confirm() {
        if (ui.btnGo.disabled) return;
        clearTimeout(timer);
        await app.process();
        if (mode === "encrypt" && draftDuckCode) await app.publish();
    },

    async showFull() {
        if (ui.btnShowFull.disabled) return;
        clearTimeout(timer);
        await app.process();
    },

    applyExternalText(txt) {
        const text = txt ?? "";
        const asCode = isDuckCode(text) || (parsePasteRef(text) && text.trim().length < 300 && !/\s/.test(text.trim()));
        if (asCode) {
            const code = isDuckCode(text) ? text : parsePasteRef(text);
            if (mode !== "decrypt") drafts[mode] = ui.input.value;
            drafts.decrypt = code;
            mode = "decrypt";
            ui.input.value = code;
            app.syncUi();
            app.schedule();
            return;
        }
        ui.input.value = text;
        drafts[mode] = text;
        app.schedule();
    },

    async paste() {
        try { app.applyExternalText(await navigator.clipboard.readText()); }
        catch { setStatus("Could not read the clipboard. Use the system paste shortcut instead.", "error"); }
    },

    clear() {
        ui.input.value = "";
        drafts[mode] = "";
        ui.pass.classList.remove("err");
        if (mode === "encrypt") {
            draftDuckCode = "";
            publishedId = "";
            publishedFromDuckCode = "";
        }
        showEmpty();
        app.syncUi();
        setStatus(INTRO[mode]);
        ui.input.focus();
    },

    clearPass() {
        ui.pass.value = "";
        ui.pass.classList.remove("err");
        ui.btnShowPass.textContent = "Show";
        ui.btnShowPass.setAttribute("aria-pressed", "false");
        ui.pass.type = "password";
        app.schedule();
        ui.pass.focus();
    },

    togglePassVisible() {
        const show = ui.pass.type === "password";
        ui.pass.type = show ? "text" : "password";
        ui.btnShowPass.textContent = show ? "Hide" : "Show";
        ui.btnShowPass.setAttribute("aria-pressed", show ? "true" : "false");
        ui.pass.focus();
    },

    async copyText(value, button, label) {
        if (!value) return;
        try {
            await navigator.clipboard.writeText(value);
            button.textContent = "Copied";
            setTimeout(() => { button.textContent = label; }, 1600);
        } catch {
            setStatus("Could not copy automatically. Select the text and copy it.", "error");
        }
    },

    copy() {
        const value = ui.shortOutput.hidden ? ui.output.value : ui.shortOutput.textContent;
        return app.copyText(value, ui.btnCopy, "Copy");
    },

    copyFull() { return app.copyText(draftDuckCode, ui.btnCopyFull, "Copy full code"); },
};

document.addEventListener("DOMContentLoaded", () => {
    initUI();
    themeLabel();
    ui.btnEnc.addEventListener("click", () => app.setMode("encrypt"));
    ui.btnDec.addEventListener("click", () => app.setMode("decrypt"));
    ui.btnTheme.addEventListener("click", () => app.toggleTheme());
    ui.btnPaste.addEventListener("click", () => app.paste());
    ui.btnClear.addEventListener("click", () => app.clear());
    ui.btnShowPass.addEventListener("click", () => app.togglePassVisible());
    ui.btnClearPass.addEventListener("click", () => app.clearPass());
    ui.btnGo.addEventListener("click", () => app.confirm());
    ui.btnShowFull.addEventListener("click", () => app.showFull());
    ui.btnCopy.addEventListener("click", () => app.copy());
    ui.btnCopyFull.addEventListener("click", () => app.copyFull());
    ui.fullDetails.addEventListener("toggle", () => {
        if (ui.fullDetails.open) fitTextarea(ui.fullCode);
    });
    window.addEventListener("resize", () => {
        if (!ui.output.hidden) fitTextarea(ui.output);
        if (ui.fullDetails.open) fitTextarea(ui.fullCode);
    });
    ui.input.addEventListener("input", () => app.schedule());
    ui.pass.addEventListener("input", () => {
        ui.pass.classList.remove("err");
        if (mode === "decrypt" && (isDuckCode(ui.input.value) || parsePasteRef(ui.input.value))) {
            showEmpty();
            setStatus("Press Decrypt to try this passphrase.");
            updateStats();
            return;
        }
        app.schedule();
    });
    ui.input.addEventListener("keydown", e => {
        if (e.key === "Enter" && !e.shiftKey && mode === "decrypt" && parsePasteRef(ui.input.value)) {
            e.preventDefault();
            app.confirm();
        }
    });
    document.addEventListener("keydown", e => {
        const mod = e.metaKey || e.ctrlKey;
        if (!mod) return;
        const key = e.key.toLowerCase();
        if (key === "e") { e.preventDefault(); app.setMode("encrypt"); }
        else if (key === "d") { e.preventDefault(); app.setMode("decrypt"); }
        else if (key === "enter") { e.preventDefault(); app.confirm(); }
    });
    app.syncUi();
    setStatus(INTRO.encrypt);
    ui.input.focus();
});

window.app = app;
