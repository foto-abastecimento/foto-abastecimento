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
const MAX_MINI = 80 * 1024;
const RAIO_LOCAL_M = 500;         // distância do local cadastrado do posto que gera alerta
const SESSAO_HORAS = 12;
const JANELA_IP = 5;             // semáforo de IP: últimos 5 logins do posto
const MIN_IP_VERDE = 3;          // pelo menos 3 logins no mesmo IP para ficar verde
const LIMITE_TENTATIVAS = 5;      // senhas erradas seguidas antes do bloqueio
const BLOQUEIO_MIN = 30;          // duração do bloqueio automático (a matriz pode desbloquear antes)
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
/* localização: valida {lat, lng, precisao} vinda do navegador */
function lerLocal(o) {
  if (!o || typeof o !== "object") return null;
  const lat = +o.lat, lng = +o.lng, prec = o.precisao == null || o.precisao === "" ? null : +o.precisao;
  if (o.lat == null || o.lng == null || o.lat === "" || o.lng === "") return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180 || (lat === 0 && lng === 0)) return null;
  return { lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6, precisao: Number.isFinite(prec) && prec >= 0 ? Math.round(prec) : null };
}
/* distância em metros entre dois pontos (fórmula de haversine) */
function distanciaM(a, b) {
  const R = 6371000, rad = x => x * Math.PI / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}
const temLocalCadastrado = p => p && p.lat != null && p.lng != null;
const fmtDist = m => m >= 1000 ? `${(m / 1000).toFixed(1).replace(".", ",")} km` : `${m} m`;

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
function limpaIP(v) {
  let t = String(v || "").trim(); if (!t) return "";
  let m = t.match(/^\[([^\]]+)\](?::\d+)?$/); if (m) return m[1];
  t = t.replace(/^::ffff:/i, "");
  m = t.match(/^(\d+\.\d+\.\d+\.\d+)(?::\d+)?$/); if (m) return m[1];
  return t;
}
function ipCliente(request) { return origemIP(request, limpaIP).ip; }
/* IP real do navegador atrás do Railway.
   O Railway monta "X-Forwarded-For: <IP do cliente>, <IP do CDN do Railway>" e põe o IP do cliente em "X-Real-IP".
   Antes o sistema pegava o último IP público da lista, que é o do CDN do Railway (sempre o mesmo para todos).
   Agora: X-Real-IP (escrito pela borda do Railway); se ele vier igual ao último salto da lista (falha conhecida
   do Railway com o CDN ligado), vale o primeiro IP público do X-Forwarded-For. */
function origemIP(request, limpa) {
  const lista = (request.headers.get("x-forwarded-for") || "").split(",").map(limpa).filter(Boolean);
  const real = limpa(request.headers.get("x-real-ip"));
  const socket = limpa(request.headers.get("x-ip-socket"));
  const ultimoSalto = lista.length > 1 ? lista[lista.length - 1] : null;
  let ip, fonte;
  if (real && !ipPrivado(real) && real !== ultimoSalto) { ip = real; fonte = "X-Real-IP"; }
  else if (lista.find(x => !ipPrivado(x))) { ip = lista.find(x => !ipPrivado(x)); fonte = "X-Forwarded-For (primeiro IP público)"; }
  else { ip = real || lista[0] || socket || "desconhecido"; fonte = real ? "X-Real-IP" : lista[0] ? "X-Forwarded-For" : "conexão direta"; }
  return { ip, fonte, xff: lista.join(", "), xRealIp: real, socket };
}
/* data a partir da qual o IP passou a ser o do navegador (logins anteriores guardaram o IP do CDN do Railway) */
let ipRealDesdeCache = null;
async function ipRealDesde(env) {
  if (ipRealDesdeCache) return ipRealDesdeCache;
  await env.DB.prepare("INSERT OR IGNORE INTO config (k, v) VALUES ('ip_real_desde', ?)").bind(agoraISO()).run();
  return ipRealDesdeCache = (await env.DB.prepare("SELECT v FROM config WHERE k = 'ip_real_desde'").first()).v;
}

/* ---------- banco: criação e migração (só acrescenta) ---------- */
let preparo = null;
const COLUNAS_NOVAS = {
  fotos: { ip: "TEXT", ip_carimbo: "TEXT", hash_foto: "TEXT", hash_nf: "TEXT", verif_servidor: "TEXT", nf_chave: "TEXT", divergencia: "TEXT", dest_nome_pdf: "TEXT", dest_doc_pdf: "TEXT", chave_mini: "TEXT", lat: "REAL", lng: "REAL", precisao: "REAL", dist_m: "REAL" },
  alertas: { ip: "TEXT", ip_anterior: "TEXT", chave_foto: "TEXT", chave_nf: "TEXT", hash_foto: "TEXT", hash_nf: "TEXT", origem: "TEXT", lat: "REAL", lng: "REAL", precisao: "REAL", dist_m: "REAL" },
  postos: { lat: "REAL", lng: "REAL", usa_local: "INTEGER NOT NULL DEFAULT 0" },
  acessos: { lat: "REAL", lng: "REAL", precisao: "REAL", dist_m: "REAL" },
  // usuários que já existiam (antigo "consulta") mantêm o que já faziam: baixar e ver alertas
  usuarios: { perm_baixar: "INTEGER NOT NULL DEFAULT 1", perm_alertas: "INTEGER NOT NULL DEFAULT 1", perm_postos: "INTEGER NOT NULL DEFAULT 0", perm_usuarios: "INTEGER NOT NULL DEFAULT 0" }
};
function preparar(env) {
  if (!env.DB || typeof env.DB.prepare !== "function") throw new Error("Banco (DB) indisponível.");
  if (!env.FILES || typeof env.FILES.put !== "function") throw new Error("Armazenamento (FILES) indisponível.");
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
        env.DB.prepare(`CREATE TABLE IF NOT EXISTS acessos (
          id INTEGER PRIMARY KEY AUTOINCREMENT, posto_id INTEGER NOT NULL, ip TEXT, navegador TEXT,
          cnpj_na_epoca TEXT, criado_em TEXT NOT NULL)`),
        env.DB.prepare(`CREATE INDEX IF NOT EXISTS ix_acessos_posto ON acessos(posto_id, id)`),
        env.DB.prepare(`CREATE TABLE IF NOT EXISTS usuarios (
          id INTEGER PRIMARY KEY AUTOINCREMENT, usuario TEXT NOT NULL UNIQUE, nome TEXT NOT NULL,
          senha_hash TEXT NOT NULL, salt TEXT NOT NULL, papel TEXT NOT NULL DEFAULT 'consulta',
          ativo INTEGER NOT NULL DEFAULT 1, criado_em TEXT NOT NULL, atualizado_em TEXT)`),
        env.DB.prepare(`CREATE TABLE IF NOT EXISTS bloqueios (
          chave TEXT PRIMARY KEY, falhas INTEGER NOT NULL DEFAULT 0, bloqueado_ate TEXT, ultimo_ip TEXT, atualizado_em TEXT)`),
        env.DB.prepare(`CREATE TABLE IF NOT EXISTS registros (
          id INTEGER PRIMARY KEY AUTOINCREMENT, criado_em TEXT NOT NULL, dia TEXT NOT NULL, ator_tipo TEXT NOT NULL, ator_id INTEGER,
          ator_nome TEXT, acao TEXT NOT NULL, descricao TEXT, alvo TEXT, ip TEXT, lote TEXT, qtd INTEGER NOT NULL DEFAULT 1)`),
        env.DB.prepare(`CREATE INDEX IF NOT EXISTS ix_registros ON registros(ator_tipo, ator_id, id)`),
        env.DB.prepare(`CREATE INDEX IF NOT EXISTS ix_registros_dia ON registros(dia)`)
      ]);
      // colunas novas em tabelas que já existem: ADD COLUMN preserva todos os registros
      for (const [tabela, cols] of Object.entries(COLUNAS_NOVAS)) {
        const atuais = new Set((await env.DB.prepare(`PRAGMA table_info(${tabela})`).all()).results.map(c => c.name));
        for (const [col, tipo] of Object.entries(cols)) if (!atuais.has(col)) await env.DB.prepare(`ALTER TABLE ${tabela} ADD COLUMN ${col} ${tipo}`).run();
      }
      await env.DB.prepare(`CREATE INDEX IF NOT EXISTS ix_fotos_ip ON fotos(posto_id, id)`).run();
      await ipRealDesde(env);
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

