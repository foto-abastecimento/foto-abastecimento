/*
 * Foto Abastecimento — lógica do servidor (usada pelo server.js no Railway).
 * Recebe do server.js: DB (banco SQLite), FILES (pasta de arquivos), ASSETS (telas),
 * lerPDF (leitor de PDF do servidor) e LeituraNF (regras de leitura da nota).
 * Variável opcional: ADMIN_PASSWORD -> senha do usuário "admin".
 *
 * Regra de ouro dos dados: nada é apagado. Tabelas só ganham colunas novas;
 * usuários são desativados (não excluídos); alertas são marcados como vistos.
 */

const LIMITE_NOTA_MIN = 10;      // diferença máxima entre o horário da nota e a foto
const LIMITE_ENVIO_MIN = 20;     // diferença máxima entre a foto e a chegada no servidor
const MAX_FOTO = 8 * 1024 * 1024;
const MAX_PDF = 10 * 1024 * 1024;
const SESSAO_HORAS = 12;
const JANELA_IP = 5;             // semáforo de IP: últimos 5 envios
const MIN_IP_VERDE = 3;          // pelo menos 3 envios no mesmo IP para ficar verde
const BR_OFFSET_MS = -3 * 3600 * 1000; // Brasília, UTC-3 (sem horário de verão desde 2019)

/* ---------- utilitários ---------- */
const enc = s => new TextEncoder().encode(s);
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
const hexToBytes = h => new Uint8Array(h.match(/.{2}/g).map(x => parseInt(x, 16)));
const b64url = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlTexto = s => b64url(enc(s));
const deB64url = s => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0)));
const soDig = s => String(s || "").replace(/\D/g, "");
const numInt = s => { const d = soDig(s).replace(/^0+/, ""); return d || (soDig(s) ? "0" : ""); };
const aleatorio = n => hex(crypto.getRandomValues(new Uint8Array(n)));
const agoraISO = () => new Date().toISOString();
const sha256 = async bytes => hex(await crypto.subtle.digest("SHA-256", bytes));
const corta = (v, n) => v == null || v === "" ? null : String(v).slice(0, n);

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers }
  });
}
const erro = (msg, status = 400, extra = {}) => json({ erro: msg, ...extra }, status);

function iguais(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

/* Data/hora de Brasília a partir de milissegundos */
function brasilia(ms) {
  const d = new Date(ms + BR_OFFSET_MS);
  const p = n => String(n).padStart(2, "0");
  const y = d.getUTCFullYear(), mo = p(d.getUTCMonth() + 1), da = p(d.getUTCDate());
  const h = p(d.getUTCHours()), mi = p(d.getUTCMinutes()), s = p(d.getUTCSeconds());
  return { texto: `${da}/${mo}/${y} ${h}:${mi}:${s}`, dia: `${y}-${mo}-${da}`, arquivo: `${y}-${mo}-${da}_${h}-${mi}-${s}` };
}

/* ---------- CNPJ (numérico e alfanumérico) e CPF ---------- */
const normCNPJ = s => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 14);
function validCNPJ(s) {
  const c = normCNPJ(s);
  if (!/^[A-Z0-9]{12}\d{2}$/.test(c) || /^(.)\1+$/.test(c)) return false;
  const v = ch => ch.charCodeAt(0) - 48;
  const dv = n => { let sum = 0, w = n - 7; for (let i = 0; i < n; i++) { sum += v(c[i]) * w; w--; if (w < 2) w = 9; } const r = sum % 11; return r < 2 ? 0 : 11 - r; };
  return dv(12) === +c[12] && dv(13) === +c[13];
}
function validCPF(s) {
  const c = soDig(s); if (c.length !== 11 || /^(\d)\1+$/.test(c)) return false;
  const dv = n => { let t = 0; for (let i = 0; i < n; i++) t += (+c[i]) * (n + 1 - i); const r = (t * 10) % 11; return r === 10 ? 0 : r; };
  return dv(9) === +c[9] && dv(10) === +c[10];
}

/* ---------- IP de quem enviou ----------
   Atrás do proxy do Railway, o IP real é o último IP público da lista X-Forwarded-For
   (o que o próprio proxy acrescentou). Os da esquerda podem ter sido enviados pelo navegador. */
function ipPrivado(ip) {
  return !ip || /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|0\.)/.test(ip) || /^(::1|fc|fd|fe80)/i.test(ip);
}
function ipCliente(request) {
  const limpa = v => {
    let t = String(v || "").trim(); if (!t) return "";
    let m = t.match(/^\[([^\]]+)\](?::\d+)?$/); if (m) return m[1];
    t = t.replace(/^::ffff:/i, "");
    m = t.match(/^(\d+\.\d+\.\d+\.\d+)(?::\d+)?$/); if (m) return m[1];
    return t;
  };
  const lista = (request.headers.get("x-forwarded-for") || "").split(",").map(limpa).filter(Boolean).reverse();
  const socket = limpa(request.headers.get("x-ip-socket"));
  return lista.find(ip => !ipPrivado(ip)) || lista[0] || socket || "desconhecido";
}

