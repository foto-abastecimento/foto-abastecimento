/*
 * Foto Abastecimento — lógica do servidor (usada pelo server.js no Railway).
 * Recebe do server.js: DB (banco SQLite), FILES (pasta de arquivos) e ASSETS (telas).
 * Variável opcional: ADMIN_PASSWORD -> senha do usuário "admin".
 * Sem ADMIN_PASSWORD a senha do admin é "admin" e o portal mostra um aviso.
 */

const LIMITE_NOTA_MIN = 10;      // diferença máxima entre emissão da nota e foto
const LIMITE_ENVIO_MIN = 20;     // diferença máxima entre a foto e a chegada no servidor
const MAX_FOTO = 8 * 1024 * 1024;
const MAX_PDF = 10 * 1024 * 1024;
const SESSAO_HORAS = 12;
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

/* ---------- banco: criação automática das tabelas ---------- */
let preparo = null;
function preparar(env) {
  if (!env.DB || typeof env.DB.prepare !== "function") throw new Erro("O banco D1 não está ligado ao projeto (ligação com o nome DB). Confira a configuração do servidor.", 500);
  if (!env.FILES || typeof env.FILES.put !== "function") throw new Erro("O bucket R2 não está ligado ao projeto (ligação com o nome FILES). Confira a configuração do servidor.", 500);
  if (!preparo) {
    preparo = env.DB.batch([
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
      env.DB.prepare(`CREATE INDEX IF NOT EXISTS ix_alertas ON alertas(visto, criado_em)`)
    ]).catch(e => { preparo = null; throw e; });
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
  if (d.r === "admin") return iguais(d.v || "", await versaoAdmin(env)) ? { admin: true } : null;
  if (d.r === "posto") {
    const p = await env.DB.prepare("SELECT id, cnpj, nome, salt FROM postos WHERE id = ?").bind(d.pid).first();
    // senha alterada pela matriz derruba as sessões antigas
    if (!p || !iguais(p.salt.slice(0, 12), d.s || "")) return null;
    return { posto: { id: p.id, cnpj: p.cnpj, nome: p.nome } };
  }
  return null;
}

/* ---------- alertas ---------- */
const TIPOS_ALERTA = { atraso: "Nota fora do horário", horario_nao_lido: "Horário da nota não lido" };
async function registrarAlerta(env, postoId, a) {
  if (!TIPOS_ALERTA[a.tipo]) return;
  // evita repetir o mesmo alerta (mesmo posto, nota e tipo) em 30 minutos
  const limite = new Date(Date.now() - 30 * 60e3).toISOString();
  const ja = await env.DB.prepare("SELECT id FROM alertas WHERE posto_id = ? AND tipo = ? AND nota = ? AND criado_em > ?")
    .bind(postoId, a.tipo, String(a.nota || "").slice(0, 20), limite).first();
  if (ja) return;
  await env.DB.prepare(`INSERT INTO alertas (posto_id, tipo, nota, cliente, emissao, emissao_fonte, foto_em, dif_min, detalhe, criado_em)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
    postoId, a.tipo, String(a.nota || "").slice(0, 20), String(a.cliente || "").slice(0, 60),
    a.emissao ? String(a.emissao).slice(0, 30) : null, a.emissaoFonte ? String(a.emissaoFonte).slice(0, 60) : null,
    a.fotoEm ? String(a.fotoEm).slice(0, 30) : null, Number.isFinite(+a.difMin) ? Math.round(+a.difMin * 10) / 10 : null,
    a.detalhe ? String(a.detalhe).slice(0, 300) : null, agoraISO()).run();
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
    if (String(usuario).trim().toLowerCase() === "admin") {
      if (!iguais(String(senha), env.ADMIN_PASSWORD || "admin")) return erro("Usuário ou senha incorretos.", 401);
      return json({ papel: "admin" }, 200, { "set-cookie": await criarSessao(env, { r: "admin", v: await versaoAdmin(env) }) });
    }
    const cnpj = normCNPJ(usuario);
    if (!validCNPJ(cnpj)) return erro("CNPJ inválido. Confira os dígitos.", 400);
    const p = await env.DB.prepare("SELECT * FROM postos WHERE cnpj = ?").bind(cnpj).first();
    if (!p || !iguais(await hashSenha(String(senha), p.salt), p.senha_hash)) return erro("CNPJ ou senha incorretos. Se esqueceu a senha, fale com a matriz.", 401);
    return json({ papel: "posto" }, 200, { "set-cookie": await criarSessao(env, { r: "posto", pid: p.id, s: p.salt.slice(0, 12) }) });
  }

  if (caminho === "/api/logout" && metodo === "POST") return json({ ok: true }, 200, { "set-cookie": apagarSessao });

  const s = await lerSessao(request, env);
  if (!s) return erro("Sessão expirada. Entre de novo.", 401);

  if (caminho === "/api/me" && metodo === "GET") {
    if (s.admin) return json({ papel: "admin", senhaPadrao: !env.ADMIN_PASSWORD });
    return json({ papel: "posto", posto: s.posto });
  }

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
    if (m[2] === "nf" && !s.admin) return erro("A nota fiscal só pode ser baixada pela matriz.", 403);
    const baixar = s.admin && (url.searchParams.get("download") === "1" || m[2] === "nf");
    const obj = await env.FILES.get(m[2] === "nf" ? f.chave_nf : f.chave_foto);
    if (!obj) return erro("Arquivo não encontrado no armazenamento.", 404);
    const nome = m[2] === "nf" ? f.arquivo_nf : f.arquivo;
    return new Response(obj.body, { headers: {
      "content-type": m[2] === "nf" ? "application/pdf" : "image/jpeg",
      "cache-control": "private, max-age=3600",
      "content-disposition": `${baixar ? "attachment" : "inline"}; filename="${nome.replace(/"/g, "")}"`,
      "x-content-type-options": "nosniff"
    } });
  }

  /* ----- alertas ----- */
  if (caminho === "/api/alertas" && metodo === "POST") {
    if (!s.posto) return erro("Só o acesso do posto registra alertas.", 403);
    const a = await request.json().catch(() => ({}));
    await registrarAlerta(env, s.posto.id, a);
    return json({ ok: true });
  }
  if (caminho === "/api/alertas" && metodo === "GET") {
    if (!s.admin) return erro("Acesso só da matriz.", 403);
    const todos = url.searchParams.get("todos") === "1";
    const r = await env.DB.prepare(`SELECT a.*, p.nome AS posto_nome, p.cnpj AS posto_cnpj FROM alertas a
      LEFT JOIN postos p ON p.id = a.posto_id ${todos ? "" : "WHERE a.visto = 0"} ORDER BY a.criado_em DESC LIMIT 300`).all();
    const abertos = await env.DB.prepare("SELECT COUNT(*) AS n FROM alertas WHERE visto = 0").first();
    return json({ alertas: r.results.map(a => ({ ...a, tipo_txt: TIPOS_ALERTA[a.tipo] || a.tipo })), abertos: abertos.n });
  }
  m = caminho.match(/^\/api\/alertas\/(\d+)$/);
  if (m && metodo === "PUT") {
    if (!s.admin) return erro("Acesso só da matriz.", 403);
    await env.DB.prepare("UPDATE alertas SET visto = 1, visto_em = ? WHERE id = ?").bind(agoraISO(), +m[1]).run();
    return json({ ok: true });
  }

  /* ----- postos (matriz) ----- */
  if (caminho.startsWith("/api/postos") && !s.admin) return erro("Acesso só da matriz.", 403);
  if (caminho === "/api/postos" && metodo === "GET") {
    const r = await env.DB.prepare(`SELECT p.id, p.cnpj, p.nome, p.criado_em, p.atualizado_em,
      (SELECT COUNT(*) FROM fotos f WHERE f.posto_id = p.id) AS fotos,
      (SELECT COUNT(*) FROM alertas a WHERE a.posto_id = p.id AND a.visto = 0) AS alertas
      FROM postos p ORDER BY p.nome COLLATE NOCASE`).all();
    return json({ postos: r.results });
  }
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

  const n = m.nf || {};
  if (numInt(nota) !== numInt(n.numero)) return erro("O número da nota no PDF precisa ser igual ao número digitado.", 422);

  const base = { nota, cliente, fotoEm: capBR.texto };
  const emissaoMs = Number(n.emissaoMs);
  if (!Number.isFinite(emissaoMs)) {
    await registrarAlerta(env, posto.id, { ...base, tipo: "horario_nao_lido", detalhe: "Envio bloqueado no servidor." });
    return erro("Não foi possível ler o horário de emissão da nota. Entre em contato com a matriz.", 422, { alertaMatriz: true });
  }
  const dif = Math.abs(cap - emissaoMs) / 60e3;
  const emissaoTxt = brasilia(emissaoMs).texto;
  if (dif > LIMITE_NOTA_MIN) {
    await registrarAlerta(env, posto.id, { ...base, tipo: "atraso", emissao: emissaoTxt, emissaoFonte: n.emissaoFonte, difMin: dif, detalhe: "Envio bloqueado no servidor." });
    return erro(`Diferença de ${Math.round(dif)} min entre a emissão da nota e a foto. Entre em contato com a matriz.`, 422, { alertaMatriz: true });
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

  const tipo = destDoc.length === 14 ? "PJ" : destDoc.length === 11 ? "PF" : "NI";
  await env.DB.prepare(`INSERT INTO fotos (posto_id, cliente, nota, arquivo, arquivo_nf, chave_foto, chave_nf, capturado_em, capturado_txt, cap_dia, recebido_em,
      dest_nome, dest_doc, dest_tipo, dest_origem, nf_numero, nf_serie, nf_modelo, nf_cnpj_emit, nf_emissao, nf_emissao_fonte, dif_min, cnpj_na_epoca, nome_na_epoca)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
    posto.id, cliente, nota, arquivo, arquivoNf, chaveFoto, chaveNf, new Date(cap).toISOString(), capBR.texto, capBR.dia, agoraISO(),
    destNome, destDoc || null, tipo, m.destOrigem === "editado à mão" ? "editado à mão" : "lido do PDF",
    numInt(n.numero), n.serie ? String(n.serie).slice(0, 5) : null, n.modelo ? String(n.modelo).slice(0, 10) : null,
    n.cnpjEmit ? normCNPJ(n.cnpjEmit) : null, emissaoTxt, n.emissaoFonte ? String(n.emissaoFonte).slice(0, 60) : null,
    Math.round(dif * 10) / 10, posto.cnpj, posto.nome).run();

  return json({ ok: true, arquivo, arquivoNf });
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
    onde.push("(" + partes.join(" OR ") + ")");
  }
  const where = onde.length ? "WHERE " + onde.join(" AND ") : "";
  const limite = Math.min(500, Math.max(1, +q.get("limite") || 200));
  const total = await env.DB.prepare(`SELECT COUNT(*) AS n FROM fotos f LEFT JOIN postos p ON p.id = f.posto_id ${where}`).bind(...args).first();
  const r = await env.DB.prepare(`SELECT f.id, f.posto_id, f.cliente, f.nota, f.arquivo, f.arquivo_nf, f.capturado_txt, f.cap_dia,
      f.dest_nome, f.dest_doc, f.dest_tipo, f.dest_origem, f.nf_emissao, f.nf_emissao_fonte, f.dif_min,
      p.nome AS posto_nome, p.cnpj AS posto_cnpj
      FROM fotos f LEFT JOIN postos p ON p.id = f.posto_id ${where} ORDER BY f.capturado_em DESC LIMIT ${limite}`).bind(...args).all();
  const fotos = r.results.map(f => s.admin ? f : { ...f, arquivo_nf: undefined });
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
  if (s.admin) res.postos = (await env.DB.prepare("SELECT id, cnpj, nome FROM postos ORDER BY nome COLLATE NOCASE").all()).results;
  return json(res);
}

/* ---------- entrada ---------- */
const BLOQUEADOS = /^\/(LEIA-ME|README|schema)\b|\.md$|\.sql$/i;
/* Diagnóstico: https://SEU-PROJETO.pages.dev/api/status (não mostra dados, só se as peças estão ligadas) */
async function status(env) {
  const r = { servidor: "ok", armazenamento: env.ARMAZENAMENTO || "", banco_DB: "", arquivos_FILES: "", senha_admin: env.ADMIN_PASSWORD ? "definida (ADMIN_PASSWORD)" : "padrão (admin)", hora_servidor: agoraISO() };
  if (!env.DB) r.banco_DB = "NÃO LIGADO: crie a ligação D1 com o nome DB e publique de novo";
  else if (typeof env.DB.prepare !== "function") r.banco_DB = "ligação DB existe, mas não é um banco D1 (confira o tipo da ligação)";
  else {
    try { await preparar({ ...env, FILES: env.FILES && typeof env.FILES.put === "function" ? env.FILES : { put() {} } }); const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM postos").first(); r.banco_DB = `ok (${n.n} posto(s) cadastrado(s))`; }
    catch (e) { r.banco_DB = "ERRO: " + (e && e.message || e); }
  }
  if (!env.FILES) r.arquivos_FILES = "NÃO LIGADO: crie a ligação R2 com o nome FILES e publique de novo";
  else if (typeof env.FILES.put !== "function") r.arquivos_FILES = "ligação FILES existe, mas não é um bucket R2 (confira o tipo da ligação)";
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
        // detalhe técnico incluído para facilitar o diagnóstico nesta fase
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
