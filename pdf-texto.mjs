/*
 * Leitor de PDF do servidor, sem dependências externas.
 * Extrai o texto das 3 primeiras páginas com a posição de cada trecho
 * ({ s, x, y, w, h, p }), no mesmo formato usado pelo navegador (pdf.js).
 *
 * Cobre o que os emissores de DANFE/NFC-e usam: streams compactados (Flate),
 * object streams, fontes com ToUnicode/WinAnsi/Differences, Form XObjects
 * e PDF protegido com senha de usuário vazia (RC4 40/128 e AES-128).
 * Não cobre: PDF escaneado (imagem), criptografia AES-256 (R6).
 */
import zlib from "node:zlib";
import crypto from "node:crypto";

const BRANCO = new Set([0, 9, 10, 12, 13, 32]);
const DELIM = new Set("()<>[]{}/%".split("").map(c => c.charCodeAt(0)));

/* ---------- léxico ---------- */
class Lexer {
  constructor(buf, pos = 0) { this.b = buf; this.p = pos; }
  pularBranco() {
    const b = this.b;
    while (this.p < b.length) {
      const c = b[this.p];
      if (BRANCO.has(c)) { this.p++; continue; }
      if (c === 37) { while (this.p < b.length && b[this.p] !== 10 && b[this.p] !== 13) this.p++; continue; } // %
      break;
    }
  }
  token() {
    this.pularBranco();
    const b = this.b; if (this.p >= b.length) return null;
    const c = b[this.p];
    if (c === 91) { this.p++; return { t: "[" }; }
    if (c === 93) { this.p++; return { t: "]" }; }
    if (c === 123 || c === 125) { this.p++; return { t: c === 123 ? "{" : "}" }; }
    if (c === 60) {
      if (b[this.p + 1] === 60) { this.p += 2; return { t: "<<" }; }
      const fim = b.indexOf(62, this.p); const hex = b.toString("latin1", this.p + 1, fim).replace(/[^0-9a-fA-F]/g, "");
      this.p = fim + 1; return { t: "str", v: Buffer.from(hex.length % 2 ? hex + "0" : hex, "hex"), hex: true };
    }
    if (c === 62) { if (b[this.p + 1] === 62) { this.p += 2; return { t: ">>" }; } this.p++; return { t: "kw", v: ">" }; }
    if (c === 40) return { t: "str", v: this.literal() };
    if (c === 47) { // nome
      let i = this.p + 1; while (i < b.length && !BRANCO.has(b[i]) && !DELIM.has(b[i])) i++;
      const nome = b.toString("latin1", this.p + 1, i).replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
      this.p = i; return { t: "name", v: nome };
    }
    let i = this.p; while (i < b.length && !BRANCO.has(b[i]) && !DELIM.has(b[i])) i++;
    if (i === this.p) { this.p++; return { t: "kw", v: String.fromCharCode(c) }; }
    const pal = b.toString("latin1", this.p, i); this.p = i;
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(pal)) return { t: "num", v: parseFloat(pal) };
    return { t: "kw", v: pal };
  }
  literal() {
    const b = this.b; let i = this.p + 1, nivel = 1; const out = [];
    while (i < b.length && nivel > 0) {
      let c = b[i];
      if (c === 92) { // barra invertida
        i++; c = b[i];
        const mapa = { 110: 10, 114: 13, 116: 9, 98: 8, 102: 12, 40: 40, 41: 41, 92: 92 };
        if (mapa[c] !== undefined) { out.push(mapa[c]); i++; }
        else if (c >= 48 && c <= 55) { let o = ""; while (o.length < 3 && b[i] >= 48 && b[i] <= 55) o += String.fromCharCode(b[i++]); out.push(parseInt(o, 8) & 255); }
        else if (c === 13) { i++; if (b[i] === 10) i++; }
        else if (c === 10) i++;
        else { out.push(c); i++; }
        continue;
      }
      if (c === 40) nivel++;
      if (c === 41) { nivel--; if (nivel === 0) { i++; break; } }
      out.push(c); i++;
    }
    this.p = i; return Buffer.from(out);
  }
}