/* ---------- banco: criação e migração (só acrescenta) ---------- */
let preparo = null;
const COLUNAS_NOVAS = {
  fotos: { ip: "TEXT", ip_carimbo: "TEXT", hash_foto: "TEXT", hash_nf: "TEXT", verif_servidor: "TEXT", nf_chave: "TEXT", divergencia: "TEXT", dest_nome_pdf: "TEXT", dest_doc_pdf: "TEXT" },
  alertas: { ip: "TEXT", ip_anterior: "TEXT", chave_foto: "TEXT", chave_nf: "TEXT", hash_foto: "TEXT", hash_nf: "TEXT", origem: "TEXT" }
};
function preparar(env) {
  if (!env.DB || typeof env.DB.prepare !== "function") throw new Erro("O banco não está disponível. Confira a configuração do servidor.", 500);
  if (!env.FILES || typeof env.FILES.put !== "function") throw new Erro("O armazenamento de arquivos não está disponível. Confira a configuração do servidor.", 500);
  if (!preparo) {
    preparo = (async () => {
      await env.DB.batch([
        env.DB.prepare(`CREATE TABLE IF NOT EXISTS config (k TEXT PRIMARY KEY, v TEXT NOT NULL)`),
        env.DB.prepare(`CREATE TABLE IF NOT EXISTS postos (
          id INTEGER PRIMARY KEY AUTOINCREMENT, cnpj TEXT NOT NULL UNIQUE, nome TEXT NOT NULL,
          senha_hash TEXT NOT NULL, salt TEXT NOT NULL, criado_em TEXT NOT NULL, atualizado_em TEXT)`),
        env.DB.prepare(`CREATE TABLE IF NOT EXISTS fotos (
          id INTEGER PRIMARY KEY AUTOINCREMENT, posto_id INTEGER NOT NULL, cliente TEXT NOT NULL, nota TEXT NOT NULL,
          arquivo TEXT NOT NULL, arquivo_nf TEXT NOT NULL, chave_foto TEXT NOT NULL, chave_nf TEXT NOT NULL,
          capturado_em TEXT NOT NULL, capturado_txt TEXT NOT NULL, cap_dia TEXT NOT NULL, recebido_em TEXT NOT NULL,
          dest_nome TEXT, dest_doc TEXT, dest_tipo TEXT, dest_origem TEXT,
          nf_numero TEXT, nf_serie TEXT, nf_modelo TEXT, nf_cnpj_emit TEXT, nf_emissao TEXT, nf_emissao_fonte TEXT, dif_min REAL,
          cnpj_na_epoca TEXT, nome_na_epoca TEXT)`),
        env.DB.prepare(`CREATE INDEX IF NOT EXISTS ix_fotos_posto ON fotos(posto_id, capturado_em)`),
        env.DB.prepare(`CREATE INDEX IF NOT EXISTS ix_fotos_dia ON fotos(cap_dia)`),
        env.DB.prepare(`CREATE TABLE IF NOT EXISTS alertas (
          id INTEGER PRIMARY KEY AUTOINCREMENT, posto_id INTEGER NOT NULL, tipo TEXT NOT NULL, nota TEXT, cliente TEXT,
          emissao TEXT, emissao_fonte TEXT, foto_em TEXT, dif_min REAL, detalhe TEXT, criado_em TEXT NOT NULL,
          visto INTEGER NOT NULL DEFAULT 0, visto_em TEXT)`),
        env.DB.prepare(`CREATE INDEX IF NOT EXISTS ix_alertas ON alertas(visto, criado_em)`),
        env.DB.prepare(`CREATE TABLE IF NOT EXISTS usuarios (
          id INTEGER PRIMARY KEY AUTOINCREMENT, usuario TEXT NOT NULL UNIQUE, nome TEXT NOT NULL,
          senha_hash TEXT NOT NULL, salt TEXT NOT NULL, papel TEXT NOT NULL DEFAULT 'consulta',
          ativo INTEGER NOT NULL DEFAULT 1, criado_em TEXT NOT NULL, atualizado_em TEXT)`)
      ]);
      // colunas novas em tabelas que já existem: ADD COLUMN preserva todos os registros
      for (const [tabela, cols] of Object.entries(COLUNAS_NOVAS)) {
        const atuais = new Set((await env.DB.prepare(`PRAGMA table_info(${tabela})`).all()).results.map(c => c.name));
        for (const [col, tipo] of Object.entries(cols)) if (!atuais.has(col)) await env.DB.prepare(`ALTER TABLE ${tabela} ADD COLUMN ${col} ${tipo}`).run();
      }
      await env.DB.prepare(`CREATE INDEX IF NOT EXISTS ix_fotos_ip ON fotos(posto_id, id)`).run();
    })().catch(e => { preparo = null; throw e; });
  }
  return preparo;
}

class Erro extends Error { constructor(msg, status = 400, extra = {}) { super(msg); this.status = status; this.extra = extra; } }

async function segredo(env) {
  let r = await env.DB.prepare("SELECT v FROM config WHERE k='segredo'").first();
  if (!r) {
    await env.DB.prepare("INSERT OR IGNORE INTO config (k, v) VALUES ('segredo', ?)").bind(aleatorio(32)).run();
    r = await env.DB.prepare("SELECT v FROM config WHERE k='segredo'").first();
  }
  return r.v;
}