/* ---------- poderes dos usuários da matriz ---------- */
const PODERES = {
  baixar: "Baixar fotos, notas e relatórios",
  alertas: "Ver alertas e farol de IP",
  postos: "Alterar postos (cadastrar, editar, senha, desbloquear)",
  usuarios: "Alterar usuários da matriz"
};
const TODOS_PODERES = Object.fromEntries(Object.keys(PODERES).map(k => [k, true]));
const poderesDe = u => Object.fromEntries(Object.keys(PODERES).map(k => [k, !!u["perm_" + k]]));
const pode = (s, p) => !!(s && (s.admin || (s.perms && s.perms[p])));

async function lerSessao(request, env) {
  const m = (request.headers.get("cookie") || "").match(/(?:^|;\s*)sessao=([^;]+)/);
  if (!m) return null;
  const [corpo, sig] = m[1].split(".");
  if (!corpo || !sig || !iguais(sig, await assinar(env, corpo))) return null;
  let d; try { d = JSON.parse(deB64url(corpo)); } catch { return null; }
  if (!d.exp || d.exp < Date.now()) return null;
  if (d.r === "admin") return iguais(d.v || "", await versaoAdmin(env)) ? { admin: true, matriz: true, papel: "admin", nome: "Administrador", usuario: "admin", perms: TODOS_PODERES } : null;
  if (d.r === "consulta") {
    const u = await env.DB.prepare("SELECT * FROM usuarios WHERE id = ?").bind(d.uid).first();
    if (!u || !u.ativo || !iguais(u.salt.slice(0, 12), d.s || "")) return null;
    return { matriz: true, papel: "matriz", uid: u.id, nome: u.nome, usuario: u.usuario, perms: poderesDe(u) };
  }
  if (d.r === "posto") {
    const p = await env.DB.prepare("SELECT id, cnpj, nome, salt, lat, lng, usa_local FROM postos WHERE id = ?").bind(d.pid).first();
    // senha alterada pela matriz derruba as sessões antigas
    if (!p || !iguais(p.salt.slice(0, 12), d.s || "")) return null;
    return { posto: { id: p.id, cnpj: p.cnpj, nome: p.nome, usa_local: !!p.usa_local }, papel: "posto", postoLocal: { lat: p.lat, lng: p.lng } };
  }
  return null;
}

/* ---------- registro de ações (só o admin consulta) ---------- */
function ator(s) {
  if (!s) return { tipo: "sistema", id: null, nome: "Sistema" };
  if (s.admin) return { tipo: "admin", id: null, nome: "Administrador (admin)" };
  if (s.posto) return { tipo: "posto", id: s.posto.id, nome: `${s.posto.nome} (${s.posto.cnpj})` };
  return { tipo: "matriz", id: s.uid, nome: `${s.nome} (${s.usuario})` };
}
async function registrar(env, s, request, acao, descricao, extra = {}) {
  const a = extra.ator || ator(s), agora = Date.now();
  const ip = request ? ipCliente(request) : null;
  if (extra.lote) {
    const ja = await env.DB.prepare("SELECT id, qtd FROM registros WHERE ator_tipo = ? AND IFNULL(ator_id, 0) = ? AND acao = ? AND lote = ?").bind(a.tipo, a.id || 0, acao, extra.lote).first();
    if (ja) { await env.DB.prepare("UPDATE registros SET qtd = qtd + 1, descricao = ? WHERE id = ?").bind(String(descricao).replace("{n}", ja.qtd + 1).slice(0, 500), ja.id).run(); return; }
  }
  if (extra.dedupSeg) {
    const lim = new Date(agora - extra.dedupSeg * 1000).toISOString();
    const ja = await env.DB.prepare("SELECT id FROM registros WHERE ator_tipo = ? AND IFNULL(ator_id, 0) = ? AND acao = ? AND alvo = ? AND criado_em > ?").bind(a.tipo, a.id || 0, acao, extra.alvo || "", lim).first();
    if (ja) return;
  }
  await env.DB.prepare(`INSERT INTO registros (criado_em, dia, ator_tipo, ator_id, ator_nome, acao, descricao, alvo, ip, lote, qtd)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`).bind(new Date(agora).toISOString(), brasilia(agora).dia, a.tipo, a.id, corta(a.nome, 120),
    acao, String(descricao).replace("{n}", 1).slice(0, 500), corta(extra.alvo, 120) || "", corta(ip, 60), corta(extra.lote, 60)).run();
}
const ACOES = {
  login_matriz: "Entrou no portal da matriz", login_admin: "Entrou como administrador",
  baixou_foto: "Baixou foto", baixou_nf: "Baixou nota fiscal", baixou_alerta_foto: "Baixou foto de alerta", baixou_alerta_nf: "Baixou NF de alerta",
  baixou_zip: "Baixou .zip", gerou_excel: "Gerou relatório Excel",
  posto_criado: "Cadastrou posto", posto_editado: "Editou posto", posto_senha: "Trocou senha de posto", posto_desbloqueado: "Desbloqueou posto",
  usuario_criado: "Criou usuário da matriz", usuario_editado: "Alterou usuário da matriz", usuario_senha: "Trocou senha de usuário da matriz", usuario_desbloqueado: "Desbloqueou usuário da matriz",
  alerta_visto: "Marcou alerta como visto", bloqueio: "Bloqueio por senhas erradas", posto_abriu_foto: "Posto abriu foto",
  nota_repetida: "Posto tentou repetir nota"
};