/* ---------- objetos ---------- */
class Ref { constructor(n, g) { this.n = n; this.g = g; } }
function lerValor(lx, tk = lx.token()) {
  if (!tk) return null;
  if (tk.t === "num") {
    const salvo = lx.p, t2 = lx.token();
    if (t2 && t2.t === "num" && Number.isInteger(tk.v) && Number.isInteger(t2.v)) {
      const salvo2 = lx.p, t3 = lx.token();
      if (t3 && t3.t === "kw" && t3.v === "R") return new Ref(tk.v, t2.v);
      lx.p = salvo2;
    }
    lx.p = salvo; return tk.v;
  }
  if (tk.t === "str" || tk.t === "name") return tk.t === "name" ? { nome: tk.v } : tk.v;
  if (tk.t === "[") { const a = []; for (;;) { const t = lx.token(); if (!t || t.t === "]") return a; a.push(lerValor(lx, t)); } }
  if (tk.t === "<<") {
    const d = {};
    for (;;) { const t = lx.token(); if (!t || t.t === ">>") return d; if (t.t === "name") d[t.v] = lerValor(lx); }
  }
  if (tk.t === "kw") { if (tk.v === "true") return true; if (tk.v === "false") return false; if (tk.v === "null") return null; return { kw: tk.v }; }
  return null;
}
const nomeDe = v => (v && typeof v === "object" && "nome" in v) ? v.nome : undefined;

/* ---------- criptografia (senha de usuário vazia) ---------- */
const PAD = Buffer.from("28BF4E5E4E758A4164004E56FFFA01082E2E00B6D0683E802F0CA9FE6453697A", "hex");
function rc4(chave, dados) {
  const s = new Uint8Array(256); for (let i = 0; i < 256; i++) s[i] = i;
  for (let i = 0, j = 0; i < 256; i++) { j = (j + s[i] + chave[i % chave.length]) & 255; [s[i], s[j]] = [s[j], s[i]]; }
  const out = Buffer.alloc(dados.length);
  for (let k = 0, i = 0, j = 0; k < dados.length; k++) { i = (i + 1) & 255; j = (j + s[i]) & 255; [s[i], s[j]] = [s[j], s[i]]; out[k] = dados[k] ^ s[(s[i] + s[j]) & 255]; }
  return out;
}
/* Algoritmo 2.B (PDF 2.0, R6) */
function hash2B(senha, sal, udata) {
  let K = crypto.createHash("sha256").update(Buffer.concat([senha, sal, udata])).digest();
  for (let rodada = 0; ; rodada++) {
    const K1 = Buffer.concat(Array(64).fill(Buffer.concat([senha, K, udata])));
    const c = crypto.createCipheriv("aes-128-cbc", K.subarray(0, 16), K.subarray(16, 32)); c.setAutoPadding(false);
    const E = Buffer.concat([c.update(K1), c.final()]);
    let soma = 0; for (let i = 0; i < 16; i++) soma += E[i];
    K = crypto.createHash(["sha256", "sha384", "sha512"][soma % 3]).update(E).digest();
    if (rodada >= 63 && E[E.length - 1] <= rodada - 32) break;
  }
  return K.subarray(0, 32);
}
const md5 = (...partes) => crypto.createHash("md5").update(Buffer.concat(partes)).digest();