/* ---------- senhas (PBKDF2) e sessão (cookie assinado) ---------- */
async function hashSenha(senha, saltHex) {
  const key = await crypto.subtle.importKey("raw", enc(senha), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: hexToBytes(saltHex), iterations: 100000, hash: "SHA-256" }, key, 256);
  return hex(bits);
}
async function assinar(env, texto) {
  const key = await crypto.subtle.importKey("raw", enc(await segredo(env)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", key, enc(texto)));
}
async function versaoAdmin(env) {
  return hex(await crypto.subtle.digest("SHA-256", enc("admin:" + (env.ADMIN_PASSWORD || "admin")))).slice(0, 12);
}
async function criarSessao(env, dados) {
  const corpo = b64urlTexto(JSON.stringify({ ...dados, exp: Date.now() + SESSAO_HORAS * 3600e3 }));
  const token = corpo + "." + await assinar(env, corpo);
  return `sessao=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSAO_HORAS * 3600}`;
}
const apagarSessao = "sessao=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0";

async function lerSessao(request, env) {
  const m = (request.headers.get("cookie") || "").match(/(?:^|;\s*)sessao=([^;]+)/);
  if (!m) return null;
  const [corpo, sig] = m[1].split(".");
  if (!corpo || !sig || !iguais(sig, await assinar(env, corpo))) return null;
  let d; try { d = JSON.parse(deB64url(corpo)); } catch { return null; }
  if (!d.exp || d.exp < Date.now()) return null;
  if (d.r === "admin") return iguais(d.v || "", await versaoAdmin(env)) ? { admin: true, matriz: true, papel: "admin", nome: "Administrador" } : null;
  if (d.r === "consulta") {
    const u = await env.DB.prepare("SELECT id, usuario, nome, salt, ativo FROM usuarios WHERE id = ?").bind(d.uid).first();
    if (!u || !u.ativo || !iguais(u.salt.slice(0, 12), d.s || "")) return null;
    return { consulta: true, matriz: true, papel: "consulta", nome: u.nome, usuario: u.usuario };
  }
  if (d.r === "posto") {
    const p = await env.DB.prepare("SELECT id, cnpj, nome, salt FROM postos WHERE id = ?").bind(d.pid).first();
    // senha alterada pela matriz derruba as sessões antigas
    if (!p || !iguais(p.salt.slice(0, 12), d.s || "")) return null;
    return { posto: { id: p.id, cnpj: p.cnpj, nome: p.nome }, papel: "posto" };
  }
  return null;
}

/* ---------- leitura da nota no servidor ---------- */
function lerNotaNoServidor(env, bytesNf) {
  if (typeof env.lerPDF !== "function" || !env.LeituraNF) return null;
  try {
    const { texto, itens } = env.lerPDF(bytesNf);
    const a = env.LeituraNF.analisar(texto, itens);
    return a && a.lido ? a : null;
  } catch { return null; }
}

/* ---------- alertas ---------- */
const TIPOS_ALERTA = {
  atraso: "Nota fora do horário",
  horario_nao_lido: "Horário da nota não lido",
  ip_alterado: "IP diferente do envio anterior"
};
async function guardarArquivosAlerta(env, postoId, arq) {
  if (!arq || !arq.foto) return {};
  const id = crypto.randomUUID();
  const r = { chave_foto: `alertas/${postoId}/${id}.jpg`, hash_foto: arq.hashFoto || await sha256(arq.foto) };
  await env.FILES.put(r.chave_foto, arq.foto, { httpMetadata: { contentType: "image/jpeg" } });
  if (arq.nf) { r.chave_nf = `alertas/${postoId}/${id}.pdf`; r.hash_nf = arq.hashNf || await sha256(arq.nf); await env.FILES.put(r.chave_nf, arq.nf, { httpMetadata: { contentType: "application/pdf" } }); }
  return r;
}
async function registrarAlerta(env, postoId, a, arquivos) {
  if (!TIPOS_ALERTA[a.tipo]) return;
  const nota = String(a.nota || "").slice(0, 20);
  // mesmo posto, tipo e nota em 30 minutos = mesmo alerta (só completa a foto se faltar)
  if (a.tipo !== "ip_alterado") {
    const limite = new Date(Date.now() - 30 * 60e3).toISOString();
    const ja = await env.DB.prepare("SELECT id, chave_foto FROM alertas WHERE posto_id = ? AND tipo = ? AND nota = ? AND criado_em > ?")
      .bind(postoId, a.tipo, nota, limite).first();
    if (ja) {
      if (!ja.chave_foto && arquivos && arquivos.foto) {
        const g = await guardarArquivosAlerta(env, postoId, arquivos);
        await env.DB.prepare("UPDATE alertas SET chave_foto = ?, chave_nf = ?, hash_foto = ?, hash_nf = ? WHERE id = ?").bind(g.chave_foto || null, g.chave_nf || null, g.hash_foto || null, g.hash_nf || null, ja.id).run();
      }
      return;
    }
  }
  const g = await guardarArquivosAlerta(env, postoId, arquivos);
  await env.DB.prepare(`INSERT INTO alertas (posto_id, tipo, nota, cliente, emissao, emissao_fonte, foto_em, dif_min, detalhe, criado_em,
      ip, ip_anterior, chave_foto, chave_nf, hash_foto, hash_nf, origem)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
    postoId, a.tipo, nota, corta(a.cliente, 60), corta(a.emissao, 30), corta(a.emissaoFonte, 60), corta(a.fotoEm, 30),
    Number.isFinite(+a.difMin) && a.difMin !== null && a.difMin !== "" ? Math.round(+a.difMin * 10) / 10 : null,
    corta(a.detalhe, 300), agoraISO(), corta(a.ip, 60), corta(a.ipAnterior, 60),
    g.chave_foto || null, g.chave_nf || null, g.hash_foto || null, g.hash_nf || null, corta(a.origem, 30)).run();
}

/* Semáforo de IP por posto: últimos 5 envios com IP registrado */
async function semaforoIP(env) {
  const postos = (await env.DB.prepare("SELECT id, nome, cnpj FROM postos ORDER BY nome COLLATE NOCASE").all()).results;
  const res = [];
  for (const p of postos) {
    const ult = (await env.DB.prepare("SELECT ip, capturado_txt FROM fotos WHERE posto_id = ? AND ip IS NOT NULL AND ip <> '' ORDER BY id DESC LIMIT ?").bind(p.id, JANELA_IP).all()).results;
    const ips = [...new Set(ult.map(u => u.ip))];
    let cor = "cinza", texto = "Histórico insuficiente (menos de 2 envios com IP)";
    if (ult.length >= 2 && ips.length > 1) { cor = "vermelho"; texto = `IP mudou nos últimos ${ult.length} envios`; }
    else if (ult.length >= MIN_IP_VERDE && ips.length === 1) { cor = "verde"; texto = `Mesmo IP nos últimos ${ult.length} envios`; }
    else if (ult.length === 2 && ips.length === 1) { cor = "cinza"; texto = "Mesmo IP, mas só 2 envios até agora"; }
    res.push({ posto_id: p.id, posto_nome: p.nome, posto_cnpj: p.cnpj, cor, texto, envios: ult, ips });
  }
  return res;
}

/* ---------- rotas ---------- */
async function api(request, env, url) {
  await preparar(env);
  const metodo = request.method, caminho = url.pathname;

  // proteção contra envio de formulário de outro site
  if (metodo !== "GET" && request.headers.get("x-requested-with") !== "fetch") return erro("Requisição recusada.", 403);

  if (caminho === "/api/time" && metodo === "GET") return json({ agora: agoraISO() });

  if (caminho === "/api/login" && metodo === "POST") {
    const { usuario = "", senha = "" } = await request.json().catch(() => ({}));
    await new Promise(r => setTimeout(r, 300)); // freio simples contra tentativas em sequência
    const u = String(usuario).trim();
    if (u.toLowerCase() === "admin") {
      if (!iguais(String(senha), env.ADMIN_PASSWORD || "admin")) return erro("Usuário ou senha incorretos.", 401);
      return json({ papel: "admin" }, 200, { "set-cookie": await criarSessao(env, { r: "admin", v: await versaoAdmin(env) }) });
    }
    // usuário de consulta da matriz
    const usr = await env.DB.prepare("SELECT * FROM usuarios WHERE usuario = ?").bind(u.toLowerCase()).first();
    if (usr) {
      if (!usr.ativo || !iguais(await hashSenha(String(senha), usr.salt), usr.senha_hash)) return erro("Usuário ou senha incorretos.", 401);
      return json({ papel: "consulta" }, 200, { "set-cookie": await criarSessao(env, { r: "consulta", uid: usr.id, s: usr.salt.slice(0, 12) }) });
    }
    const cnpj = normCNPJ(u);
    if (!validCNPJ(cnpj)) return erro("Usuário ou CNPJ inválido.", 400);
    const p = await env.DB.prepare("SELECT * FROM postos WHERE cnpj = ?").bind(cnpj).first();
    if (!p || !iguais(await hashSenha(String(senha), p.salt), p.senha_hash)) return erro("CNPJ ou senha incorretos. Se esqueceu a senha, fale com a matriz.", 401);
    return json({ papel: "posto" }, 200, { "set-cookie": await criarSessao(env, { r: "posto", pid: p.id, s: p.salt.slice(0, 12) }) });
  }

  if (caminho === "/api/logout" && metodo === "POST") return json({ ok: true }, 200, { "set-cookie": apagarSessao });

  const s = await lerSessao(request, env);
  if (!s) return erro("Sessão expirada. Entre de novo.", 401);

  if (caminho === "/api/me" && metodo === "GET") {
    if (s.matriz) return json({ papel: s.papel, nome: s.nome, senhaPadrao: s.admin ? !env.ADMIN_PASSWORD : false });
    return json({ papel: "posto", posto: s.posto });
  }
  if (caminho === "/api/ip" && metodo === "GET") return json({ ip: ipCliente(request) });

  /* ----- fotos ----- */
  if (caminho === "/api/fotos" && metodo === "POST") {
    if (!s.posto) return erro("Só o acesso do posto envia fotos.", 403);
    return await receberFoto(request, env, s.posto);
  }
  if (caminho === "/api/fotos" && metodo === "GET") return await listarFotos(env, s, url.searchParams);
  if (caminho === "/api/opcoes" && metodo === "GET") return await opcoes(env, s);

  let m = caminho.match(/^\/api\/fotos\/(\d+)\/(foto|nf)$/);
  if (m && metodo === "GET") {
    const f = await env.DB.prepare("SELECT * FROM fotos WHERE id = ?").bind(+m[1]).first();
    if (!f || (s.posto && f.posto_id !== s.posto.id)) return erro("Foto não encontrada.", 404);
    if (m[2] === "nf" && !s.matriz) return erro("A nota fiscal só pode ser baixada pela matriz.", 403);
    const baixar = s.matriz && (url.searchParams.get("download") === "1" || m[2] === "nf");
    return await entregarArquivo(env, m[2] === "nf" ? f.chave_nf : f.chave_foto, m[2] === "nf" ? f.arquivo_nf : f.arquivo, m[2] === "nf", baixar);
  }

  /* ----- alertas ----- */
  if (caminho === "/api/alertas" && metodo === "POST") {
    if (!s.posto) return erro("Só o acesso do posto registra alertas.", 403);
    return await receberAlerta(request, env, s.posto);
  }
  if (caminho === "/api/alertas" && metodo === "GET") {
    if (!s.matriz) return erro("Acesso só da matriz.", 403);
    const todos = url.searchParams.get("todos") === "1";
    const r = await env.DB.prepare(`SELECT a.*, p.nome AS posto_nome, p.cnpj AS posto_cnpj FROM alertas a
      LEFT JOIN postos p ON p.id = a.posto_id ${todos ? "" : "WHERE a.visto = 0"} ORDER BY a.criado_em DESC LIMIT 300`).all();
    const abertos = await env.DB.prepare("SELECT COUNT(*) AS n FROM alertas WHERE visto = 0").first();
    const alertas = r.results.map(a => ({ ...a, tipo_txt: TIPOS_ALERTA[a.tipo] || a.tipo, tem_foto: !!a.chave_foto, tem_nf: !!a.chave_nf, chave_foto: undefined, chave_nf: undefined }));
    return json({ alertas, abertos: abertos.n, semaforo: await semaforoIP(env), podeMarcar: !!s.admin });
  }
  m = caminho.match(/^\/api\/alertas\/(\d+)\/(foto|nf)$/);
  if (m && metodo === "GET") {
    if (!s.matriz) return erro("Acesso só da matriz.", 403);
    const a = await env.DB.prepare("SELECT * FROM alertas WHERE id = ?").bind(+m[1]).first();
    const chave = a && (m[2] === "nf" ? a.chave_nf : a.chave_foto);
    if (!chave) return erro("Este alerta não tem arquivo guardado.", 404);
    const nome = `alerta-${a.id}_nota-${(a.nota || "sem-numero").replace(/[^\w.-]+/g, "-")}.${m[2] === "nf" ? "pdf" : "jpg"}`;
    return await entregarArquivo(env, chave, nome, m[2] === "nf", url.searchParams.get("download") === "1" || m[2] === "nf");
  }
  m = caminho.match(/^\/api\/alertas\/(\d+)$/);
  if (m && metodo === "PUT") {
    if (!s.admin) return erro("Só o administrador marca alertas como vistos.", 403);
    await env.DB.prepare("UPDATE alertas SET visto = 1, visto_em = ? WHERE id = ?").bind(agoraISO(), +m[1]).run();
    return json({ ok: true });
  }

  /* ----- usuários de consulta (só o admin) ----- */
  if (caminho.startsWith("/api/usuarios")) {
    if (!s.admin) return erro("Só o administrador gerencia usuários.", 403);
    if (caminho === "/api/usuarios" && metodo === "GET") {
      const r = await env.DB.prepare("SELECT id, usuario, nome, papel, ativo, criado_em, atualizado_em FROM usuarios ORDER BY nome COLLATE NOCASE").all();
      return json({ usuarios: r.results });
    }
    if (caminho === "/api/usuarios" && metodo === "POST") {
      const { usuario = "", nome = "", senha = "" } = await request.json().catch(() => ({}));
      const u = String(usuario).trim().toLowerCase(), n = String(nome).trim().slice(0, 60);
      if (!/^[a-z0-9._-]{3,30}$/.test(u)) return erro("Usuário: de 3 a 30 caracteres, só letras, números, ponto, hífen ou sublinhado.");
      if (u === "admin" || validCNPJ(u)) return erro("Esse nome de usuário não pode ser usado.");
      if (!n) return erro("Informe o nome da pessoa.");
      if (String(senha).length < 6) return erro("A senha precisa ter pelo menos 6 caracteres.");
      if (await env.DB.prepare("SELECT id FROM usuarios WHERE usuario = ?").bind(u).first()) return erro("Esse usuário já existe.");
      const salt = aleatorio(16);
      await env.DB.prepare("INSERT INTO usuarios (usuario, nome, senha_hash, salt, papel, ativo, criado_em) VALUES (?, ?, ?, ?, 'consulta', 1, ?)")
        .bind(u, n, await hashSenha(String(senha), salt), salt, agoraISO()).run();
      return json({ ok: true });
    }
    m = caminho.match(/^\/api\/usuarios\/(\d+)(\/senha)?$/);
    if (m && metodo === "PUT") {
      const usr = await env.DB.prepare("SELECT id FROM usuarios WHERE id = ?").bind(+m[1]).first();
      if (!usr) return erro("Usuário não encontrado.", 404);
      const corpo = await request.json().catch(() => ({}));
      if (m[2]) {
        if (String(corpo.senha || "").length < 6) return erro("A senha precisa ter pelo menos 6 caracteres.");
        const salt = aleatorio(16);
        await env.DB.prepare("UPDATE usuarios SET senha_hash = ?, salt = ?, atualizado_em = ? WHERE id = ?").bind(await hashSenha(String(corpo.senha), salt), salt, agoraISO(), usr.id).run();
        return json({ ok: true });
      }
      const n = String(corpo.nome || "").trim().slice(0, 60);
      if (!n) return erro("Informe o nome da pessoa.");
      // desativar no lugar de excluir: o histórico continua intacto
      await env.DB.prepare("UPDATE usuarios SET nome = ?, ativo = ?, atualizado_em = ? WHERE id = ?").bind(n, corpo.ativo === false ? 0 : 1, agoraISO(), usr.id).run();
      return json({ ok: true });
    }
  }

  /* ----- postos (só o admin altera; consulta só vê) ----- */
  if (caminho === "/api/postos" && metodo === "GET") {
    if (!s.matriz) return erro("Acesso só da matriz.", 403);
    const r = await env.DB.prepare(`SELECT p.id, p.cnpj, p.nome, p.criado_em, p.atualizado_em,
      (SELECT COUNT(*) FROM fotos f WHERE f.posto_id = p.id) AS fotos,
      (SELECT COUNT(*) FROM alertas a WHERE a.posto_id = p.id AND a.visto = 0) AS alertas
      FROM postos p ORDER BY p.nome COLLATE NOCASE`).all();
    return json({ postos: r.results });
  }
  if (caminho.startsWith("/api/postos") && !s.admin) return erro("Só o administrador altera postos.", 403);
  if (caminho === "/api/postos" && metodo === "POST") {
    const { cnpj: c = "", nome = "", senha = "" } = await request.json().catch(() => ({}));
    const cnpj = normCNPJ(c), n = String(nome).trim().slice(0, 60);
    if (!validCNPJ(cnpj)) return erro("CNPJ inválido. Confira os dígitos.");
    if (!n) return erro("Informe o nome do posto.");
    if (String(senha).length < 4) return erro("A senha precisa ter pelo menos 4 caracteres.");
    if (await env.DB.prepare("SELECT id FROM postos WHERE cnpj = ?").bind(cnpj).first()) return erro("Este CNPJ já está cadastrado.");
    const salt = aleatorio(16);
    await env.DB.prepare("INSERT INTO postos (cnpj, nome, senha_hash, salt, criado_em) VALUES (?, ?, ?, ?, ?)")
      .bind(cnpj, n, await hashSenha(String(senha), salt), salt, agoraISO()).run();
    return json({ ok: true });
  }
  m = caminho.match(/^\/api\/postos\/(\d+)(\/senha)?$/);
  if (m && metodo === "PUT") {
    const id = +m[1];
    const p = await env.DB.prepare("SELECT id FROM postos WHERE id = ?").bind(id).first();
    if (!p) return erro("Posto não encontrado.", 404);
    const corpo = await request.json().catch(() => ({}));
    if (m[2]) {
      if (String(corpo.senha || "").length < 4) return erro("A senha precisa ter pelo menos 4 caracteres.");
      const salt = aleatorio(16);
      await env.DB.prepare("UPDATE postos SET senha_hash = ?, salt = ?, atualizado_em = ? WHERE id = ?")
        .bind(await hashSenha(String(corpo.senha), salt), salt, agoraISO(), id).run();
      return json({ ok: true });
    }
    // edição: o posto mantém o mesmo id, então fotos e alertas continuam vinculados a ele
    const cnpj = normCNPJ(corpo.cnpj), n = String(corpo.nome || "").trim().slice(0, 60);
    if (!validCNPJ(cnpj)) return erro("CNPJ inválido. Confira os dígitos.");
    if (!n) return erro("Informe o nome do posto.");
    const outro = await env.DB.prepare("SELECT id FROM postos WHERE cnpj = ? AND id <> ?").bind(cnpj, id).first();
    if (outro) return erro("Já existe outro posto com este CNPJ.");
    await env.DB.prepare("UPDATE postos SET cnpj = ?, nome = ?, atualizado_em = ? WHERE id = ?").bind(cnpj, n, agoraISO(), id).run();
    return json({ ok: true });
  }

  return erro("Rota não encontrada.", 404);
}

async function entregarArquivo(env, chave, nome, ehPdf, baixar) {
  const obj = await env.FILES.get(chave);
  if (!obj) return erro("Arquivo não encontrado no armazenamento.", 404);
  return new Response(obj.body, { headers: {
    "content-type": ehPdf ? "application/pdf" : "image/jpeg",
    "cache-control": "private, max-age=3600",
    "content-disposition": `${baixar ? "attachment" : "inline"}; filename="${String(nome).replace(/"/g, "")}"`,
    "x-content-type-options": "nosniff"
  } });
}

