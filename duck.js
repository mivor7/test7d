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
    return /^[A-Za-z0-9_-]+$/.test(t) ? t : "";
}

// ═══════════════════════════════════════════
//  TEXT SCRAMBLE EFFECT
// ═══════════════════════════════════════════
const SCRAMBLE_CHARS = "!@#$%^&*()_+-=[]{}|;:,.<>?0123456789ABCDEFabcdef";

function scrambleReveal(el, finalText, duration = 600) {
    const len = finalText.length;
    const start = performance.now();
    el.classList.add("revealing");

    function frame(now) {
        const progress = Math.min((now - start) / duration, 1);
        const revealed = Math.floor(progress * len);
        let display = "";
        for (let i = 0; i < len; i++) {
            if (i < revealed) {
                display += finalText[i];
            } else {
                display += SCRAMBLE_CHARS[Math.floor(Math.random() * SCRAMBLE_CHARS.length)];
            }
        }
        el.value = display;
        if (progress < 1) requestAnimationFrame(frame);
        else { el.value = finalText; el.classList.remove("revealing"); }
    }
    if (len > 0) requestAnimationFrame(frame);
    else el.value = finalText;
}

// ═══════════════════════════════════════════
//  APP
// ═══════════════════════════════════════════
const $ = id => document.getElementById(id);
let mode = "encrypt", timer, gen = 0;
let decryptInputMode = "paste", passExpanded = false, passRequested = false;
let draftDuckCode = "", publishedId = "", publishedFromDuckCode = "";
const pasteCache = new Map();
let ui;

function initUI() {
    ui = {
        input: $("input"), shortInput: $("short-input"),
        output: $("output"), shortOutput: $("short-output"),
        textShell: $("text-shell"), shortShell: $("short-shell"),
        shortOutputShell: $("short-output-shell"),
        keyDock: $("key-dock"), keyToggle: $("btn-key-toggle"),
        pass: $("pass"), passWrap: $("pass-wrap"),
        lblIn: $("lbl-input"), lblOut: $("lbl-output"),
        btnEnc: $("mode-enc"), btnDec: $("mode-dec"),
        btnGo: $("btn-go"), btnSource: $("btn-source"),
        btnCopy: $("btn-copy"),
        cardIn: $("card-input"), cardOut: $("card-output"),
        toasts: $("toast-rack"),
        pipeline: $("pipeline"),
        psCompress: $("ps-compress"), psEncrypt: $("ps-encrypt"),
        psEncode: $("ps-encode"), psShare: $("ps-share"),
        pa1: $("pa1"), pa2: $("pa2"), pa3: $("pa3"), pa4: $("pa4"),
        gateField: $("pass-wrap"), gateToggle: $("btn-key-toggle"),
        gateClear: $("btn-clear-pass"),
        statusbar: $("statusbar"),
        statMode: $("stat-mode"), statChars: $("stat-chars"),
        statBytes: $("stat-bytes"), statKey: $("stat-key"), statStatus: $("stat-status"),
    };
}

// ── Pipeline ──
const STEPS = ["psCompress", "psEncrypt", "psEncode", "psShare"];
const ARROWS = ["pa1", "pa2", "pa3", "pa4"];

function pipeReset() {
    STEPS.forEach(s => ui[s].classList.remove("lit", "active"));
    ARROWS.forEach(a => ui[a].classList.remove("lit"));
    ui.pipeline.classList.remove("running");
}

function pipeRunning(on) { ui.pipeline.classList.toggle("running", on); }

function pipeLitSteps(names) {
    pipeReset();
    const order = ["compress", "encrypt", "encode", "share"];
    const map = { compress: "psCompress", encrypt: "psEncrypt", encode: "psEncode", share: "psShare" };
    let maxIdx = -1;
    names.forEach(n => {
        if (map[n]) { ui[map[n]].classList.add("lit"); maxIdx = Math.max(maxIdx, order.indexOf(n)); }
    });
    for (let i = 0; i <= maxIdx && i < ARROWS.length; i++) ui[ARROWS[i]].classList.add("lit");
}

function pipeActiveStep(name) {
    const map = { compress: "psCompress", encrypt: "psEncrypt", encode: "psEncode", share: "psShare" };
    if (map[name]) ui[map[name]].classList.add("active");
}