/* ---------- documento ---------- */
class Documento {
  constructor(buf) {
    this.b = buf; this.pos = new Map(); this.cache = new Map(); this.objStm = new Map(); this.cripto = null;
    const s = buf.toString("latin1"), re = /(\d+)\s+(\d+)\s+obj\b/g; let m;
    while ((m = re.exec(s))) this.pos.set(+m[1], m.index + m[0].length); // a última definição vale (atualizações incrementais)
    this.prepararCripto(s); // antes dos object streams, que podem estar cifrados
    for (const [n] of this.pos) {
      const o = this.objCru(n);
      if (o && o.stream && nomeDe(o.dict.Type) === "ObjStm") this.registrarObjStm(n, o);
    }
  }
  objCru(n) {
    if (this.cache.has(n)) return this.cache.get(n);
    let r = null;
    if (this.pos.has(n)) {
      const lx = new Lexer(this.b, this.pos.get(n)); const v = lerValor(lx);
      const salvo = lx.p, tk = lx.token();
      if (tk && tk.t === "kw" && tk.v === "stream" && v && typeof v === "object") {
        let ini = lx.p; if (this.b[ini] === 13) ini++; if (this.b[ini] === 10) ini++;
        r = { dict: v, stream: { ini, n } };
      } else { lx.p = salvo; r = { valor: v }; }
    } else if (this.objStm.has(n)) {
      const { buf, off } = this.objStm.get(n);
      r = { valor: lerValor(new Lexer(buf, off)) };
    }
    this.cache.set(n, r); return r;
  }
  registrarObjStm(n, o) {
    try {
      const dados = this.dadosStream(o);
      const N = this.resolver(o.dict.N), primeiro = this.resolver(o.dict.First);
      const lx = new Lexer(dados, 0);
      for (let i = 0; i < N; i++) {
        const num = lx.token().v, off = lx.token().v;
        if (!this.pos.has(num) && !this.objStm.has(num)) this.objStm.set(num, { buf: dados, off: primeiro + off });
      }
    } catch { /* object stream ilegível: segue sem ele */ }
  }
  resolver(v, prof = 0) {
    while (v instanceof Ref && prof++ < 20) { const o = this.objCru(v.n); v = o ? (o.stream ? o : o.valor) : null; }
    return v;
  }
  dicionario(v) { const r = this.resolver(v); return r && r.stream ? r.dict : r; }
  prepararCripto(s) {
    // dicionário do trailer: "trailer << ... >>" ou o stream XRef
    let trailer = null;
    const i = s.lastIndexOf("trailer");
    if (i >= 0) trailer = lerValor(new Lexer(this.b, i + 7));
    if (!trailer || !trailer.Encrypt) for (const [n] of this.pos) { const o = this.objCru(n); if (o && o.stream && nomeDe(o.dict.Type) === "XRef" && o.dict.Encrypt) { trailer = o.dict; break; } }
    if (!trailer || !trailer.Encrypt) return;
    const enc = this.dicionario(trailer.Encrypt);
    const V = enc.V || 0, R = enc.R || 2;
    if (nomeDe(enc.Filter) !== "Standard") { this.cripto = { naoSuportado: true }; return; }
    if (R >= 5) { // AES-256 (R5/R6), senha de usuário vazia
      const U = this.resolver(enc.U), UE = this.resolver(enc.UE);
      if (!Buffer.isBuffer(U) || !Buffer.isBuffer(UE) || U.length < 48) { this.cripto = { naoSuportado: true }; return; }
      const ksalt = U.subarray(40, 48);
      const k = R === 5 ? crypto.createHash("sha256").update(ksalt).digest() : hash2B(Buffer.alloc(0), ksalt, Buffer.alloc(0));
      const d = crypto.createDecipheriv("aes-256-cbc", k, Buffer.alloc(16)); d.setAutoPadding(false);
      this.cripto = { chave: Buffer.concat([d.update(UE.subarray(0, 32)), d.final()]), aes256: true };
      return;
    }
    let bits = enc.Length || 40, aes = false;
    if (V === 4) {
      const cf = enc.CF && enc.StmF ? this.dicionario(enc.CF)[nomeDe(enc.StmF)] : null;
      const cfm = cf ? nomeDe(this.dicionario(cf).CFM) : null;
      if (nomeDe(enc.StmF) === "Identity") { this.cripto = null; return; }
      aes = cfm === "AESV2"; bits = 128;
    }
    const n = Math.min(16, Math.max(5, bits / 8));
    const id0 = Array.isArray(trailer.ID) ? this.resolver(trailer.ID[0]) : Buffer.alloc(0);
    const P = Buffer.alloc(4); P.writeInt32LE(enc.P | 0);
    const partes = [PAD, this.resolver(enc.O), P, Buffer.isBuffer(id0) ? id0 : Buffer.alloc(0)];
    if (R >= 4 && enc.EncryptMetadata === false) partes.push(Buffer.from([255, 255, 255, 255]));
    let chave = md5(...partes);
    if (R >= 3) for (let k = 0; k < 50; k++) chave = md5(chave.subarray(0, n));
    this.cripto = { chave: chave.subarray(0, n), aes };
  }
  decifrar(dados, num, gen = 0) {
    if (!this.cripto) return dados;
    if (this.cripto.naoSuportado) throw new Error("PDF protegido com criptografia não suportada.");
    if (this.cripto.aes256) {
      if (dados.length < 32) return Buffer.alloc(0);
      const d = crypto.createDecipheriv("aes-256-cbc", this.cripto.chave, dados.subarray(0, 16));
      const corpo = d.update(dados.subarray(16));
      try { return Buffer.concat([corpo, d.final()]); } catch { return corpo; }
    }
    const ext = Buffer.from([num & 255, (num >> 8) & 255, (num >> 16) & 255, gen & 255, (gen >> 8) & 255]);
    const k = md5(this.cripto.chave, ext, this.cripto.aes ? Buffer.from("sAlT") : Buffer.alloc(0)).subarray(0, Math.min(16, this.cripto.chave.length + 5));
    if (!this.cripto.aes) return rc4(k, dados);
    if (dados.length < 32) return Buffer.alloc(0);
    const d = crypto.createDecipheriv("aes-128-cbc", k, dados.subarray(0, 16));
    const corpo = d.update(dados.subarray(16));
    try { return Buffer.concat([corpo, d.final()]); } catch { return corpo; }
  }
  dadosStream(o) {
    const { ini, n } = o.stream;
    let len = this.resolver(o.dict.Length), fim;
    const s = this.b;
    if (typeof len === "number" && s.toString("latin1", ini + len, ini + len + 30).includes("endstream")) fim = ini + len;
    else { fim = s.indexOf("endstream", ini, "latin1"); if (s[fim - 1] === 10) fim--; if (s[fim - 1] === 13) fim--; }
    let dados = s.subarray(ini, fim);
    const tipo = nomeDe(o.dict.Type);
    if (this.cripto && tipo !== "XRef") dados = this.decifrar(dados, n);
    let filtros = this.resolver(o.dict.Filter); filtros = Array.isArray(filtros) ? filtros.map(f => nomeDe(this.resolver(f))) : filtros ? [nomeDe(filtros)] : [];
    for (const f of filtros) dados = decodificar(f, dados);
    return dados;
  }
}