/* ---------- arquivos do envio (foto + PDF) ---------- */
async function lerArquivosDoForm(form) {
  const foto = form.get("foto"), nf = form.get("nf");
  const r = { foto: null, nf: null };
  if (foto instanceof File && foto.size && foto.size <= MAX_FOTO) {
    const b = new Uint8Array(await foto.arrayBuffer());
    if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) r.foto = b;
  }
  if (nf instanceof File && nf.size && nf.size <= MAX_PDF) {
    const b = new Uint8Array(await nf.arrayBuffer());
    if (new TextDecoder().decode(b.slice(0, 5)) === "%PDF-") r.nf = b;
  }
  return r;
}

/* Alerta enviado pelo posto no momento do bloqueio (com a foto e o PDF, quando houver) */
async function receberAlerta(request, env, posto) {
  const tipoConteudo = request.headers.get("content-type") || "";
  let a = {}, arq = {};
  if (tipoConteudo.includes("multipart/form-data")) {
    let form; try { form = await request.formData(); } catch { return erro("Envio inválido."); }
    try { a = JSON.parse(form.get("meta") || "{}"); } catch { a = {}; }
    arq = await lerArquivosDoForm(form);
  } else a = await request.json().catch(() => ({}));
  if (a.tipo !== "atraso" && a.tipo !== "horario_nao_lido") return json({ ok: true });
  const ip = ipCliente(request);
  // confere com a leitura do servidor: se o servidor lê um horário dentro do limite, não é alerta
  if (arq.nf) {
    const lido = lerNotaNoServidor(env, arq.nf);
    const cap = Date.parse(a.fotoEmISO || "");
    if (lido && lido.emissao && Number.isFinite(cap)) {
      const dif = Math.abs(cap - lido.emissao.ms) / 60e3;
      if (dif <= LIMITE_NOTA_MIN) return json({ ok: true, ignorado: "horário dentro do limite pela leitura do servidor" });
      a = { ...a, tipo: "atraso", emissao: brasilia(lido.emissao.ms).texto, emissaoFonte: lido.emissao.fonte + " (servidor)", difMin: dif };
    }
  }
  await registrarAlerta(env, posto.id, { ...a, ip, origem: "posto" }, arq.foto ? { foto: arq.foto, nf: arq.nf } : null);
  return json({ ok: true });
}

