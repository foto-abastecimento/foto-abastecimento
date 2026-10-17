/*
 * Foto Abastecimento — servidor Node.js para o Railway.
 * Sem dependências externas: usa o SQLite embutido do Node (22.13 ou mais novo).
 *
 * Variáveis de ambiente:
 *   PORT            porta (o Railway define sozinho)
 *   ADMIN_PASSWORD  senha do usuário "admin" (sem ela, a senha é "admin")
 *   DATA_DIR        pasta do banco e dos arquivos. No Railway, use o volume:
 *                   se RAILWAY_VOLUME_MOUNT_PATH existir, ele é usado automaticamente.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import vm from "node:vm";
import logica from "./logica.mjs";
import { extrairTextoPDF } from "./pdf-texto.mjs";

const RAIZ = path.dirname(fileURLToPath(import.meta.url));
const VOLUME = process.env.RAILWAY_VOLUME_MOUNT_PATH;
const DADOS = process.env.DATA_DIR || VOLUME || path.join(RAIZ, "data");
const PASTA_ARQ = path.join(DADOS, "arquivos");
const PUBLICO = path.join(RAIZ, "public");
const MAX_CORPO = 25 * 1024 * 1024;
fs.mkdirSync(PASTA_ARQ, { recursive: true });

/* ---------- banco: mesma interface usada pela lógica ---------- */
const sql = new DatabaseSync(path.join(DADOS, "banco.sqlite"));
sql.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
const norm = a => a.map(v => v === undefined ? null : v);
class Consulta {
  constructor(q, a = []) { this.q = q; this.a = a; }
  bind(...a) { return new Consulta(this.q, norm(a)); }
  async first() { const r = sql.prepare(this.q).get(...this.a); return r ? { ...r } : null; }
  async all() { return { results: sql.prepare(this.q).all(...this.a).map(r => ({ ...r })) }; }
  async run() { return sql.prepare(this.q).run(...this.a); }
}
const DB = {
  prepare: q => new Consulta(q),
  batch: async lista => { sql.exec("BEGIN"); try { for (const c of lista) await c.run(); sql.exec("COMMIT"); } catch (e) { sql.exec("ROLLBACK"); throw e; } }
};

/* ---------- arquivos: mesma interface usada pela lógica ---------- */
const caminhoSeguro = chave => {
  const p = path.resolve(PASTA_ARQ, chave);
  if (!p.startsWith(path.resolve(PASTA_ARQ) + path.sep)) throw new Error("Chave de arquivo inválida.");
  return p;
};
const FILES = {
  async put(chave, dados) {
    const p = caminhoSeguro(chave);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, typeof dados === "string" ? dados : Buffer.from(dados));
  },
  async get(chave) {
    const p = caminhoSeguro(chave);
    if (!fs.existsSync(p)) return null;
    return { body: fs.readFileSync(p) };
  }
};

/* ---------- telas (arquivos da pasta public) ---------- */
const TIPOS = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon" };
const ASSETS = {
  async fetch(request) {
    let p = decodeURIComponent(new URL(request.url).pathname);
    if (p === "/" || p === "") p = "/index.html";
    const arq = path.resolve(PUBLICO, "." + p);
    if (!arq.startsWith(path.resolve(PUBLICO) + path.sep) || !fs.existsSync(arq) || !fs.statSync(arq).isFile())
      return new Response("Não encontrado", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
    return new Response(fs.readFileSync(arq), { headers: { "content-type": TIPOS[path.extname(arq)] || "application/octet-stream", "cache-control": p === "/index.html" ? "no-cache" : "public, max-age=300" } });
  }
};

/* ---------- leitura da nota no servidor (mesmas regras do navegador) ---------- */
const contextoLeitura = {};
vm.runInNewContext(fs.readFileSync(path.join(PUBLICO, "leitura-nf.js"), "utf8"), contextoLeitura);

const env = {
  DB, FILES, ASSETS,
  lerPDF: bytes => extrairTextoPDF(Buffer.from(bytes)),
  LeituraNF: contextoLeitura.LeituraNF,
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || "",
  ARMAZENAMENTO: VOLUME ? `volume do Railway em ${VOLUME}` : (process.env.DATA_DIR ? `pasta ${DADOS}` : "ATENÇÃO: sem volume, os dados somem a cada nova publicação. Crie um volume no Railway.")
};

/* ---------- ponte HTTP do Node <-> Request/Response ---------- */
const servidor = http.createServer(async (req, res) => {
  try {
    const proto = (req.headers["x-forwarded-proto"] || "http").split(",")[0].trim();
    const url = `${proto}://${req.headers.host || "localhost"}${req.url}`;
    let corpo;
    if (!["GET", "HEAD"].includes(req.method)) {
      const partes = []; let total = 0;
      for await (const pedaco of req) {
        total += pedaco.length;
        if (total > MAX_CORPO) { res.writeHead(413, { "content-type": "application/json; charset=utf-8" }); return res.end(JSON.stringify({ erro: "Envio grande demais." })); }
        partes.push(pedaco);
      }
      corpo = Buffer.concat(partes);
    }
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
    headers.set("x-ip-socket", req.socket.remoteAddress || ""); // sobrescreve qualquer valor enviado pelo navegador
    const resposta = await logica.fetch(new Request(url, { method: req.method, headers, body: corpo }), env);
    const saida = {};
    resposta.headers.forEach((v, k) => { saida[k] = v; });
    // em http local (sem HTTPS) o cookie "Secure" não seria guardado pelo navegador
    if (proto !== "https" && saida["set-cookie"]) saida["set-cookie"] = saida["set-cookie"].replace("; Secure", "");
    res.writeHead(resposta.status, saida);
    res.end(req.method === "HEAD" ? undefined : Buffer.from(await resposta.arrayBuffer()));
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ erro: "Erro no servidor." }));
  }
});

const PORTA = +process.env.PORT || 3000;
servidor.listen(PORTA, "0.0.0.0", () => {
  console.log(`Foto Abastecimento no ar na porta ${PORTA}. Dados em: ${DADOS}`);
  if (!VOLUME && !process.env.DATA_DIR) console.log("ATENÇÃO: sem volume configurado. No Railway, crie um volume para não perder dados.");
});