function decodificar(filtro, dados) {
  switch (filtro) {
    case "FlateDecode": case "Fl":
      try { return zlib.inflateSync(dados, { finishFlush: zlib.constants.Z_SYNC_FLUSH }); }
      catch { try { return zlib.inflateRawSync(dados, { finishFlush: zlib.constants.Z_SYNC_FLUSH }); } catch { return Buffer.alloc(0); } }
    case "ASCIIHexDecode": case "AHx": {
      const h = dados.toString("latin1").replace(/>.*$/s, "").replace(/[^0-9a-fA-F]/g, "");
      return Buffer.from(h.length % 2 ? h + "0" : h, "hex");
    }
    case "ASCII85Decode": case "A85": {
      const t = dados.toString("latin1").replace(/^<~/, "").replace(/~>.*$/s, "").replace(/\s/g, "");
      const out = []; let grupo = [];
      for (const ch of t) {
        if (ch === "z" && grupo.length === 0) { out.push(0, 0, 0, 0); continue; }
        grupo.push(ch.charCodeAt(0) - 33);
        if (grupo.length === 5) { let v = 0; for (const g of grupo) v = v * 85 + g; out.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255); grupo = []; }
      }
      if (grupo.length) { const k = grupo.length; while (grupo.length < 5) grupo.push(84); let v = 0; for (const g of grupo) v = v * 85 + g; const bytes = [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]; out.push(...bytes.slice(0, k - 1)); }
      return Buffer.from(out);
    }
    default: return Buffer.alloc(0); // imagens e filtros raros: não têm texto
  }
}