/* ---------- bloqueio após tentativas erradas ---------- */
async function bloqueioAtivo(env, chave) {
  const b = await env.DB.prepare("SELECT * FROM bloqueios WHERE chave = ?").bind(chave).first();
  return b && b.bloqueado_ate && Date.parse(b.bloqueado_ate) > Date.now() ? b : null;
}
async function senhaErrada(env, request, chave, conta) {
  const ip = ipCliente(request), agora = agoraISO();
  await env.DB.prepare(`INSERT INTO bloqueios (chave, falhas, ultimo_ip, atualizado_em) VALUES (?, 1, ?, ?)
    ON CONFLICT(chave) DO UPDATE SET falhas = falhas + 1, ultimo_ip = excluded.ultimo_ip, atualizado_em = excluded.atualizado_em`).bind(chave, ip, agora).run();
  const b = await env.DB.prepare("SELECT falhas FROM bloqueios WHERE chave = ?").bind(chave).first();
  if (b.falhas < LIMITE_TENTATIVAS) return { restantes: LIMITE_TENTATIVAS - b.falhas };
  const ate = new Date(Date.now() + BLOQUEIO_MIN * 60e3).toISOString();
  await env.DB.prepare("UPDATE bloqueios SET falhas = 0, bloqueado_ate = ? WHERE chave = ?").bind(ate, chave).run();
  const desc = `${conta.nome} bloqueado por ${BLOQUEIO_MIN} min após ${LIMITE_TENTATIVAS} senhas erradas seguidas (último IP ${ip}).`;
  await registrar(env, null, request, "bloqueio", desc, { alvo: chave });
  await registrarAlerta(env, conta.postoId || 0, { tipo: "bloqueio", ip, origem: "login", detalhe: desc, cliente: conta.nome });
  return { bloqueadoAte: ate };
}
const msgBloqueio = (ate, admin) => `Acesso bloqueado por ${LIMITE_TENTATIVAS} tentativas com senha errada. Tente de novo às ${brasilia(Date.parse(ate)).texto.slice(11, 16)}` + (admin ? "." : " ou peça o desbloqueio à matriz.");

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
  ip_login: "Login de IP diferente do anterior",
  bloqueio: "Acesso bloqueado (senhas erradas)",
  local_login: "Login longe do local do posto",
  local_envio: "Envio longe do local do posto",
  ip_alterado: "IP diferente do envio anterior" // tipo antigo, mantido para o histórico
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
  if (a.tipo !== "ip_alterado" && a.tipo !== "ip_login" && a.tipo !== "bloqueio" && a.tipo !== "local_login") {
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
      ip, ip_anterior, chave_foto, chave_nf, hash_foto, hash_nf, origem, lat, lng, precisao, dist_m)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
    postoId, a.tipo, nota, corta(a.cliente, 60), corta(a.emissao, 30), corta(a.emissaoFonte, 60), corta(a.fotoEm, 30),
    Number.isFinite(+a.difMin) && a.difMin !== null && a.difMin !== "" ? Math.round(+a.difMin * 10) / 10 : null,
    corta(a.detalhe, 300), agoraISO(), corta(a.ip, 60), corta(a.ipAnterior, 60),
    g.chave_foto || null, g.chave_nf || null, g.hash_foto || null, g.hash_nf || null, corta(a.origem, 30),
    a.local ? a.local.lat : null, a.local ? a.local.lng : null, a.local ? a.local.precisao : null, a.distM ?? null).run();
}

/* Semáforo de IP por posto: últimos 5 logins do posto */
async function semaforoIP(env) {
  const postos = (await env.DB.prepare("SELECT id, nome, cnpj, lat, lng, usa_local FROM postos ORDER BY nome COLLATE NOCASE").all()).results;
  const res = [];
  for (const p of postos) {
    const ult = (await env.DB.prepare("SELECT ip, criado_em FROM acessos WHERE posto_id = ? AND ip IS NOT NULL AND ip <> '' AND criado_em >= ? ORDER BY id DESC LIMIT ?").bind(p.id, await ipRealDesde(env), JANELA_IP).all()).results
      .map(u => ({ ip: u.ip, quando: brasilia(Date.parse(u.criado_em)).texto }));
    const ips = [...new Set(ult.map(u => u.ip))];
    let cor = "cinza", texto = ult.length ? "Histórico insuficiente: só 1 login registrado (primeiro acesso não conta)" : "Nenhum login registrado ainda";
    if (ult.length >= 2 && ips.length > 1) { cor = "vermelho"; texto = `IP mudou nos últimos ${ult.length} logins`; }
    else if (ult.length >= MIN_IP_VERDE && ips.length === 1) { cor = "verde"; texto = `Mesmo IP nos últimos ${ult.length} logins`; }
    else if (ult.length === 2 && ips.length === 1) { cor = "cinza"; texto = "Mesmo IP, mas só 2 logins até agora"; }
    res.push({ posto_id: p.id, posto_nome: p.nome, posto_cnpj: p.cnpj, cor, texto, logins: ult, ips, local: await semaforoLocal(env, p) });
  }
  return res;
}

/* Farol de localização: últimos 5 registros com localização (logins e envios) do posto */
async function semaforoLocal(env, p) {
  if (!p.usa_local) return { cor: "cinza", texto: "Posto sem controle de localização", registros: [] };
  const local = temLocalCadastrado(p) ? { lat: p.lat, lng: p.lng } : null;
  const regs = (await env.DB.prepare(`SELECT * FROM (
      SELECT 'login' AS origem, lat, lng, precisao, dist_m, criado_em FROM acessos WHERE posto_id = ? AND lat IS NOT NULL
      UNION ALL SELECT 'envio' AS origem, lat, lng, precisao, dist_m, recebido_em AS criado_em FROM fotos WHERE posto_id = ? AND lat IS NOT NULL
    ) ORDER BY criado_em DESC LIMIT ?`).bind(p.id, p.id, JANELA_IP).all()).results
    .map(r => ({ origem: r.origem, lat: r.lat, lng: r.lng, precisao: r.precisao, dist_m: r.dist_m, quando: brasilia(Date.parse(r.criado_em)).texto }));
  const base = { registros: regs, lat: p.lat, lng: p.lng };
  if (!local) return { ...base, cor: "cinza", texto: "Localização do posto não cadastrada" };
  if (!regs.length) return { ...base, cor: "cinza", texto: "Nenhum registro com localização ainda" };
  const longe = regs.filter(r => r.dist_m != null && r.dist_m > RAIO_LOCAL_M);
  if (longe.length) return { ...base, cor: "vermelho", texto: `${longe.length} de ${regs.length} registros a mais de ${RAIO_LOCAL_M} m do posto (maior: ${fmtDist(Math.max(...longe.map(r => r.dist_m)))})` };
  return { ...base, cor: "verde", texto: `Últimos ${regs.length} registros dentro de ${RAIO_LOCAL_M} m do posto` };
}