/* ---------- envio da foto + nota (validações no servidor) ---------- */
async function receberFoto(request, env, posto) {
  let form; try { form = await request.formData(); } catch { return erro("Envio inválido."); }
  const foto = form.get("foto"), nf = form.get("nf");
  let m; try { m = JSON.parse(form.get("meta") || "{}"); } catch { return erro("Dados do envio inválidos."); }

  const cliente = String(m.cliente || "").trim().slice(0, 60);
  const nota = String(m.nota || "").trim().slice(0, 20);
  const destNome = String(m.destNome || "").trim().slice(0, 100);
  const destDoc = soDig(m.destDoc);
  if (!cliente) return erro("Informe o cliente/motorista.");
  if (!nota || !numInt(nota)) return erro("Informe o número da nota.");
  if (!(foto instanceof File) || !foto.size) return erro("A foto é obrigatória.");
  if (!(nf instanceof File) || !nf.size) return erro("O PDF da nota fiscal é obrigatório.");
  if (foto.size > MAX_FOTO) return erro("Foto grande demais.");
  if (nf.size > MAX_PDF) return erro("PDF maior que 10 MB.");
  const bytesFoto = new Uint8Array(await foto.arrayBuffer()), bytesNf = new Uint8Array(await nf.arrayBuffer());
  if (!(bytesFoto[0] === 0xFF && bytesFoto[1] === 0xD8 && bytesFoto[2] === 0xFF)) return erro("A foto precisa sair da câmera do sistema.");
  if (new TextDecoder().decode(bytesNf.slice(0, 5)) !== "%PDF-") return erro("O arquivo da nota não é um PDF válido.");
  if (!destNome) return erro("Informe o cliente da nota (nome ou razão social).");
  if (destDoc && !(destDoc.length === 14 ? validCNPJ(destDoc) : destDoc.length === 11 && validCPF(destDoc))) return erro("CNPJ/CPF do cliente da nota inválido.");

  const agora = Date.now(), cap = Date.parse(m.capturadoEm);
  if (!Number.isFinite(cap) || Math.abs(agora - cap) > LIMITE_ENVIO_MIN * 60e3)
    return erro("O horário da foto não confere com o horário do servidor. Descarte e tire a foto de novo.", 422);
  const capBR = brasilia(cap);
  const ip = ipCliente(request);
  const ipCarimbo = corta(m.ipCarimbo, 60);
  const [hashFoto, hashNf] = await Promise.all([sha256(bytesFoto), sha256(bytesNf)]);

  // leitura da nota pelo servidor: é ela que vale para as conferências
  const n = m.nf || {};
  const lido = lerNotaNoServidor(env, bytesNf);
  const divergencias = [];
  let numeroNota, emissao, verif;
  if (lido) {
    verif = "conferida no servidor";
    numeroNota = lido.numero;
    emissao = lido.emissao ? { ms: lido.emissao.ms, fonte: lido.emissao.fonte } : null;
    if (n.numero && numInt(n.numero) !== numeroNota) divergencias.push(`número lido no navegador ${numInt(n.numero)}, no servidor ${numeroNota}`);
    if (Number.isFinite(+n.emissaoMs) && emissao && Math.abs(+n.emissaoMs - emissao.ms) > 60e3) divergencias.push(`horário lido no navegador ${brasilia(+n.emissaoMs).texto}, no servidor ${brasilia(emissao.ms).texto}`);
  } else {
    // PDF que o servidor não conseguiu ler: usa a leitura do navegador e marca o registro
    verif = "não conferida no servidor (PDF não lido)";
    numeroNota = numInt(n.numero);
    emissao = Number.isFinite(+n.emissaoMs) ? { ms: +n.emissaoMs, fonte: n.emissaoFonte || "" } : null;
  }
  if (ipCarimbo && ipCarimbo !== ip) divergencias.push(`IP no carimbo ${ipCarimbo}, IP do envio ${ip}`);

  if (numInt(nota) !== numeroNota) return erro(`O número da nota no PDF${lido ? ` (${numeroNota})` : ""} precisa ser igual ao número digitado.`, 422);

  const base = { nota, cliente, fotoEm: capBR.texto, ip, origem: "servidor" };
  const arquivos = { foto: bytesFoto, nf: bytesNf, hashFoto, hashNf };
  if (!emissao) {
    await registrarAlerta(env, posto.id, { ...base, tipo: "horario_nao_lido", detalhe: "Envio bloqueado no servidor." }, arquivos);
    return erro("Não foi possível ler o horário da nota (hora da saída). Entre em contato com a matriz.", 422, { alertaMatriz: true });
  }
  const dif = Math.abs(cap - emissao.ms) / 60e3;
  const emissaoTxt = brasilia(emissao.ms).texto;
  if (dif > LIMITE_NOTA_MIN) {
    await registrarAlerta(env, posto.id, { ...base, tipo: "atraso", emissao: emissaoTxt, emissaoFonte: emissao.fonte, difMin: dif, detalhe: "Envio bloqueado no servidor." }, arquivos);
    return erro(`Diferença de ${Math.round(dif)} min entre o horário da nota e a foto. Entre em contato com a matriz.`, 422, { alertaMatriz: true });
  }

  // nome do arquivo: nota + data + hora + segundo (Brasília); sufixo se repetir
  const notaArq = nota.replace(/[\\/:*?"<>|\s]+/g, "-").replace(/^-+|-+$/g, "") || "nota";
  const raiz = `${notaArq}_${capBR.arquivo}`;
  const existentes = await env.DB.prepare("SELECT arquivo FROM fotos WHERE posto_id = ? AND arquivo LIKE ?").bind(posto.id, raiz + "%").all();
  const usados = new Set(existentes.results.map(r => r.arquivo));
  let arquivo = raiz + ".jpg", k = 2;
  while (usados.has(arquivo)) arquivo = `${raiz}_${k++}.jpg`;
  const arquivoNf = arquivo.replace(/\.jpg$/, ".pdf");

  const id = crypto.randomUUID();
  const chaveFoto = `postos/${posto.id}/${id}.jpg`, chaveNf = `postos/${posto.id}/${id}.pdf`;
  await env.FILES.put(chaveFoto, bytesFoto, { httpMetadata: { contentType: "image/jpeg" } });
  await env.FILES.put(chaveNf, bytesNf, { httpMetadata: { contentType: "application/pdf" } });

  // IP do envio anterior deste posto (para o alerta de IP alterado)
  const anterior = await env.DB.prepare("SELECT ip FROM fotos WHERE posto_id = ? AND ip IS NOT NULL AND ip <> '' ORDER BY id DESC LIMIT 1").bind(posto.id).first();

  const tipo = destDoc.length === 14 ? "PJ" : destDoc.length === 11 ? "PF" : "NI";
  await env.DB.prepare(`INSERT INTO fotos (posto_id, cliente, nota, arquivo, arquivo_nf, chave_foto, chave_nf, capturado_em, capturado_txt, cap_dia, recebido_em,
      dest_nome, dest_doc, dest_tipo, dest_origem, nf_numero, nf_serie, nf_modelo, nf_cnpj_emit, nf_emissao, nf_emissao_fonte, dif_min, cnpj_na_epoca, nome_na_epoca,
      ip, ip_carimbo, hash_foto, hash_nf, verif_servidor, nf_chave, divergencia, dest_nome_pdf, dest_doc_pdf)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
    posto.id, cliente, nota, arquivo, arquivoNf, chaveFoto, chaveNf, new Date(cap).toISOString(), capBR.texto, capBR.dia, agoraISO(),
    destNome, destDoc || null, tipo, m.destOrigem === "editado à mão" ? "editado à mão" : "lido do PDF",
    numeroNota, corta(lido ? lido.serie : n.serie, 5), corta(lido ? lido.modelo : n.modelo, 10),
    (lido ? lido.cnpjEmit : n.cnpjEmit) ? normCNPJ(lido ? lido.cnpjEmit : n.cnpjEmit) : null, emissaoTxt, corta(emissao.fonte, 60),
    Math.round(dif * 10) / 10, posto.cnpj, posto.nome,
    ip, ipCarimbo, hashFoto, hashNf, verif, lido && lido.chave ? lido.chave : null, divergencias.length ? divergencias.join("; ").slice(0, 500) : null,
    lido && lido.dest ? corta(lido.dest.nome, 100) : null, lido && lido.dest ? corta(lido.dest.doc, 14) : null).run();

  if (anterior && anterior.ip && anterior.ip !== ip)
    await registrarAlerta(env, posto.id, { tipo: "ip_alterado", nota, cliente, fotoEm: capBR.texto, ip, ipAnterior: anterior.ip, origem: "servidor", detalhe: "Envio aceito; IP diferente do envio anterior." });

  return json({ ok: true, arquivo, arquivoNf, hashFoto, verificacao: verif });
}

/* ---------- listagem com filtros ---------- */
async function listarFotos(env, s, q) {
  const onde = [], args = [];
  if (s.posto) { onde.push("f.posto_id = ?"); args.push(s.posto.id); }
  else if (q.get("posto")) { onde.push("f.posto_id = ?"); args.push(+q.get("posto")); }
  if (q.get("mes")) { onde.push("f.cap_dia LIKE ?"); args.push(q.get("mes").slice(0, 7) + "%"); }
  if (q.get("de")) { onde.push("f.cap_dia >= ?"); args.push(q.get("de").slice(0, 10)); }
  if (q.get("ate")) { onde.push("f.cap_dia <= ?"); args.push(q.get("ate").slice(0, 10)); }
  const cli = q.get("cli");
  if (cli) {
    if (cli.startsWith("nome:")) { onde.push("lower(f.dest_nome) = ?"); args.push(cli.slice(5)); }
    else { onde.push("f.dest_doc = ?"); args.push(soDig(cli)); }
  }
  const tipo = q.get("tipo");
  if (tipo === "NI") onde.push("(f.dest_tipo = 'NI' OR f.dest_tipo IS NULL)");
  else if (tipo === "PJ" || tipo === "PF") { onde.push("f.dest_tipo = ?"); args.push(tipo); }
  const busca = (q.get("q") || "").trim().toLowerCase();
  if (busca) {
    const t = "%" + busca.replace(/[%_]/g, "") + "%", d = soDig(busca);
    const partes = ["lower(f.dest_nome) LIKE ?", "lower(f.cliente) LIKE ?", "lower(f.nota) LIKE ?", "lower(p.nome) LIKE ?"];
    args.push(t, t, t, t);
    if (d.length >= 3) { partes.push("f.dest_doc LIKE ?", "p.cnpj LIKE ?"); args.push("%" + d + "%", "%" + d + "%"); }
    if (s.matriz) { partes.push("f.ip LIKE ?", "f.hash_foto LIKE ?"); args.push(t, t); }
    onde.push("(" + partes.join(" OR ") + ")");
  }
  const where = onde.length ? "WHERE " + onde.join(" AND ") : "";
  const teto = s.matriz && q.get("relatorio") === "1" ? 20000 : 500;
  const limite = Math.min(teto, Math.max(1, +q.get("limite") || 200));
  const total = await env.DB.prepare(`SELECT COUNT(*) AS n FROM fotos f LEFT JOIN postos p ON p.id = f.posto_id ${where}`).bind(...args).first();
  const r = await env.DB.prepare(`SELECT f.id, f.posto_id, f.cliente, f.nota, f.arquivo, f.arquivo_nf, f.capturado_txt, f.cap_dia, f.recebido_em,
      f.dest_nome, f.dest_doc, f.dest_tipo, f.dest_origem, f.nf_emissao, f.nf_emissao_fonte, f.dif_min, f.nf_serie, f.nf_modelo, f.nf_cnpj_emit, f.nf_chave,
      f.ip, f.ip_carimbo, f.hash_foto, f.hash_nf, f.verif_servidor, f.divergencia,
      p.nome AS posto_nome, p.cnpj AS posto_cnpj
      FROM fotos f LEFT JOIN postos p ON p.id = f.posto_id ${where} ORDER BY f.capturado_em DESC LIMIT ${limite}`).bind(...args).all();
  const ocultarDoPosto = ["arquivo_nf", "ip", "ip_carimbo", "hash_foto", "hash_nf", "verif_servidor", "divergencia", "nf_chave", "nf_cnpj_emit", "recebido_em"];
  const fotos = r.results.map(f => { if (s.matriz) return f; const o = { ...f }; ocultarDoPosto.forEach(k => delete o[k]); return o; });
  const geral = s.posto
    ? await env.DB.prepare("SELECT COUNT(*) AS n FROM fotos WHERE posto_id = ?").bind(s.posto.id).first()
    : await env.DB.prepare("SELECT COUNT(*) AS n FROM fotos").first();
  return json({ fotos, total: total.n, geral: geral.n });
}

async function opcoes(env, s) {
  const filtro = s.posto ? "WHERE posto_id = ?" : "";
  const args = s.posto ? [s.posto.id] : [];
  const meses = await env.DB.prepare(`SELECT DISTINCT substr(cap_dia, 1, 7) AS mes FROM fotos ${filtro} ORDER BY mes DESC`).bind(...args).all();
  const clis = await env.DB.prepare(`SELECT dest_nome, dest_doc, MAX(capturado_em) AS ult FROM fotos ${filtro} ${filtro ? "AND" : "WHERE"} dest_nome IS NOT NULL AND dest_nome <> ''
    GROUP BY COALESCE(dest_doc, lower(dest_nome)) ORDER BY dest_nome COLLATE NOCASE`).bind(...args).all();
  const res = {
    meses: meses.results.map(r => r.mes),
    clientes: clis.results.map(r => ({ valor: r.dest_doc || "nome:" + r.dest_nome.toLowerCase(), nome: r.dest_nome, doc: r.dest_doc || "" }))
  };
  if (s.matriz) res.postos = (await env.DB.prepare("SELECT id, cnpj, nome FROM postos ORDER BY nome COLLATE NOCASE").all()).results;
  return json(res);
}

/* ---------- entrada ---------- */
const BLOQUEADOS = /^\/(LEIA-ME|README|schema)\b|\.md$|\.sql$/i;
/* Diagnóstico: /api/status (não mostra dados, só se as peças estão ligadas) */
async function status(env) {
  const r = { servidor: "ok", armazenamento: env.ARMAZENAMENTO || "", banco_DB: "", arquivos_FILES: "", leitor_pdf_servidor: typeof env.lerPDF === "function" && env.LeituraNF ? "ok" : "indisponível", senha_admin: env.ADMIN_PASSWORD ? "definida (ADMIN_PASSWORD)" : "padrão (admin)", hora_servidor: agoraISO() };
  if (!env.DB || typeof env.DB.prepare !== "function") r.banco_DB = "indisponível";
  else {
    try { await preparar({ ...env, FILES: env.FILES && typeof env.FILES.put === "function" ? env.FILES : { put() {} } }); const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM postos").first(); r.banco_DB = `ok (${n.n} posto(s) cadastrado(s))`; }
    catch (e) { r.banco_DB = "ERRO: " + (e && e.message || e); }
  }
  if (!env.FILES || typeof env.FILES.put !== "function") r.arquivos_FILES = "indisponível";
  else {
    try { await env.FILES.put("_diagnostico.txt", "ok " + agoraISO()); const o = await env.FILES.get("_diagnostico.txt"); r.arquivos_FILES = o ? "ok (gravou e leu um arquivo de teste)" : "ERRO: gravou mas não leu"; }
    catch (e) { r.arquivos_FILES = "ERRO: " + (e && e.message || e); }
  }
  return json(r);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/status") {
      try { return await status(env); } catch (e) { return json({ erro: "Falha no diagnóstico: " + (e && e.message || e) }, 500); }
    }
    if (url.pathname.startsWith("/api/")) {
      try { return await api(request, env, url); }
      catch (e) {
        if (e instanceof Erro) return erro(e.message, e.status, e.extra);
        console.error(e);
        return erro("Erro no servidor: " + ((e && e.message) || String(e)) + ". Abra /api/status para conferir a configuração.", 500);
      }
    }
    if (BLOQUEADOS.test(url.pathname)) return new Response("Não encontrado", { status: 404 });
    const resp = await env.ASSETS.fetch(request);
    const r = new Response(resp.body, resp);
    r.headers.set("x-content-type-options", "nosniff");
    r.headers.set("referrer-policy", "same-origin");
    r.headers.set("permissions-policy", "camera=(self), microphone=(), geolocation=()");
    r.headers.set("x-frame-options", "DENY");
    return r;
  }
};