/* ---------- fontes ---------- */
const WIN_ANSI_ALTO = { 128: "€", 130: "‚", 131: "ƒ", 132: "„", 133: "…", 134: "†", 135: "‡", 136: "ˆ", 137: "‰", 138: "Š", 139: "‹", 140: "Œ", 142: "Ž", 145: "‘", 146: "’", 147: "“", 148: "”", 149: "•", 150: "–", 151: "—", 152: "˜", 153: "™", 154: "š", 155: "›", 156: "œ", 158: "ž", 159: "Ÿ" };
const winAnsi = c => WIN_ANSI_ALTO[c] || String.fromCharCode(c);
const ACENTOS = { acute: "́", grave: "̀", circumflex: "̂", tilde: "̃", dieresis: "̈", cedilla: "̧", ring: "̊", caron: "̌" };
const GLIFOS = { space: " ", exclam: "!", quotedbl: "\"", numbersign: "#", dollar: "$", percent: "%", ampersand: "&", quotesingle: "'", quoteright: "’", quoteleft: "‘", parenleft: "(", parenright: ")", asterisk: "*", plus: "+", comma: ",", hyphen: "-", minus: "-", period: ".", slash: "/", colon: ":", semicolon: ";", less: "<", equal: "=", greater: ">", question: "?", at: "@", bracketleft: "[", backslash: "\\", bracketright: "]", underscore: "_", braceleft: "{", bar: "|", braceright: "}", ordmasculine: "º", ordfeminine: "ª", degree: "°", endash: "–", emdash: "—", bullet: "•", germandbls: "ß", ae: "æ", AE: "Æ", oslash: "ø", Oslash: "Ø", nbspace: " ", sterling: "£", section: "§", paragraph: "¶", copyright: "©", registered: "®", zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9" };
function glifo(nome) {
  if (!nome) return "";
  if (GLIFOS[nome]) return GLIFOS[nome];
  if (/^[A-Za-z]$/.test(nome)) return nome;
  let m = nome.match(/^uni([0-9A-Fa-f]{4})/); if (m) return String.fromCharCode(parseInt(m[1], 16));
  m = nome.match(/^u([0-9A-Fa-f]{4,6})$/); if (m) return String.fromCodePoint(parseInt(m[1], 16));
  m = nome.match(/^([A-Za-z])(acute|grave|circumflex|tilde|dieresis|cedilla|ring|caron)$/); if (m) return (m[1] + ACENTOS[m[2]]).normalize("NFC");
  m = nome.match(/^(?:g|cid)(\d+)$/); if (m) return "";
  return "";
}
function lerCMap(buf) {
  const s = buf.toString("latin1"), mapa = new Map(); let bytes = 1;
  const hexStr = h => { h = h.replace(/[^0-9a-fA-F]/g, ""); let r = ""; for (let i = 0; i + 4 <= h.length; i += 4) r += String.fromCharCode(parseInt(h.slice(i, i + 4), 16)); if (h.length % 4 === 2) r += String.fromCharCode(parseInt(h.slice(-2), 16)); return r; };
  const cs = s.match(/begincodespacerange\s*<([0-9a-fA-F]+)>/); if (cs) bytes = Math.max(1, cs[1].length / 2);
  for (const bloco of s.matchAll(/beginbfchar([\s\S]*?)endbfchar/g))
    for (const m of bloco[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g)) mapa.set(parseInt(m[1], 16), hexStr(m[2]));
  for (const bloco of s.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    const re = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<[0-9a-fA-F]*>|\[[^\]]*\])/g; let m;
    while ((m = re.exec(bloco[1]))) {
      const lo = parseInt(m[1], 16), hi = parseInt(m[2], 16);
      if (hi - lo > 65535) continue;
      if (m[3][0] === "[") { const itens = [...m[3].matchAll(/<([0-9a-fA-F]*)>/g)].map(x => hexStr(x[1])); for (let c = lo; c <= hi; c++) mapa.set(c, itens[c - lo] || ""); }
      else { const base = hexStr(m[3]); for (let c = lo; c <= hi; c++) mapa.set(c, base.slice(0, -1) + String.fromCharCode(base.charCodeAt(base.length - 1) + (c - lo))); }
    }
  }
  return { mapa, bytes };
}
function carregarFonte(doc, ref) {
  const d = doc.dicionario(ref) || {};
  const sub = nomeDe(d.Subtype);
  const f = { tipo0: sub === "Type0", bytes: sub === "Type0" ? 2 : 1, uni: null, dif: {}, larguras: new Map(), padrao: sub === "Type0" ? 1000 : 500, primeiro: 0 };
  try { const tu = doc.resolver(d.ToUnicode); if (tu && tu.stream) { const cm = lerCMap(doc.dadosStream(tu)); f.uni = cm.mapa; if (f.tipo0) f.bytes = cm.bytes; } } catch {}
  if (!f.tipo0) {
    const enc = doc.resolver(d.Encoding);
    const encD = enc && !nomeDe(enc) ? enc : null;
    if (encD && Array.isArray(encD.Differences)) { let c = 0; for (const v of encD.Differences) { if (typeof v === "number") c = v; else { f.dif[c++] = nomeDe(v); } } }
    f.primeiro = d.FirstChar || 0;
    const w = doc.resolver(d.Widths); if (Array.isArray(w)) w.forEach((x, i) => f.larguras.set(f.primeiro + i, doc.resolver(x)));
  } else {
    const desc = doc.dicionario(Array.isArray(doc.resolver(d.DescendantFonts)) ? doc.resolver(d.DescendantFonts)[0] : null) || {};
    if (typeof desc.DW === "number") f.padrao = desc.DW;
    const W = doc.resolver(desc.W);
    if (Array.isArray(W)) for (let i = 0; i < W.length;) {
      const c = doc.resolver(W[i]), prox = doc.resolver(W[i + 1]);
      if (Array.isArray(prox)) { prox.forEach((x, k) => f.larguras.set(c + k, doc.resolver(x))); i += 2; }
      else { const fim = prox, larg = doc.resolver(W[i + 2]); for (let k = c; k <= fim && k - c < 65536; k++) f.larguras.set(k, larg); i += 3; }
    }
  }
  return f;
}
function decodificarTexto(f, bytes) {
  let txt = "", larg = 0, espacos = 0;
  for (let i = 0; i < bytes.length; i += f.bytes) {
    let code = 0; for (let k = 0; k < f.bytes; k++) code = (code << 8) | (bytes[i + k] || 0);
    let ch;
    if (f.uni && f.uni.has(code)) ch = f.uni.get(code);
    else if (f.tipo0) ch = "";
    else if (f.dif[code]) ch = glifo(f.dif[code]);
    else ch = winAnsi(code);
    txt += ch; larg += (f.larguras.has(code) ? f.larguras.get(code) : f.padrao);
    if (f.bytes === 1 && code === 32) espacos++;
  }
  return { txt, larg, espacos };
}