/* Registra cada login do posto e alerta quando o IP é diferente do login anterior (sem bloquear) */
async function registrarAcesso(env, request, p, local) {
  const ip = ipCliente(request);
  const distM = local && temLocalCadastrado(p) ? distanciaM(local, p) : null;
  const anterior = await env.DB.prepare("SELECT ip FROM acessos WHERE posto_id = ? AND ip IS NOT NULL AND ip <> '' AND criado_em >= ? ORDER BY id DESC LIMIT 1").bind(p.id, await ipRealDesde(env)).first();
  await env.DB.prepare("INSERT INTO acessos (posto_id, ip, navegador, cnpj_na_epoca, criado_em, lat, lng, precisao, dist_m) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(p.id, ip, corta(request.headers.get("user-agent"), 200), p.cnpj, agoraISO(), local ? local.lat : null, local ? local.lng : null, local ? local.precisao : null, distM).run();
  if (distM != null && distM > RAIO_LOCAL_M)
    await registrarAlerta(env, p.id, { tipo: "local_login", ip, local, distM, origem: "login",
      detalhe: `Login aceito a ${fmtDist(distM)} do local cadastrado do posto${local.precisao != null ? ` (precisão informada pelo navegador: ±${fmtDist(local.precisao)})` : ""}.` });
  if (anterior && anterior.ip !== ip)
    await registrarAlerta(env, p.id, { tipo: "ip_login", ip, ipAnterior: anterior.ip, origem: "login", detalhe: "Login aceito; IP diferente do login anterior." });
}

/* ---------- rotas ---------- */
async function api(request, env, url) {
  await preparar(env);
  const metodo = request.method, caminho = url.pathname;

  // proteção contra envio de formulário de outro site
  if (metodo !== "GET" && request.headers.get("x-requested-with") !== "fetch") return erro("Requisição recusada.", 403);

  if (caminho === "/api/time" && metodo === "GET") return json({ agora: agoraISO() });

  if (caminho === "/api/login" && metodo === "POST") {
    const { usuario = "", senha = "", local: localBruto = null } = await request.json().catch(() => ({}));
    await new Promise(r => setTimeout(r, 300)); // freio simples contra tentativas em sequência
    const u = String(usuario).trim();
    // identifica a conta; o bloqueio vale por conta (admin: por conta + IP, já que ninguém pode desbloqueá-lo)
    let conta = null;
    if (u.toLowerCase() === "admin") conta = { tipo: "admin", chave: "admin:" + ipCliente(request), nome: "Administrador (admin)" };
    else {
      const usr = await env.DB.prepare("SELECT * FROM usuarios WHERE usuario = ?").bind(u.toLowerCase()).first();
      if (usr) conta = { tipo: "matriz", chave: "u:" + usr.id, nome: `Usuário da matriz ${usr.nome} (${usr.usuario})`, usr };
      else {
        const cnpj = normCNPJ(u);
        if (!validCNPJ(cnpj)) return erro("Usuário ou senha incorretos.", 401);
        const p = await env.DB.prepare("SELECT * FROM postos WHERE cnpj = ?").bind(cnpj).first();
        if (!p) return erro("CNPJ ou senha incorretos. Se esqueceu a senha, fale com a matriz.", 401);
        conta = { tipo: "posto", chave: "p:" + p.id, nome: `Posto ${p.nome} (${p.cnpj})`, postoId: p.id, p };
      }
    }
    const bl = await bloqueioAtivo(env, conta.chave);
    if (bl) return erro(msgBloqueio(bl.bloqueado_ate, conta.tipo === "admin"), 423);
    let certa = false;
    if (conta.tipo === "admin") certa = iguais(String(senha), env.ADMIN_PASSWORD || "admin");
    else if (conta.tipo === "matriz") certa = !!conta.usr.ativo && iguais(await hashSenha(String(senha), conta.usr.salt), conta.usr.senha_hash);
    else certa = iguais(await hashSenha(String(senha), conta.p.salt), conta.p.senha_hash);
    if (!certa) {
      const r = await senhaErrada(env, request, conta.chave, conta);
      if (r.bloqueadoAte) return erro(msgBloqueio(r.bloqueadoAte, conta.tipo === "admin"), 423);
      const base = conta.tipo === "posto" ? "CNPJ ou senha incorretos." : "Usuário ou senha incorretos.";
      return erro(`${base} ${r.restantes === 1 ? "Resta 1 tentativa" : `Restam ${r.restantes} tentativas`} antes do bloqueio.`, 401);
    }
    await env.DB.prepare("UPDATE bloqueios SET falhas = 0 WHERE chave = ?").bind(conta.chave).run();
    if (conta.tipo === "admin") {
      const s = { admin: true };
      await registrar(env, s, request, "login_admin", ACOES.login_admin);
      return json({ papel: "admin" }, 200, { "set-cookie": await criarSessao(env, { r: "admin", v: await versaoAdmin(env) }) });
    }
    if (conta.tipo === "matriz") {
      const s = { matriz: true, uid: conta.usr.id, nome: conta.usr.nome, usuario: conta.usr.usuario };
      await registrar(env, s, request, "login_matriz", ACOES.login_matriz);
      return json({ papel: "matriz" }, 200, { "set-cookie": await criarSessao(env, { r: "consulta", uid: conta.usr.id, s: conta.usr.salt.slice(0, 12) }) });
    }
    // posto com controle de localização: só entra se o navegador mandar a localização
    const local = lerLocal(localBruto);
    if (conta.p.usa_local && !local)
      return erro("Para entrar, autorize o acesso à localização no navegador.", 428, { precisaLocal: true });
    await registrarAcesso(env, request, conta.p, local);
    return json({ papel: "posto" }, 200, { "set-cookie": await criarSessao(env, { r: "posto", pid: conta.p.id, s: conta.p.salt.slice(0, 12) }) });
  }

  if (caminho === "/api/logout" && metodo === "POST") return json({ ok: true }, 200, { "set-cookie": apagarSessao });

  const s = await lerSessao(request, env);
  if (!s) return erro("Sessão expirada. Entre de novo.", 401);

  if (caminho === "/api/me" && metodo === "GET") {
    if (s.matriz) return json({ papel: s.papel, nome: s.nome, usuario: s.usuario, perms: s.perms, senhaPadrao: s.admin ? !env.ADMIN_PASSWORD : false });
    return json({ papel: "posto", posto: s.posto });
  }
  if (caminho === "/api/ip" && metodo === "GET") return json({ ip: ipCliente(request) });
  if (caminho === "/api/nota-enviada" && metodo === "GET") {
    if (!s.posto) return erro("Só o acesso do posto.", 403);
    const f = await notaJaEnviada(env, s.posto.id, url.searchParams.get("nota") || "", null);
    return json(f ? { enviada: true, mensagem: msgNotaRepetida(f) } : { enviada: false });
  }

  /* ----- fotos ----- */
  if (caminho === "/api/fotos" && metodo === "POST") {
    if (!s.posto) return erro("Só o acesso do posto envia fotos.", 403);
    return await receberFoto(request, env, s.posto);
  }
  if (caminho === "/api/fotos" && metodo === "GET") {
    if (url.searchParams.get("relatorio") === "1") {
      if (!pode(s, "baixar")) return erro("Seu usuário não tem permissão para gerar relatórios.", 403);
      const resp = await listarFotos(env, s, url.searchParams);
      const dados = await resp.clone().json();
      const filtros = ["posto", "cli", "tipo", "de", "ate", "q"].filter(k => url.searchParams.get(k)).map(k => `${k}=${url.searchParams.get(k)}`).join(", ");
      await registrar(env, s, request, "gerou_excel", `Gerou relatório Excel com ${dados.fotos.length} registro(s)${filtros ? " (filtros: " + filtros + ")" : " (sem filtros)"}`);
      return resp;
    }
    return await listarFotos(env, s, url.searchParams);
  }
  if (caminho === "/api/opcoes" && metodo === "GET") return await opcoes(env, s);

  let m = caminho.match(/^\/api\/fotos\/(\d+)\/mini$/);
  if (m && metodo === "GET") {
    // miniatura borrada: é a única imagem que o posto vê depois do envio
    const f = await env.DB.prepare("SELECT posto_id, chave_mini FROM fotos WHERE id = ?").bind(+m[1]).first();
    if (!f || !f.chave_mini || (s.posto && f.posto_id !== s.posto.id)) return erro("Miniatura não encontrada.", 404);
    return await entregarArquivo(env, f.chave_mini, "miniatura.jpg", false, false, { semCache: true });
  }

  m = caminho.match(/^\/api\/fotos\/(\d+)\/(foto|nf)$/);
  if (m && metodo === "GET") {
    const f = await env.DB.prepare("SELECT f.*, p.nome AS posto_nome FROM fotos f LEFT JOIN postos p ON p.id = f.posto_id WHERE f.id = ?").bind(+m[1]).first();
    if (!f || (s.posto && f.posto_id !== s.posto.id)) return erro("Foto não encontrada.", 404);
    if (s.posto) {
      // LGPD: depois do envio o posto não acessa a foto nem a nota; vê só a miniatura borrada
      return erro("A foto original só pode ser acessada pela matriz.", 403);
    }
    const baixar = url.searchParams.get("download") === "1" || m[2] === "nf";
    if (baixar) {
      if (!pode(s, "baixar")) return erro("Seu usuário não tem permissão para baixar arquivos.", 403);
      const lote = corta(url.searchParams.get("lote"), 40);
      const nome = m[2] === "nf" ? f.arquivo_nf : f.arquivo;
      if (lote) await registrar(env, s, request, "baixou_zip", "Baixou .zip com {n} arquivo(s)", { lote });
      else await registrar(env, s, request, m[2] === "nf" ? "baixou_nf" : "baixou_foto", `${m[2] === "nf" ? "Baixou a nota" : "Baixou a foto"} ${nome} (posto ${f.posto_nome || f.posto_id}, nota ${f.nota})`, { alvo: "foto:" + f.id });
    }
    return await entregarArquivo(env, m[2] === "nf" ? f.chave_nf : f.chave_foto, m[2] === "nf" ? f.arquivo_nf : f.arquivo, m[2] === "nf", baixar);
  }

  /* ----- alertas ----- */
  if (caminho === "/api/alertas" && metodo === "POST") {
    if (!s.posto) return erro("Só o acesso do posto registra alertas.", 403);
    return await receberAlerta(request, env, s.posto);
  }
  if (caminho.startsWith("/api/alertas") && !pode(s, "alertas")) return erro("Seu usuário não tem permissão para ver alertas.", 403);
  if (caminho === "/api/alertas" && metodo === "GET") {
    const todos = url.searchParams.get("todos") === "1";
    const r = await env.DB.prepare(`SELECT a.*, p.nome AS posto_nome, p.cnpj AS posto_cnpj FROM alertas a
      LEFT JOIN postos p ON p.id = a.posto_id ${todos ? "" : "WHERE a.visto = 0"} ORDER BY a.criado_em DESC LIMIT 300`).all();
    const abertos = await env.DB.prepare("SELECT COUNT(*) AS n FROM alertas WHERE visto = 0").first();
    const alertas = r.results.map(a => ({ ...a, tipo_txt: TIPOS_ALERTA[a.tipo] || a.tipo, tem_foto: !!a.chave_foto, tem_nf: !!a.chave_nf, chave_foto: undefined, chave_nf: undefined }));
    return json({ alertas, abertos: abertos.n, semaforo: await semaforoIP(env), podeMarcar: true, podeBaixar: pode(s, "baixar") });
  }
  m = caminho.match(/^\/api\/alertas\/(\d+)\/(foto|nf)$/);
  if (m && metodo === "GET") {
    const a = await env.DB.prepare("SELECT * FROM alertas WHERE id = ?").bind(+m[1]).first();
    const chave = a && (m[2] === "nf" ? a.chave_nf : a.chave_foto);
    if (!chave) return erro("Este alerta não tem arquivo guardado.", 404);
    const nome = `alerta-${a.id}_nota-${(a.nota || "sem-numero").replace(/[^\w.-]+/g, "-")}.${m[2] === "nf" ? "pdf" : "jpg"}`;
    const baixar = url.searchParams.get("download") === "1" || m[2] === "nf";
    if (baixar) {
      if (!pode(s, "baixar")) return erro("Seu usuário não tem permissão para baixar arquivos.", 403);
      await registrar(env, s, request, m[2] === "nf" ? "baixou_alerta_nf" : "baixou_alerta_foto", `Baixou ${m[2] === "nf" ? "a nota" : "a foto"} do alerta ${a.id} (nota ${a.nota || "?"})`, { alvo: "alerta:" + a.id });
    }
    return await entregarArquivo(env, chave, nome, m[2] === "nf", baixar);
  }
  m = caminho.match(/^\/api\/alertas\/(\d+)$/);
  if (m && metodo === "PUT") {
    const a = await env.DB.prepare("SELECT a.*, p.nome AS posto_nome FROM alertas a LEFT JOIN postos p ON p.id = a.posto_id WHERE a.id = ?").bind(+m[1]).first();
    if (!a) return erro("Alerta não encontrado.", 404);
    await env.DB.prepare("UPDATE alertas SET visto = 1, visto_em = ? WHERE id = ?").bind(agoraISO(), a.id).run();
    await registrar(env, s, request, "alerta_visto", `Marcou como visto o alerta ${a.id} (${TIPOS_ALERTA[a.tipo] || a.tipo}, ${a.posto_nome || "matriz"})`, { alvo: "alerta:" + a.id });
    return json({ ok: true });
  }

  /* ----- registro de ações (só o admin) ----- */
  if (caminho === "/api/registros" && metodo === "GET") {
    if (!s.admin) return erro("Só o administrador vê o registro de ações.", 403);
    const q = url.searchParams, onde = [], args = [];
    const quem = q.get("quem") || "";
    if (quem === "admin") onde.push("ator_tipo = 'admin'");
    else if (quem === "postos") onde.push("ator_tipo = 'posto'");
    else if (quem === "matriz") onde.push("ator_tipo = 'matriz'");
    else if (quem === "sistema") onde.push("ator_tipo = 'sistema'");
    else if (/^[up]:\d+$/.test(quem)) { onde.push("ator_tipo = ? AND ator_id = ?"); args.push(quem[0] === "u" ? "matriz" : "posto", +quem.slice(2)); }
    const GRUPOS = { downloads: ["baixou_foto", "baixou_nf", "baixou_alerta_foto", "baixou_alerta_nf", "baixou_zip", "gerou_excel"], alteracoes: ["posto_criado", "posto_editado", "posto_senha", "posto_desbloqueado", "usuario_criado", "usuario_editado", "usuario_senha", "usuario_desbloqueado", "alerta_visto"], acessos: ["login_matriz", "login_admin"], aberturas: ["posto_abriu_foto", "nota_repetida"], bloqueios: ["bloqueio"] };
    const g = GRUPOS[q.get("tipo") || ""]; if (g) { onde.push(`acao IN (${g.map(() => "?").join(",")})`); args.push(...g); }
    if (q.get("de")) { onde.push("dia >= ?"); args.push(q.get("de").slice(0, 10)); }
    if (q.get("ate")) { onde.push("dia <= ?"); args.push(q.get("ate").slice(0, 10)); }
    const where = onde.length ? "WHERE " + onde.join(" AND ") : "";
    const total = await env.DB.prepare(`SELECT COUNT(*) AS n FROM registros ${where}`).bind(...args).first();
    const r = await env.DB.prepare(`SELECT * FROM registros ${where} ORDER BY id DESC LIMIT ${Math.min(2000, Math.max(1, +q.get("limite") || 500))}`).bind(...args).all();
    const usuarios = (await env.DB.prepare("SELECT id, usuario, nome FROM usuarios ORDER BY nome COLLATE NOCASE").all()).results;
    const postos = (await env.DB.prepare("SELECT id, nome, cnpj FROM postos ORDER BY nome COLLATE NOCASE").all()).results;
    return json({ registros: r.results.map(x => ({ ...x, quando: brasilia(Date.parse(x.criado_em)).texto, acao_txt: ACOES[x.acao] || x.acao })), total: total.n, usuarios, postos });
  }

  /* ----- usuários da matriz (admin ou quem tem o poder "usuarios") ----- */
  if (caminho.startsWith("/api/usuarios")) {
    if (!pode(s, "usuarios")) return erro("Seu usuário não tem permissão para alterar usuários da matriz.", 403);
    const lerPoderes = (corpo) => {
      const p = {}; for (const k of Object.keys(PODERES)) p[k] = !!(corpo.perms && corpo.perms[k]);
      // ninguém concede um poder que não tem (o admin tem todos)
      for (const k of Object.keys(p)) if (p[k] && !pode(s, k)) throw new Erro(`Você não pode conceder o poder "${PODERES[k]}", porque não o tem.`, 403);
      return p;
    };
    const txtPoderes = p => { const l = Object.keys(PODERES).filter(k => p[k]).map(k => PODERES[k]); return l.length ? l.join("; ") : "somente visualizar"; };
    if (caminho === "/api/usuarios" && metodo === "GET") {
      const r = await env.DB.prepare("SELECT id, usuario, nome, ativo, criado_em, atualizado_em, perm_baixar, perm_alertas, perm_postos, perm_usuarios FROM usuarios ORDER BY nome COLLATE NOCASE").all();
      const usuarios = [];
      for (const u of r.results) { const b = await bloqueioAtivo(env, "u:" + u.id); usuarios.push({ id: u.id, usuario: u.usuario, nome: u.nome, ativo: u.ativo, criado_em: u.criado_em, perms: poderesDe(u), bloqueado_ate: b ? b.bloqueado_ate : null, bloqueado_ate_txt: b ? brasilia(Date.parse(b.bloqueado_ate)).texto : null, eu: !s.admin && u.id === s.uid }); }
      return json({ usuarios, poderes: PODERES, meusPoderes: s.perms });
    }
    if (caminho === "/api/usuarios" && metodo === "POST") {
      const corpo = await request.json().catch(() => ({}));
      const u = String(corpo.usuario || "").trim().toLowerCase(), n = String(corpo.nome || "").trim().slice(0, 60), senha = String(corpo.senha || "");
      if (!/^[a-z0-9._-]{3,30}$/.test(u)) return erro("Usuário: de 3 a 30 caracteres, só letras, números, ponto, hífen ou sublinhado.");
      if (u === "admin" || validCNPJ(u)) return erro("Esse nome de usuário não pode ser usado.");
      if (!n) return erro("Informe o nome da pessoa.");
      if (senha.length < 6) return erro("A senha precisa ter pelo menos 6 caracteres.");
      if (await env.DB.prepare("SELECT id FROM usuarios WHERE usuario = ?").bind(u).first()) return erro("Esse usuário já existe.");
      const p = lerPoderes(corpo), salt = aleatorio(16);
      await env.DB.prepare(`INSERT INTO usuarios (usuario, nome, senha_hash, salt, papel, ativo, criado_em, perm_baixar, perm_alertas, perm_postos, perm_usuarios)
        VALUES (?, ?, ?, ?, 'matriz', 1, ?, ?, ?, ?, ?)`).bind(u, n, await hashSenha(senha, salt), salt, agoraISO(), +p.baixar, +p.alertas, +p.postos, +p.usuarios).run();
      await registrar(env, s, request, "usuario_criado", `Criou o usuário ${n} (${u}) com os poderes: ${txtPoderes(p)}`, { alvo: "usuario:" + u });
      return json({ ok: true });
    }
    m = caminho.match(/^\/api\/usuarios\/(\d+)(\/senha|\/desbloquear)?$/);
    if (m && metodo === "PUT") {
      const usr = await env.DB.prepare("SELECT * FROM usuarios WHERE id = ?").bind(+m[1]).first();
      if (!usr) return erro("Usuário não encontrado.", 404);
      if (!s.admin && usr.id === s.uid) return erro("Peça a outro responsável ou ao administrador para alterar o seu próprio usuário.", 403);
      if (!s.admin && Object.keys(PODERES).some(k => usr["perm_" + k] && !pode(s, k))) return erro("Este usuário tem poderes que você não tem; só o administrador pode alterá-lo.", 403);
      const corpo = await request.json().catch(() => ({}));
      const quem = `${usr.nome} (${usr.usuario})`;
      if (m[2] === "/desbloquear") {
        await env.DB.prepare("UPDATE bloqueios SET falhas = 0, bloqueado_ate = NULL WHERE chave = ?").bind("u:" + usr.id).run();
        await registrar(env, s, request, "usuario_desbloqueado", `Desbloqueou o usuário ${quem}`, { alvo: "usuario:" + usr.usuario });
        return json({ ok: true });
      }
      if (m[2] === "/senha") {
        if (String(corpo.senha || "").length < 6) return erro("A senha precisa ter pelo menos 6 caracteres.");
        const salt = aleatorio(16);
        await env.DB.prepare("UPDATE usuarios SET senha_hash = ?, salt = ?, atualizado_em = ? WHERE id = ?").bind(await hashSenha(String(corpo.senha), salt), salt, agoraISO(), usr.id).run();
        await registrar(env, s, request, "usuario_senha", `Trocou a senha do usuário ${quem}`, { alvo: "usuario:" + usr.usuario });
        return json({ ok: true });
      }
      const n = String(corpo.nome || "").trim().slice(0, 60);
      if (!n) return erro("Informe o nome da pessoa.");
      const ativo = corpo.ativo === false ? 0 : 1;
      const p = corpo.perms ? lerPoderes(corpo) : poderesDe(usr);
      const antes = poderesDe(usr), mud = [];
      if (n !== usr.nome) mud.push(`nome "${usr.nome}" → "${n}"`);
      if (ativo !== usr.ativo) mud.push(ativo ? "reativado" : "desativado");
      for (const k of Object.keys(PODERES)) if (antes[k] !== p[k]) mud.push(`${p[k] ? "ganhou" : "perdeu"} o poder "${PODERES[k]}"`);
      // desativar no lugar de excluir: o histórico continua intacto
      await env.DB.prepare("UPDATE usuarios SET nome = ?, ativo = ?, perm_baixar = ?, perm_alertas = ?, perm_postos = ?, perm_usuarios = ?, atualizado_em = ? WHERE id = ?")
        .bind(n, ativo, +p.baixar, +p.alertas, +p.postos, +p.usuarios, agoraISO(), usr.id).run();
      if (mud.length) await registrar(env, s, request, "usuario_editado", `Alterou o usuário ${quem}: ${mud.join("; ")}`, { alvo: "usuario:" + usr.usuario });
      return json({ ok: true });
    }
    return erro("Rota não encontrada.", 404);
  }

  /* ----- postos (ver: toda a matriz; alterar: admin ou quem tem o poder "postos") ----- */
  if (caminho === "/api/postos" && metodo === "GET") {
    if (!s.matriz) return erro("Acesso só da matriz.", 403);
    const r = await env.DB.prepare(`SELECT p.id, p.cnpj, p.nome, p.criado_em, p.atualizado_em, p.lat, p.lng, p.usa_local,
      (SELECT COUNT(*) FROM fotos f WHERE f.posto_id = p.id) AS fotos,
      (SELECT COUNT(*) FROM alertas a WHERE a.posto_id = p.id AND a.visto = 0) AS alertas,
      (SELECT ip FROM acessos x WHERE x.posto_id = p.id ORDER BY x.id DESC LIMIT 1) AS ultimo_ip,
      (SELECT criado_em FROM acessos x WHERE x.posto_id = p.id ORDER BY x.id DESC LIMIT 1) AS ultimo_login
      FROM postos p ORDER BY p.nome COLLATE NOCASE`).all();
    const postos = [];
    for (const p of r.results) {
      const b = await bloqueioAtivo(env, "p:" + p.id);
      postos.push({ ...p, ultimo_login_txt: p.ultimo_login ? brasilia(Date.parse(p.ultimo_login)).texto : null, bloqueado_ate: b ? b.bloqueado_ate : null, bloqueado_ate_txt: b ? brasilia(Date.parse(b.bloqueado_ate)).texto : null });
    }
    return json({ postos, podeAlterar: pode(s, "postos") });
  }
  if (caminho.startsWith("/api/postos") && !pode(s, "postos")) return erro("Seu usuário não tem permissão para alterar postos.", 403);
  if (caminho === "/api/postos" && metodo === "POST") {
    const corpo = await request.json().catch(() => ({}));
    const { cnpj: c = "", nome = "", senha = "" } = corpo;
    const cnpj = normCNPJ(c), n = String(nome).trim().slice(0, 60);
    if (!validCNPJ(cnpj)) return erro("CNPJ inválido. Confira os dígitos.");
    if (!n) return erro("Informe o nome do posto.");
    if (String(senha).length < 4) return erro("A senha precisa ter pelo menos 4 caracteres.");
    const loc = localDoCadastro(corpo); if (loc.erro) return erro(loc.erro);
    if (await env.DB.prepare("SELECT id FROM postos WHERE cnpj = ?").bind(cnpj).first()) return erro("Este CNPJ já está cadastrado.");
    const salt = aleatorio(16);
    await env.DB.prepare("INSERT INTO postos (cnpj, nome, senha_hash, salt, criado_em, lat, lng, usa_local) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(cnpj, n, await hashSenha(String(senha), salt), salt, agoraISO(), loc.lat, loc.lng, loc.usa).run();
    await registrar(env, s, request, "posto_criado", `Cadastrou o posto ${n} (CNPJ ${cnpj})${loc.lat != null ? `, local ${loc.lat}, ${loc.lng}` : ""}, controle de localização ${loc.usa ? "ligado" : "desligado"}`, { alvo: "posto:" + cnpj });
    return json({ ok: true });
  }
  m = caminho.match(/^\/api\/postos\/(\d+)(\/senha|\/desbloquear)?$/);
  if (m && metodo === "PUT") {
    const id = +m[1];
    const p = await env.DB.prepare("SELECT id, cnpj, nome, lat, lng, usa_local FROM postos WHERE id = ?").bind(id).first();
    if (!p) return erro("Posto não encontrado.", 404);
    const corpo = await request.json().catch(() => ({}));
    if (m[2] === "/desbloquear") {
      await env.DB.prepare("UPDATE bloqueios SET falhas = 0, bloqueado_ate = NULL WHERE chave = ?").bind("p:" + id).run();
      await registrar(env, s, request, "posto_desbloqueado", `Desbloqueou o posto ${p.nome} (CNPJ ${p.cnpj})`, { alvo: "posto:" + p.cnpj });
      return json({ ok: true });
    }
    if (m[2] === "/senha") {
      if (String(corpo.senha || "").length < 4) return erro("A senha precisa ter pelo menos 4 caracteres.");
      const salt = aleatorio(16);
      await env.DB.prepare("UPDATE postos SET senha_hash = ?, salt = ?, atualizado_em = ? WHERE id = ?")
        .bind(await hashSenha(String(corpo.senha), salt), salt, agoraISO(), id).run();
      await registrar(env, s, request, "posto_senha", `Trocou a senha do posto ${p.nome} (CNPJ ${p.cnpj})`, { alvo: "posto:" + p.cnpj });
      return json({ ok: true });
    }
    // edição: o posto mantém o mesmo id, então fotos e alertas continuam vinculados a ele
    const cnpj = normCNPJ(corpo.cnpj), n = String(corpo.nome || "").trim().slice(0, 60);
    if (!validCNPJ(cnpj)) return erro("CNPJ inválido. Confira os dígitos.");
    if (!n) return erro("Informe o nome do posto.");
    const outro = await env.DB.prepare("SELECT id FROM postos WHERE cnpj = ? AND id <> ?").bind(cnpj, id).first();
    if (outro) return erro("Já existe outro posto com este CNPJ.");
    // localização: só muda se a tela mandou os campos (versões antigas da tela não mandam)
    const temLoc = "lat" in corpo || "lng" in corpo || "usa_local" in corpo;
    const loc = temLoc ? localDoCadastro(corpo) : { lat: p.lat, lng: p.lng, usa: p.usa_local ? 1 : 0 };
    if (loc.erro) return erro(loc.erro);
    await env.DB.prepare("UPDATE postos SET cnpj = ?, nome = ?, lat = ?, lng = ?, usa_local = ?, atualizado_em = ? WHERE id = ?").bind(cnpj, n, loc.lat, loc.lng, loc.usa, agoraISO(), id).run();
    const mud = []; if (cnpj !== p.cnpj) mud.push(`CNPJ ${p.cnpj} → ${cnpj}`); if (n !== p.nome) mud.push(`nome "${p.nome}" → "${n}"`);
    const txtLoc = (a, b) => a == null ? "sem local" : `${a}, ${b}`;
    if (loc.lat !== p.lat || loc.lng !== p.lng) mud.push(`local ${txtLoc(p.lat, p.lng)} → ${txtLoc(loc.lat, loc.lng)}`);
    if (!!loc.usa !== !!p.usa_local) mud.push(`controle de localização ${loc.usa ? "ligado" : "desligado"}`);
    if (mud.length) await registrar(env, s, request, "posto_editado", `Editou o posto ${p.nome}: ${mud.join("; ")}`, { alvo: "posto:" + cnpj });
    return json({ ok: true });
  }

  return erro("Rota não encontrada.", 404);
}

/* latitude/longitude do cadastro do posto (aceita vírgula decimal) e caixa "usa localização" */
function localDoCadastro(c) {
  const num = v => v == null || String(v).trim() === "" ? null : +String(v).trim().replace(",", ".");
  const lat = num(c.lat), lng = num(c.lng), usa = c.usa_local ? 1 : 0;
  if ((lat == null) !== (lng == null)) return { erro: "Informe latitude e longitude juntas." };
  if (lat != null && (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180)) return { erro: "Latitude ou longitude inválida. Exemplo: -23.550520 e -46.633308." };
  if (usa && lat == null) return { erro: "Para usar o controle de localização, informe a latitude e a longitude do posto." };
  return { lat: lat == null ? null : Math.round(lat * 1e6) / 1e6, lng: lng == null ? null : Math.round(lng * 1e6) / 1e6, usa };
}

async function entregarArquivo(env, chave, nome, ehPdf, baixar, opc = {}) {
  const obj = await env.FILES.get(chave);
  if (!obj) return erro("Arquivo não encontrado no armazenamento.", 404);
  return new Response(obj.body, { headers: {
    "content-type": ehPdf ? "application/pdf" : "image/jpeg",
    "cache-control": opc.semCache ? "no-store" : "private, max-age=3600",
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
/* nota única por posto: depois de um envio aceito, o mesmo número (ou a mesma chave de acesso) não entra de novo */
async function notaJaEnviada(env, postoId, nota, chave) {
  const n = numInt(nota);
  if (!n && !chave) return null;
  return await env.DB.prepare(`SELECT id, nota, capturado_txt FROM fotos WHERE posto_id = ?
      AND ((? <> '' AND (ltrim(nota, '0') = ? OR ltrim(COALESCE(nf_numero, ''), '0') = ?)) OR (? <> '' AND nf_chave = ?))
      ORDER BY id LIMIT 1`).bind(postoId, n, n, n, chave || "", chave || "").first();
}
const msgNotaRepetida = f => `A nota ${f.nota} já foi enviada em ${f.capturado_txt}. Cada nota só pode ser enviada uma vez. Se precisar corrigir, fale com a matriz.`;

async function receberFoto(request, env, posto) {
  let form; try { form = await request.formData(); } catch { return erro("Envio inválido."); }
  const foto = form.get("foto"), nf = form.get("nf"), mini = form.get("mini");
  let m; try { m = JSON.parse(form.get("meta") || "{}"); } catch { return erro("Dados do envio inválidos."); }

  const cliente = String(m.cliente || "").trim().slice(0, 60);
  const nota = String(m.nota || "").trim().slice(0, 20);
  const destNome = String(m.destNome || "").trim().slice(0, 100);
  const destDoc = soDig(m.destDoc);
  if (!cliente) return erro("Informe o cliente/motorista.");
  if (!nota || !numInt(nota)) return erro("Informe o número da nota.");
  const repetida = await notaJaEnviada(env, posto.id, nota, null);
  if (repetida) {
    await registrar(env, { posto }, request, "nota_repetida", `Tentou enviar de novo a nota ${nota} (já enviada em ${repetida.capturado_txt})`, { alvo: "foto:" + repetida.id, dedupSeg: 60 });
    return erro(msgNotaRepetida(repetida), 409, { notaRepetida: true });
  }
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
  // localização do envio (obrigatória para posto com controle de localização)
  const cad = await env.DB.prepare("SELECT lat, lng, usa_local FROM postos WHERE id = ?").bind(posto.id).first() || {};
  const local = lerLocal(m.local);
  if (cad.usa_local && !local) return erro("Não foi possível obter a localização. Autorize a localização no navegador e tire a foto de novo.", 422);
  const distM = local && temLocalCadastrado(cad) ? distanciaM(local, cad) : null;
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
  const ultimoLogin = await env.DB.prepare("SELECT ip FROM acessos WHERE posto_id = ? AND criado_em >= ? ORDER BY id DESC LIMIT 1").bind(posto.id, await ipRealDesde(env)).first();
  if (ultimoLogin && ultimoLogin.ip && ultimoLogin.ip !== ip) divergencias.push(`IP do envio ${ip} diferente do IP do login ${ultimoLogin.ip}`);

  if (lido && lido.chave) {
    const mesmaChave = await notaJaEnviada(env, posto.id, "", lido.chave);
    if (mesmaChave) return erro(msgNotaRepetida(mesmaChave), 409, { notaRepetida: true });
  }
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

  // confere de novo logo antes de gravar (dois envios ao mesmo tempo)
  const corrida = await notaJaEnviada(env, posto.id, nota, lido && lido.chave);
  if (corrida) return erro(msgNotaRepetida(corrida), 409, { notaRepetida: true });

  const id = crypto.randomUUID();
  const chaveFoto = `postos/${posto.id}/${id}.jpg`, chaveNf = `postos/${posto.id}/${id}.pdf`;
  await env.FILES.put(chaveFoto, bytesFoto, { httpMetadata: { contentType: "image/jpeg" } });
  await env.FILES.put(chaveNf, bytesNf, { httpMetadata: { contentType: "application/pdf" } });
  // miniatura borrada (opcional): JPEG pequeno gerado na captura
  let chaveMini = null;
  if (mini instanceof File && mini.size && mini.size <= MAX_MINI) {
    const bm = new Uint8Array(await mini.arrayBuffer());
    if (bm[0] === 0xFF && bm[1] === 0xD8 && bm[2] === 0xFF) {
      chaveMini = `postos/${posto.id}/${id}_mini.jpg`;
      await env.FILES.put(chaveMini, bm, { httpMetadata: { contentType: "image/jpeg" } });
    }
  }

  const tipo = destDoc.length === 14 ? "PJ" : destDoc.length === 11 ? "PF" : "NI";
  await env.DB.prepare(`INSERT INTO fotos (posto_id, cliente, nota, arquivo, arquivo_nf, chave_foto, chave_nf, capturado_em, capturado_txt, cap_dia, recebido_em,
      dest_nome, dest_doc, dest_tipo, dest_origem, nf_numero, nf_serie, nf_modelo, nf_cnpj_emit, nf_emissao, nf_emissao_fonte, dif_min, cnpj_na_epoca, nome_na_epoca,
      ip, ip_carimbo, hash_foto, hash_nf, verif_servidor, nf_chave, divergencia, dest_nome_pdf, dest_doc_pdf, chave_mini, lat, lng, precisao, dist_m)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
    posto.id, cliente, nota, arquivo, arquivoNf, chaveFoto, chaveNf, new Date(cap).toISOString(), capBR.texto, capBR.dia, agoraISO(),
    destNome, destDoc || null, tipo, m.destOrigem === "editado à mão" ? "editado à mão" : "lido do PDF",
    numeroNota, corta(lido ? lido.serie : n.serie, 5), corta(lido ? lido.modelo : n.modelo, 10),
    (lido ? lido.cnpjEmit : n.cnpjEmit) ? normCNPJ(lido ? lido.cnpjEmit : n.cnpjEmit) : null, emissaoTxt, corta(emissao.fonte, 60),
    Math.round(dif * 10) / 10, posto.cnpj, posto.nome,
    ip, ipCarimbo, hashFoto, hashNf, verif, lido && lido.chave ? lido.chave : null, divergencias.length ? divergencias.join("; ").slice(0, 500) : null,
    lido && lido.dest ? corta(lido.dest.nome, 100) : null, lido && lido.dest ? corta(lido.dest.doc, 14) : null, chaveMini,
    local ? local.lat : null, local ? local.lng : null, local ? local.precisao : null, distM).run();

  // envio aceito, mas feito longe do local cadastrado do posto: alerta para a matriz
  if (distM != null && distM > RAIO_LOCAL_M)
    await registrarAlerta(env, posto.id, { tipo: "local_envio", nota, cliente, fotoEm: capBR.texto, ip, local, distM, origem: "servidor",
      detalhe: `Envio aceito a ${fmtDist(distM)} do local cadastrado do posto${local.precisao != null ? ` (precisão informada pelo navegador: ±${fmtDist(local.precisao)})` : ""}. Arquivo ${arquivo}.` });

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
      f.ip, f.ip_carimbo, f.hash_foto, f.hash_nf, f.verif_servidor, f.divergencia, (f.chave_mini IS NOT NULL) AS tem_mini, f.lat, f.lng, f.precisao, f.dist_m,
      p.nome AS posto_nome, p.cnpj AS posto_cnpj
      FROM fotos f LEFT JOIN postos p ON p.id = f.posto_id ${where} ORDER BY f.capturado_em DESC LIMIT ${limite}`).bind(...args).all();
  const ocultarDoPosto = ["arquivo_nf", "ip", "ip_carimbo", "hash_foto", "hash_nf", "verif_servidor", "divergencia", "nf_chave", "nf_cnpj_emit", "recebido_em", "lat", "lng", "precisao", "dist_m"];
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
async function status(env, request) {
  const o = origemIP(request, limpaIP);
  const r = { ip_desta_conexao: `${o.ip} (fonte: ${o.fonte})`, cabecalho_x_forwarded_for: o.xff || "(vazio)", cabecalho_x_real_ip: o.xRealIp || "(vazio)", servidor: "ok", armazenamento: env.ARMAZENAMENTO || "", banco_DB: "", arquivos_FILES: "", leitor_pdf_servidor: typeof env.lerPDF === "function" && env.LeituraNF ? "ok" : "indisponível", senha_admin: env.ADMIN_PASSWORD ? "definida (ADMIN_PASSWORD)" : "padrão (admin)", hora_servidor: agoraISO() };
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
    if (url.pathname.startsWith("/api/")) {
      try {
        if (url.pathname === "/api/status") {
          // diagnóstico só para o administrador logado
          await preparar(env);
          const s = await lerSessao(request, env);
          if (!s || !s.admin) return erro("Acesso só do administrador.", 403);
          return await status(env, request);
        }
        return await api(request, env, url);
      } catch (e) {
        if (e instanceof Erro && e.status < 500) return erro(e.message, e.status, e.extra);
        // detalhes técnicos só no log do servidor; o usuário vê uma mensagem simples com um código
        const codigo = aleatorio(3).toUpperCase();
        console.error(`[erro ${codigo}]`, e);
        return erro(`Não foi possível concluir agora. Tente de novo em instantes. Se continuar, informe o código ${codigo} à matriz.`, 500);
      }
    }
    if (BLOQUEADOS.test(url.pathname)) return new Response("Não encontrado", { status: 404 });
    const resp = await env.ASSETS.fetch(request);
    const r = new Response(resp.body, resp);
    r.headers.set("x-content-type-options", "nosniff");
    r.headers.set("referrer-policy", "same-origin");
    r.headers.set("permissions-policy", "camera=(self), microphone=(), geolocation=(self)");
    r.headers.set("x-frame-options", "DENY");
    return r;
  }
};