// ── Status Bar ──
function updateStats() {
    const txt = app.getInputValue();
    ui.statMode.textContent = `mode: ${mode}`;
    ui.statChars.textContent = `${txt.length} chars`;
    ui.statKey.textContent = `key: ${ui.pass.value ? "on" : "off"}`;
    const active = txt.length > 0;
    ui.statusbar.classList.toggle("active", active);
    if (!active) { ui.statStatus.textContent = "ready"; ui.statBytes.hidden = true; pipeReset(); }
}
function setStatus(t) { ui.statStatus.textContent = t; }
function setBytes(n) { ui.statBytes.textContent = `→ ${n}b`; ui.statBytes.hidden = false; }

// ── Copy Morph ──
let copyTimer;
function copyMorph() {
    clearTimeout(copyTimer);
    ui.btnCopy.textContent = "✓ copied";
    ui.btnCopy.classList.add("copied");
    copyTimer = setTimeout(() => {
        ui.btnCopy.textContent = "copy";
        ui.btnCopy.classList.remove("copied");
    }, 1800);
}

const app = {
    toggleTheme() { document.documentElement.classList.toggle("light"); },
    isShortDecryptMode() { return mode === "decrypt" && decryptInputMode === "paste"; },
    activeInput() { return app.isShortDecryptMode() ? ui.shortInput : ui.input; },
    getInputValue() { return app.activeInput().value; },
    setInputValue(v) {
        if (app.isShortDecryptMode()) { ui.shortInput.value = v; ui.input.value = ""; }
        else { ui.input.value = v; ui.shortInput.value = ""; }
    },
    getOutputValue() { return mode === "encrypt" ? ui.shortOutput.value : ui.output.value; },
    setOutputValue(v) {
        if (mode === "encrypt") {
            // scramble reveal for short output
            if (v && v !== ui.shortOutput.value) scrambleReveal(ui.shortOutput, v, 400);
            else ui.shortOutput.value = v;
            ui.output.value = "";
        } else {
            ui.output.value = v;
            ui.shortOutput.value = "";
        }
    },

    syncPassUi() {
        const has = ui.pass.value.length > 0;
        const showField = mode === "encrypt" ? (passExpanded || has) : (passRequested || has);
        ui.gateToggle.hidden = mode !== "encrypt" || showField;
        ui.gateField.classList.toggle("open", showField);
        ui.gateToggle.classList.toggle("on", has);
        ui.gateClear.classList.toggle("vis", has);
        if (has) ui.pass.classList.remove("err");
        ui.pass.classList.toggle("locked", has);
        ui.pass.placeholder = mode === "encrypt" ? (has ? "secured" : "passphrase") : (has ? "unlocking…" : "enter key");
        updateStats();
    },

    syncUi() {
        const shortDec = app.isShortDecryptMode(), compactOut = mode === "encrypt";
        ui.btnSource.hidden = mode !== "decrypt";
        ui.btnSource.textContent = shortDec ? "full code" : "short id";
        ui.lblIn.textContent = mode === "encrypt" ? "input" : shortDec ? "short code" : "duck code";
        ui.lblOut.textContent = mode === "encrypt" ? "output" : "plaintext";
        ui.input.placeholder = mode === "encrypt" ? "type or paste text…" : "paste full duck code…";
        ui.textShell.hidden = shortDec;
        ui.shortShell.hidden = !shortDec;
        ui.btnGo.hidden = !(mode === "encrypt" || shortDec);
        ui.output.hidden = compactOut;
        ui.shortOutputShell.hidden = !compactOut;
        app.syncPassUi();
    },

    setMode(m, quiet) {
        mode = m;
        ui.btnEnc.className = m === "encrypt" ? "tab on" : "tab";
        ui.btnDec.className = m === "decrypt" ? "tab on" : "tab";
        ui.pass.value = ""; ui.pass.classList.remove("err");
        passExpanded = false; passRequested = false;
        app.syncUi();
        if (quiet) return;
        if (app.isShortDecryptMode()) app.clearOut();
        else if (app.getInputValue().trim()) app.schedule();
        else app.clearOut();
    },

    toggleDecryptInputMode() {
        const cur = app.getInputValue();
        decryptInputMode = decryptInputMode === "paste" ? "full" : "paste";
        app.syncUi();
        if (app.isShortDecryptMode()) {
            ui.shortInput.value = parsePasteRef(cur) || "";
            ui.input.value = ""; app.clearOut(); ui.shortInput.focus();
        } else {
            ui.input.value = isDuckCode(cur) ? cur : "";
            ui.shortInput.value = "";
            if (ui.input.value) app.schedule(); else app.clearOut();
            ui.input.focus();
        }
    },

    togglePass() {
        if (mode !== "encrypt") return;
        passExpanded = true; app.syncPassUi(); ui.pass.focus();
    },
    requestPass() { passRequested = true; app.syncPassUi(); ui.pass.focus(); },

    clearPass() {
        ui.pass.value = ""; ui.pass.classList.remove("err");
        passRequested = false;
        if (mode === "encrypt") passExpanded = false;
        app.syncPassUi();
        if (app.isShortDecryptMode()) app.clearOut(); else app.schedule();
        ui.pass.focus();
    },

    schedule() {
        clearTimeout(timer); app.syncPassUi();
        if (app.isShortDecryptMode()) { app.clearOut(); return; }
        timer = setTimeout(app.process, 250);
    },

    clearOut() {
        ui.output.value = ""; ui.shortOutput.value = "";
        ui.pass.classList.remove("err");
        ui.cardOut.classList.remove("processing");
        pipeReset(); updateStats();
    },

    async resolveDuckCode(text) {
        if (decryptInputMode === "full") return text;
        const ref = parsePasteRef(text);
        if (!ref) throw new Error("EXPECT_PASTE");
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
        const myGen = ++gen, text = app.getInputValue(), pass = ui.pass.value;
        if (!text.trim()) {
            if (mode === "encrypt") { draftDuckCode = ""; publishedId = ""; publishedFromDuckCode = ""; }
            app.clearOut();
            if (mode === "decrypt" && !pass) { passRequested = false; app.syncPassUi(); }
            return;
        }
        if (mode === "decrypt" && decryptInputMode === "full" && !isDuckCode(text)) { app.clearOut(); return; }
        if (mode === "decrypt" && decryptInputMode === "paste" && !parsePasteRef(text)) { app.clearOut(); return; }

        ui.cardOut.classList.add("processing");
        pipeRunning(true);
        setStatus("processing…");

        try {
            if (mode === "encrypt") {
                pipeActiveStep("compress"); setStatus("compressing…");
                const code = await duckEncrypt(text, pass);
                if (myGen !== gen) return;
                pipeRunning(false);
                pipeLitSteps(pass ? ["compress", "encrypt", "encode"] : ["compress", "encode"]);
                setStatus("encoded"); setBytes(code.length);
                draftDuckCode = code;
                if (publishedFromDuckCode !== code) {
                    publishedId = ""; publishedFromDuckCode = ""; app.setOutputValue("");
                } else { app.setOutputValue(publishedId); }
            } else {
                pipeActiveStep("share"); setStatus("fetching…");
                const code = await app.resolveDuckCode(text);
                if (myGen !== gen) return;
                pipeActiveStep("encode"); setStatus("decoding…");
                const res = await duckDecrypt(code, pass);
                if (myGen !== gen) return;
                pipeRunning(false);
                pipeLitSteps(["compress", "encrypt", "encode", "share"]);
                setStatus("decrypted");
                app.setOutputValue(res);
                if (!pass) passRequested = false;
            }
            ui.pass.classList.remove("err"); app.syncPassUi();
        } catch (e) {
            if (myGen !== gen) return;
            pipeRunning(false);
            app.clearOut();
            if (e.message === "MISSING_PASS") { app.requestPass(); app.toast("enter key to unlock", "error"); setStatus("locked"); }
            else if (e.message === "WRONG_PASS") { app.requestPass(); ui.pass.classList.add("err"); app.toast("incorrect key", "error"); setStatus("wrong key"); }
            else if (e.message === "INVALID_OR_PASS") { app.requestPass(); app.toast("invalid code or missing key", "error"); setStatus("invalid"); }
            else if (e.message === "FETCH_FAILED") { app.toast("paste fetch failed", "error"); setStatus("fetch error"); }
            else if (e.message !== "EXPECT_PASTE" && e.message !== "PASTE_NOT_FOUND") { app.toast("invalid data", "error"); setStatus("error"); }
        } finally {
            if (myGen === gen) { ui.cardOut.classList.remove("processing"); pipeRunning(false); }
        }
    },

    async copy() {
        const v = app.getOutputValue(); if (!v) return;
        await navigator.clipboard.writeText(v);
        copyMorph();
        app.toast("copied!", "success");
    },

    async confirm() {
        clearTimeout(timer);
        // spin the go button
        ui.btnGo.classList.add("spin");
        setTimeout(() => ui.btnGo.classList.remove("spin"), 500);

        if (mode === "encrypt") {
            await app.process(); if (!draftDuckCode) return;
            ui.cardOut.classList.add("processing");
            pipeRunning(true);
            pipeActiveStep("share"); setStatus("publishing…");
            try {
                const res = await fetch("/api/paste", {
                    method: "POST", headers: { "content-type": "text/plain; charset=utf-8" }, body: draftDuckCode,
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok || !data.id) throw new Error("PUBLISH_FAILED");
                publishedId = data.id; publishedFromDuckCode = draftDuckCode;
                app.setOutputValue(publishedId);
                pipeRunning(false);
                pipeLitSteps(["compress", ui.pass.value ? "encrypt" : null, "encode", "share"].filter(Boolean));
                setStatus("published ✓");
            } catch { app.toast("publish failed", "error"); setStatus("publish error"); pipeRunning(false); }
            finally { ui.cardOut.classList.remove("processing"); }
            return;
        }
        if (app.isShortDecryptMode()) await app.process();
    },

    applyExternalText(txt) {
        if (isDuckCode(txt)) {
            decryptInputMode = "full";
            if (mode !== "decrypt") app.setMode("decrypt", true);
            app.syncUi(); ui.input.value = txt; ui.shortInput.value = "";
            app.schedule(); return;
        }
        if (app.isShortDecryptMode()) { ui.shortInput.value = txt.trim(); app.clearOut(); return; }
        ui.input.value = txt; app.schedule();
    },

    async paste() {
        try { app.applyExternalText(await navigator.clipboard.readText()); }
        catch { app.toast("paste failed", "error"); }
    },

    clear() {
        draftDuckCode = ""; publishedId = ""; publishedFromDuckCode = "";
        ui.input.value = ""; ui.shortInput.value = "";
        app.clearOut();
        if (mode === "encrypt") passExpanded = false; else passRequested = false;
        if (!ui.pass.value) app.syncPassUi();
        app.activeInput().focus();
    },

    toast(msg, type = "") {
        const t = document.createElement("div");
        t.className = `toast ${type}`; t.textContent = msg;
        ui.toasts.appendChild(t);
        requestAnimationFrame(() => t.classList.add("show"));
        setTimeout(() => { t.classList.remove("show"); setTimeout(() => t.remove(), 300); }, 2200);
    },
};

// ── Boot ──
document.addEventListener("DOMContentLoaded", () => {
    initUI();
    ui.input.addEventListener("input", () => { app.schedule(); updateStats(); });
    ui.input.addEventListener("paste", () => setTimeout(() => app.applyExternalText(ui.input.value), 0));
    ui.shortInput.addEventListener("input", () => { app.clearOut(); updateStats(); });
    ui.shortInput.addEventListener("paste", () => setTimeout(() => app.applyExternalText(ui.shortInput.value), 0));
    ui.shortInput.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); app.confirm(); } });
    ui.pass.addEventListener("input", () => {
        if (app.isShortDecryptMode()) { app.syncPassUi(); app.clearOut(); } else app.schedule();
    });
    // Keyboard shortcuts
    document.addEventListener("keydown", e => {
        const mod = e.metaKey || e.ctrlKey;
        if (mod && e.key === "e") { e.preventDefault(); app.setMode("encrypt"); }
        if (mod && e.key === "d") { e.preventDefault(); app.setMode("decrypt"); }
        if (mod && e.key === "k") { e.preventDefault(); app.togglePass(); }
        if (mod && e.key === "Enter") { e.preventDefault(); app.confirm(); }
    });
    app.syncUi();
    app.setMode("encrypt", true);
    updateStats();
});

window.app = app;