/* ---------- interpretação do conteúdo da página ---------- */
const mult = (m, n) => [m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3], m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3], m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5]];
const ID = [1, 0, 0, 1, 0, 0];

function interpretar(doc, dados, recursos, ctmInicial, pagina, saida, prof = 0) {
  const lx = new Lexer(dados); const ops = [];
  const fontesCache = new Map();
  const fonteDe = nome => {
    if (fontesCache.has(nome)) return fontesCache.get(nome);
    const fontes = doc.dicionario(recursos && recursos.Font) || {};
    const f = fontes[nome] ? carregarFonte(doc, fontes[nome]) : { tipo0: false, bytes: 1, uni: null, dif: {}, larguras: new Map(), padrao: 500 };
    fontesCache.set(nome, f); return f;
  };
  let g = { ctm: ctmInicial.slice(), fonte: null, tam: 10, tc: 0, tw: 0, th: 1, tl: 0, rise: 0 };
  const pilha = []; let tm = ID.slice(), tlm = ID.slice();
  const mostrar = bytes => {
    if (!g.fonte) return;
    const { txt, larg, espacos } = decodificarTexto(g.fonte, bytes);
    const n = bytes.length / g.fonte.bytes;
    const avanco = ((larg / 1000) * g.tam + g.tc * n + g.tw * espacos) * g.th;
    const trm = mult([g.tam * g.th, 0, 0, g.tam, 0, g.rise], mult(tm, g.ctm));
    const escala = Math.hypot(...mult(tm, g.ctm).slice(0, 2));
    if (txt.replace(/\s/g, "")) saida.push({ s: txt, x: trm[4], y: trm[5], w: avanco * escala, h: Math.hypot(trm[2], trm[3]) || g.tam, p: pagina });
    tm = mult([1, 0, 0, 1, avanco, 0], tm);
  };
  for (;;) {
    const tk = lx.token(); if (!tk) break;
    if (tk.t !== "kw") { ops.push(tk.t === "[" || tk.t === "<<" ? lerValor(lx, tk) : (tk.t === "num" ? tk.v : tk.t === "name" ? { nome: tk.v } : tk.v)); continue; }
    const op = tk.v, a = ops;
    try {
      switch (op) {
        case "q": pilha.push({ ...g, ctm: g.ctm.slice() }); break;
        case "Q": if (pilha.length) g = pilha.pop(); break;
        case "cm": g.ctm = mult(a.slice(-6), g.ctm); break;
        case "BT": tm = ID.slice(); tlm = ID.slice(); break;
        case "Tf": g.fonte = fonteDe(nomeDe(a[a.length - 2])); g.tam = a[a.length - 1]; break;
        case "Tc": g.tc = a[a.length - 1]; break;
        case "Tw": g.tw = a[a.length - 1]; break;
        case "Tz": g.th = a[a.length - 1] / 100; break;
        case "TL": g.tl = a[a.length - 1]; break;
        case "Ts": g.rise = a[a.length - 1]; break;
        case "Td": tlm = mult([1, 0, 0, 1, a[a.length - 2], a[a.length - 1]], tlm); tm = tlm.slice(); break;
        case "TD": g.tl = -a[a.length - 1]; tlm = mult([1, 0, 0, 1, a[a.length - 2], a[a.length - 1]], tlm); tm = tlm.slice(); break;
        case "Tm": tlm = a.slice(-6); tm = tlm.slice(); break;
        case "T*": tlm = mult([1, 0, 0, 1, 0, -g.tl], tlm); tm = tlm.slice(); break;
        case "Tj": if (Buffer.isBuffer(a[a.length - 1])) mostrar(a[a.length - 1]); break;
        case "'": tlm = mult([1, 0, 0, 1, 0, -g.tl], tlm); tm = tlm.slice(); if (Buffer.isBuffer(a[a.length - 1])) mostrar(a[a.length - 1]); break;
        case "\"": g.tw = a[a.length - 3]; g.tc = a[a.length - 2]; tlm = mult([1, 0, 0, 1, 0, -g.tl], tlm); tm = tlm.slice(); if (Buffer.isBuffer(a[a.length - 1])) mostrar(a[a.length - 1]); break;
        case "TJ": {
          const arr = a[a.length - 1]; if (!Array.isArray(arr) || !g.fonte) break;
          // junta os pedaços num item só; espaço quando o recuo é grande (como o pdf.js)
          const inicio = mult([g.tam * g.th, 0, 0, g.tam, 0, g.rise], mult(tm, g.ctm)), escala = Math.hypot(...mult(tm, g.ctm).slice(0, 2));
          let texto = "", avTotal = 0;
          for (const el of arr) {
            if (Buffer.isBuffer(el)) { const { txt, larg, espacos } = decodificarTexto(g.fonte, el); const n = el.length / g.fonte.bytes; texto += txt; avTotal += ((larg / 1000) * g.tam + g.tc * n + g.tw * espacos) * g.th; }
            else if (typeof el === "number") { if (el < -180 && texto && !texto.endsWith(" ")) texto += " "; avTotal += (-el / 1000) * g.tam * g.th; }
          }
          if (texto.replace(/\s/g, "")) saida.push({ s: texto, x: inicio[4], y: inicio[5], w: avTotal * escala, h: Math.hypot(inicio[2], inicio[3]) || g.tam, p: pagina });
          tm = mult([1, 0, 0, 1, avTotal, 0], tm);
          break;
        }
        case "Do": {
          if (prof > 6) break;
          const xo = doc.dicionario(recursos && recursos.XObject) || {};
          const alvo = doc.resolver(xo[nomeDe(a[a.length - 1])]);
          if (alvo && alvo.stream && nomeDe(alvo.dict.Subtype) === "Form") {
            const matriz = Array.isArray(alvo.dict.Matrix) ? alvo.dict.Matrix.map(x => doc.resolver(x)) : ID;
            const rec = doc.dicionario(alvo.dict.Resources) || recursos;
            interpretar(doc, doc.dadosStream(alvo), rec, mult(matriz, g.ctm), pagina, saida, prof + 1);
          }
          break;
        }
        case "BI": { // imagem embutida: pula até EI
          const s = lx.b; let i = lx.p;
          const id = s.indexOf("ID", i, "latin1"); i = id + 2;
          for (;;) { const e = s.indexOf("EI", i, "latin1"); if (e < 0) { i = s.length; break; } if (BRANCO.has(s[e - 1]) && (e + 2 >= s.length || BRANCO.has(s[e + 2]))) { i = e + 2; break; } i = e + 2; }
          lx.p = i; break;
        }
      }
    } catch { /* operador malformado: ignora e segue */ }
    ops.length = 0;
  }
}

/* Junta pedaços vizinhos da mesma linha (geradores como o Chrome quebram palavras
   por causa do kerning). Mesmo comportamento do pdf.js: encostado = mesma palavra,
   pequeno vão = espaço, vão grande = itens separados (outra célula). */
function juntarPedacos(lista) {
  const out = [];
  for (const it of lista) {
    const ant = out[out.length - 1];
    if (ant) {
      const h = Math.min(ant.h, it.h) || 8;
      const vao = it.x - (ant.x + ant.w);
      if (Math.abs(it.y - ant.y) < 0.3 * h && vao > -0.5 * h) {
        if (vao < 0.15 * h) { ant.s += it.s; ant.w = it.x + it.w - ant.x; continue; }
        if (vao < 0.6 * h) { ant.s += (ant.s.endsWith(" ") || it.s.startsWith(" ") ? "" : " ") + it.s; ant.w = it.x + it.w - ant.x; continue; }
      }
    }
    out.push({ ...it });
  }
  return out;
}

/* ---------- entrada ---------- */
export function extrairTextoPDF(buf, maxPaginas = 3) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  if (buf.toString("latin1", 0, 1024).indexOf("%PDF-") < 0) throw new Error("Arquivo não é PDF.");
  const doc = new Documento(buf);
  if (doc.cripto && doc.cripto.naoSuportado) throw new Error("PDF protegido com criptografia não suportada.");
  // catálogo -> árvore de páginas
  let catalogo = null;
  for (const [n] of [...doc.pos, ...doc.objStm]) { const o = doc.objCru(n); const v = o && (o.stream ? o.dict : o.valor); if (v && nomeDe(v.Type) === "Catalog") { catalogo = v; break; } }
  const paginas = [];
  const percorrer = (ref, herdado, prof = 0) => {
    if (paginas.length >= maxPaginas || prof > 30) return;
    const d = doc.dicionario(ref); if (!d) return;
    const rec = d.Resources !== undefined ? d.Resources : herdado;
    if (nomeDe(d.Type) === "Pages" || Array.isArray(doc.resolver(d.Kids))) { for (const k of doc.resolver(d.Kids) || []) percorrer(k, rec, prof + 1); }
    else paginas.push({ d, rec });
  };
  if (catalogo) percorrer(catalogo.Pages, null);
  if (!paginas.length) for (const [n] of doc.pos) { const o = doc.objCru(n); const v = o && o.valor; if (v && nomeDe(v.Type) === "Page") { paginas.push({ d: v, rec: v.Resources }); if (paginas.length >= maxPaginas) break; } }

  let texto = ""; const itens = [];
  paginas.forEach((pg, i) => {
    const saida = [];
    let conteudo = doc.resolver(pg.d.Contents);
    const partes = Array.isArray(conteudo) ? conteudo.map(c => doc.resolver(c)) : [conteudo];
    const dados = Buffer.concat(partes.filter(p => p && p.stream).flatMap(p => [doc.dadosStream(p), Buffer.from("\n")]));
    interpretar(doc, dados, doc.dicionario(pg.rec) || {}, ID, i + 1, saida);
    const linhas = juntarPedacos(saida);
    texto += linhas.map(x => x.s).join(" ") + "\n";
    linhas.forEach(x => { const s = x.s.replace(/\s+/g, " ").trim(); if (s) itens.push({ ...x, s }); });
  });
  return { texto, itens, paginas: paginas.length };
}
