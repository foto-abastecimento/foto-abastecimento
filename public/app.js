"use strict";
/* Foto Abastecimento — telas do posto e da matriz */
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const LIMITE_MIN = 10;

/* ---------- utilitários ---------- */
const soDig = s => String(s || "").replace(/\D/g, "");
const numInt = s => { const d = soDig(s).replace(/^0+/, ""); return d || (soDig(s) ? "0" : ""); };
const normCNPJ = s => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 14);
function maskCNPJ(s){ const c = normCNPJ(s); let o = ""; for (let i=0;i<c.length;i++){ if(i===2||i===5)o+="."; if(i===8)o+="/"; if(i===12)o+="-"; o+=c[i]; } return o; }
function validCNPJ(s){
  const c = normCNPJ(s);
  if (!/^[A-Z0-9]{12}\d{2}$/.test(c) || /^(.)\1+$/.test(c)) return false;
  const v = ch => ch.charCodeAt(0) - 48;
  const dv = n => { let sum=0,w=n-7; for(let i=0;i<n;i++){ sum+=v(c[i])*w; w--; if(w<2)w=9; } const r=sum%11; return r<2?0:11-r; };
  return dv(12)===+c[12] && dv(13)===+c[13];
}
function validCPF(s){
  const c = soDig(s); if (c.length!==11 || /^(\d)\1+$/.test(c)) return false;
  const dv = n => { let t=0; for(let i=0;i<n;i++) t += (+c[i])*(n+1-i); const r=(t*10)%11; return r===10?0:r; };
  return dv(9)===+c[9] && dv(10)===+c[10];
}
const fmtCPF = d => d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/,"$1.$2.$3-$4");
const fmtDoc = d => !d ? "" : (d.length===11 ? fmtCPF(d) : maskCNPJ(d));
const MESES = ["janeiro","fevereiro","março","abril","maio","junho","julho","agosto","setembro","outubro","novembro","dezembro"];
function showMsg(el, txt, tipo="err"){ el.textContent = txt; el.className = "msg " + tipo; el.hidden = !txt; }
function debounce(fn, ms=300){ let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
function preencheSelect(sel, opcoes){
  const atual = sel.value; sel.length = 1;
  opcoes.forEach(([v,t]) => { const o = document.createElement("option"); o.value = v; o.textContent = t; sel.appendChild(o); });
  sel.value = opcoes.some(([v]) => String(v) === atual) ? atual : "";
}

/* ---------- servidor ---------- */
async function api(caminho, opts = {}){
  const headers = { "x-requested-with": "fetch", ...(opts.headers || {}) };
  let body = opts.body;
  if (body && !(body instanceof FormData)) { headers["content-type"] = "application/json"; body = JSON.stringify(body); }
  let r;
  try { r = await fetch(caminho, { method: opts.method || "GET", headers, body, credentials: "same-origin" }); }
  catch { throw Object.assign(new Error("Sem conexão com o servidor. Verifique a internet."), { status: 0 }); }
  const ehJson = (r.headers.get("content-type") || "").includes("application/json");
  const dados = ehJson ? await r.json().catch(() => ({})) : {};
  if (!ehJson && !(opts.method === undefined && caminho.startsWith("/api/fotos/"))){
    // resposta que não veio do servidor do sistema: _worker.js inativo ou erro da plataforma
    throw Object.assign(new Error(`O servidor do sistema não respondeu (HTTP ${r.status}). Abra ${location.origin}/api/status para conferir.`), { status: r.status });
  }
  if (r.status === 401 && caminho !== "/api/login"){ irLogin("Sua sessão expirou. Entre de novo."); throw Object.assign(new Error(dados.erro || "Sessão expirada."), { status: 401 }); }
  if (!r.ok) throw Object.assign(new Error(dados.erro || "Erro no servidor."), { status: r.status, dados });
  return dados;
}

/* ---------- relógio sincronizado com o servidor (horário de Brasília) ---------- */
let desvio = 0;
async function sincronizar(){
  try { const t0 = Date.now(); const r = await api("/api/time"); const t1 = Date.now(); desvio = Date.parse(r.agora) - (t0 + t1) / 2; } catch {}
}
const agora = () => new Date(Date.now() + desvio);
const fmtBR = new Intl.DateTimeFormat("pt-BR",{timeZone:"America/Sao_Paulo",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hourCycle:"h23"});
function brt(d){ const p={}; fmtBR.formatToParts(d).forEach(x => p[x.type]=x.value); return p; }
const brtTexto = p => `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}:${p.second}`;
setInterval(() => { const t = brtTexto(brt(agora())); $$(".clockTxt").forEach(el => el.textContent = t); }, 250);
setInterval(sincronizar, 5 * 60 * 1000);

/* ---------- navegação entre telas ---------- */
function mostrar(id){ ["#carregando","#login","#posto","#admin"].forEach(s => $(s).hidden = s !== id); }
function irLogin(msg){
  pararCamera(); limparTudo();
  $("#drawer").hidden = true; $("#viewer").hidden = true;
  $("#lSenha").value = ""; showMsg($("#lMsg"), msg || "");
  mostrar("#login");
}
$$(".sair").forEach(b => b.onclick = async () => { try { await api("/api/logout", { method:"POST" }); } catch {} irLogin(); });

$("#lUsuario").addEventListener("input", e => { const v = e.target.value; if (/^\d/.test(v)) e.target.value = maskCNPJ(v); });
$("#fEntrar").addEventListener("submit", async e => {
  e.preventDefault();
  const usuario = $("#lUsuario").value.trim(), senha = $("#lSenha").value;
  if (usuario.toLowerCase() !== "admin" && !validCNPJ(usuario)) return showMsg($("#lMsg"), "CNPJ inválido. Confira os dígitos.");
  $("#lBtn").disabled = true;
  try { await api("/api/login", { method:"POST", body:{ usuario, senha } }); showMsg($("#lMsg"), ""); await iniciar(); }
  catch (err) { showMsg($("#lMsg"), err.message); }
  finally { $("#lBtn").disabled = false; }
});

async function iniciar(){
  let me;
  try { me = await api("/api/me"); } catch (e) { if (e.status !== 401) { mostrar("#login"); showMsg($("#lMsg"), e.message); } return; }
  if (!me || !me.papel){ mostrar("#login"); return showMsg($("#lMsg"), `Resposta inesperada do servidor. Abra ${location.origin}/api/status.`); }
  await sincronizar();
  if (me.papel === "admin") entrarAdmin(me); else entrarPosto(me.posto);
}

/* =====================================================================
   PORTAL DO POSTO
   ===================================================================== */
let posto = null;
function entrarPosto(p){
  posto = p;
  $("#hNome").textContent = p.nome; $("#hCnpj").textContent = "CNPJ " + maskCNPJ(p.cnpj);
  limparTudo(); mostrar("#posto");
  ligarCamera();
  atualizarContagem();
}

/* ----- câmera do computador (navegador) ----- */
let stream = null;
const video = $("#video");
function camErro(e){
  const m = {
    NotAllowedError: "Acesso à câmera negado. Clique no cadeado ao lado do endereço do site, permita a câmera e clique em “Ligar câmera”.",
    NotFoundError: "Nenhuma câmera encontrada neste computador.",
    NotReadableError: "A câmera está em uso por outro programa. Feche-o e clique em “Ligar câmera”.",
    OverconstrainedError: "A câmera escolhida não está disponível. Escolha outra na lista."
  }[e && e.name] || ("Não foi possível ligar a câmera: " + ((e && e.message) || e));
  $("#camOff").textContent = m; $("#camOff").hidden = false;
}
async function ligarCamera(deviceId){
  if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){
    $("#camOff").textContent = "Este navegador não liberou a câmera. Use Chrome ou Edge atualizados, pelo endereço https do sistema.";
    return;
  }
  pararCamera();
  $("#camOff").textContent = "Ligando a câmera… Se o navegador perguntar, permita o acesso."; $("#camOff").hidden = false;
  try {
    const v = { width:{ ideal:1920 }, height:{ ideal:1080 } };
    if (deviceId) v.deviceId = { exact: deviceId };
    stream = await navigator.mediaDevices.getUserMedia({ audio:false, video: v });
    video.srcObject = stream; await video.play();
    $("#camOff").hidden = true; $("#btnCam").textContent = "Desligar câmera";
    const devs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === "videoinput");
    const sel = $("#camSel"), atual = stream.getVideoTracks()[0].getSettings().deviceId;
    sel.innerHTML = "";
    devs.forEach((d,i) => { const o = document.createElement("option"); o.value = d.deviceId; o.textContent = d.label || ("Câmera " + (i+1)); if (d.deviceId === atual) o.selected = true; sel.appendChild(o); });
    sel.hidden = devs.length < 2;
  } catch (e) { stream = null; camErro(e); }
  atualizaBotao();
}
function pararCamera(){
  if (stream) stream.getTracks().forEach(t => t.stop());
  stream = null; video.srcObject = null;
  $("#btnCam").textContent = "Ligar câmera";
  $("#camOff").textContent = "Câmera desligada. Clique em “Ligar câmera”."; $("#camOff").hidden = false;
  atualizaBotao();
}
$("#btnCam").onclick = () => stream ? pararCamera() : ligarCamera($("#camSel").value || undefined);
$("#camSel").onchange = e => ligarCamera(e.target.value);

/* ----- estado do formulário ----- */
let nf = null, pendente = null;
const alertasEnviados = new Set();
function atualizaBotao(){
  $("#btnFoto").disabled = !(stream && $("#fCliente").value.trim() && $("#fNota").value.trim());
  const v = verificaHorario();
  mostraAlertaHorario(v);
  if (v && !v.ok) enviarAlerta(v);
  $("#btnSalvar").disabled = !(pendente && nf && nf.confere && v && v.ok && $("#fCliente").value.trim() && $("#fDestNome").value.trim());
}
$("#fCliente").addEventListener("input", atualizaBotao);
$("#fNota").addEventListener("input", () => { conferirNF(); atualizaBotao(); });
$("#fDestNome").addEventListener("input", atualizaBotao);
$("#fDestDoc").addEventListener("input", e => {
  const d = soDig(e.target.value).slice(0,14);
  e.target.value = d.length > 11 ? maskCNPJ(d) : d.length === 11 ? fmtCPF(d) : d;
});
function limparTudo(){
  if (pendente) URL.revokeObjectURL(pendente.url);
  pendente = null; nf = null;
  $("#preview").hidden = true; video.hidden = false;
  $("#capActions").hidden = false; $("#revActions").hidden = true;
  ["#fCliente","#fNota","#fDestNome","#fDestDoc"].forEach(s => $(s).value = "");
  $("#fPdf").value = ""; $("#destBox").hidden = true;
  mostraNF("wait","Anexe o PDF da nota (DANFE ou NFC-e). O sistema confere o número e o horário de emissão.");
  showMsg($("#capMsg"), ""); mostraAlertaHorario(null);
  atualizaBotao();
}

/* ----- leitura do PDF da nota ----- */
if (window.pdfjsLib) pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
function dvChave(c43){ let s=0,w=2; for(let i=42;i>=0;i--){ s+=(+c43[i])*w; w=w===9?2:w+1; } const r=s%11; return r<2?0:11-r; }
function acharChave(texto){
  const corridas = texto.replace(/(\d)[\s.\-]+(?=\d)/g,"$1").match(/\d{44,}/g) || [];
  for (const r of corridas) for (let i=0;i+44<=r.length;i++){
    const c = r.slice(i,i+44), mod = c.slice(20,22);
    if ((mod==="55"||mod==="65") && dvChave(c.slice(0,43))===+c[43]) return c;
  }
  return null;
}
function acharNumeroImpresso(texto){
  const pads = [/NFC?-e[^\d]{0,12}?n[º°o.]*\s*:?\s*([\d.]{1,11})/i, /N[º°o]\.?\s*:?\s*([\d][\d.]{0,10})\b[^\n]{0,20}?S[ée]rie/i, /N[ÚU]MERO\s*:?\s*([\d.]{1,11})/i, /\bN[º°]\.?\s*:?\s*([\d][\d.]{0,10})/i];
  for (const p of pads){ const m = texto.match(p); if (m && soDig(m[1])) return soDig(m[1]); }
  return null;
}
async function lerPDF(blob){
  if (!window.pdfjsLib) throw new Error("O leitor de PDF não carregou. Verifique a internet e recarregue a página.");
  const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(await blob.arrayBuffer()), isEvalSupported:false }).promise;
  let texto = ""; const itens = [];
  for (let i=1;i<=Math.min(pdf.numPages,3);i++){
    const pg = await pdf.getPage(i); const tc = await pg.getTextContent();
    texto += tc.items.map(x=>x.str).join(" ") + "\n";
    tc.items.forEach(it => {
      if (!it.str || !it.str.trim()) return;
      const [a,b,c,d,e,f] = it.transform;
      itens.push({ s: it.str.trim(), x: e, y: f, w: it.width || 0, h: it.height || Math.hypot(c,d) || 8, p: i });
    });
  }
  return { texto, itens };
}

/* Cliente favorecido: quadro DESTINATÁRIO / REMETENTE, lido pela posição (valor logo abaixo do rótulo).
   Usa o rótulo mais próximo do título do quadro, para não pegar o do transportador. */
const RE_TIT_DEST = /DESTINAT[ÁA]RIO/i;
const RE_ROT_NOME = /NOME\s*\/?\s*RAZ[ÃA]O(\s+SOCIAL)?|RAZ[ÃA]O\s+SOCIAL/i;
const RE_ROT_DOC = /CNPJ\s*\/?\s*CPF|CPF\s*\/?\s*CNPJ/i;
function linhaAbaixo(pg, rot){
  if (!rot) return [];
  const cand = pg.filter(i => i.y < rot.y - 0.5 && rot.y - i.y <= Math.max(22, rot.h * 4));
  if (!cand.length) return [];
  const topo = Math.max(...cand.map(i => i.y));
  return cand.filter(i => Math.abs(i.y - topo) < 2).sort((a,b) => a.x - b.x);
}
function destPorPosicao(itens, cnpjEmit){
  const pg = itens.filter(i => i.p === 1);
  const tit = pg.find(i => RE_TIT_DEST.test(i.s));
  if (!tit) return null;
  const abaixo = pg.filter(i => i.y <= tit.y + 1 && i !== tit);
  const maisPerto = re => abaixo.filter(i => re.test(i.s)).sort((a,b) => (tit.y-a.y) - (tit.y-b.y))[0];
  const rotNome = maisPerto(RE_ROT_NOME), rotDoc = maisPerto(RE_ROT_DOC);
  const ehNumero = s => /^[\d.\/\-:\s]+$/.test(s);
  let nome = "";
  if (rotNome){
    const viz = pg.filter(i => i !== rotNome && Math.abs(i.y - rotNome.y) < 2 && i.x > rotNome.x + 1);
    const dir = Math.min(Infinity, ...viz.map(i => i.x));
    nome = linhaAbaixo(pg, rotNome).filter(i => i.x >= rotNome.x - 3 && i.x < dir && !ehNumero(i.s)).map(i => i.s).join(" ").replace(/\s+/g," ").trim();
    if ((nome.match(/[A-Za-zÀ-ÿ]/g)||[]).length < 2) nome = "";
  }
  let doc = "";
  if (rotDoc){
    const centro = rotDoc.x + rotDoc.w/2;
    const nums = linhaAbaixo(pg, rotDoc).map(i => ({ d: soDig(i.s), dist: Math.abs(i.x + i.w/2 - centro) }))
      .filter(o => (o.d.length === 14 && o.d !== cnpjEmit && validCNPJ(o.d)) || (o.d.length === 11 && validCPF(o.d)))
      .sort((a,b) => a.dist - b.dist);
    if (nums.length) doc = nums[0].d;
  }
  if (!nome && !doc) return null;
  return { nome: nome.slice(0,100), doc };
}
/* reserva: leitura pelo texto corrido (NFC-e e leiautes diferentes) */
function destPorTexto(texto, cnpjEmit){
  const t = texto.replace(/\s+/g," ");
  let i = t.search(/DESTINAT[ÁA]RIO/i), trecho;
  if (i >= 0) trecho = t.slice(i, i+700);
  else {
    const j = t.search(/CONSUMIDOR/i); if (j < 0) return null;
    trecho = t.slice(j, j+300);
    if (/CONSUMIDOR\s*N[ÃA]O\s+IDENTIFICADO/i.test(trecho)) return { nome:"Consumidor não identificado", doc:"" };
  }
  let doc = "";
  for (const m of trecho.matchAll(/\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g)){ const d = soDig(m[0]); if (d !== cnpjEmit && validCNPJ(d)) { doc = d; break; } }
  if (!doc) for (const m of trecho.matchAll(/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g)){ const d = soDig(m[0]); if (validCPF(d)) { doc = d; break; } }
  const ROTULOS = /\b(DESTINAT[ÁA]RIO\s*\/?\s*REMETENTE|DESTINAT[ÁA]RIO|CONSUMIDOR|NOME\s*\/\s*RAZ[ÃA]O\s+SOCIAL|RAZ[ÃA]O\s+SOCIAL|NOME|CNPJ\s*\/\s*CPF|CNPJ|CPF|DATA\s+D[AE]\s+EMISS[ÃA]O|DATA\s+D[AE]\s+SA[ÍI]DA(?:\s*\/\s*ENTRADA)?|HORA\s+D[AE]\s+SA[ÍI]DA|ENDERE[ÇC]O|BAIRRO\s*\/?\s*DISTRITO|BAIRRO|CEP|MUNIC[ÍI]PIO|UF|FONE\s*\/?\s*FAX|FONE|INSCRI[ÇC][ÃA]O\s+ESTADUAL|IE)\b\s*:?/gi;
  const partes = trecho.replace(ROTULOS,"|").replace(/[\d][\d.\/\-: ]{4,}[\d]/g,"|").split("|").map(s => s.replace(/^[\s\/\-:.,]+|[\s\/\-:.,]+$/g,"").trim());
  const nome = partes.find(s => (s.match(/[A-Za-zÀ-ÿ]/g)||[]).length >= 3) || "";
  return { nome: nome.slice(0,100), doc };
}

/* Data e hora de emissão */
const RE_DT = "(\\d{2})\\/(\\d{2})\\/(\\d{4})[\\s,T\\-–àsÀS]*(\\d{2}):(\\d{2})(?::(\\d{2}))?(?:\\s*([+\\-]\\d{2}):?(\\d{2}))?";
function montaData(d, mo, y, h, mi, s, offH, offM){
  const off = offH ? `${offH}:${offM||"00"}` : "-03:00"; // sem fuso impresso: horário de Brasília
  const t = Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${s||"00"}${off}`);
  return isNaN(t) ? null : { ms: t, texto: `${d}/${mo}/${y} ${h}:${mi}:${s||"00"}` };
}
function valorAbaixoRotulo(itens, re){
  const pg = itens.filter(i => i.p === 1);
  const rot = pg.find(i => re.test(i.s)); if (!rot) return "";
  const linha = linhaAbaixo(pg, rot), centro = rot.x + rot.w/2;
  linha.sort((a,b) => Math.abs(a.x+a.w/2-centro) - Math.abs(b.x+b.w/2-centro));
  return linha.length ? linha[0].s : "";
}
function acharEmissao(texto, itens){
  const t = texto.replace(/\s+/g," ");
  let m = t.match(new RegExp("EMISS[ÃA]O[^\\d]{0,40}?" + RE_DT, "i"));
  if (m){ const r = montaData(...m.slice(1)); if (r) return { ...r, fonte: "data/hora de emissão impressa" }; }
  const vd = valorAbaixoRotulo(itens, /DATA\s+D[AE]\s+EMISS/i), vh = valorAbaixoRotulo(itens, /HORA\s+D[AE]\s+EMISS/i);
  const md = vd.match(new RegExp(RE_DT));
  if (md){ const r = montaData(...md.slice(1)); if (r) return { ...r, fonte: "campo data/hora da emissão" }; }
  const sd = vd.match(/(\d{2})\/(\d{2})\/(\d{4})/), sh = vh.match(/(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (sd && sh){ const r = montaData(sd[1],sd[2],sd[3],sh[1],sh[2],sh[3]); if (r) return { ...r, fonte: "campos data e hora da emissão" }; }
  m = t.match(new RegExp("\\b\\d{15}\\b\\s*[-–]?\\s*" + RE_DT));
  if (m){ const r = montaData(...m.slice(1)); if (r) return { ...r, fonte: "horário de autorização (protocolo)" }; }
  return null;
}

function mostraNF(cls, titulo, det){
  const el = $("#nfRes"); el.className = "nfres " + cls; el.innerHTML = "";
  const b = document.createElement("b"); b.textContent = titulo; el.appendChild(b);
  (det||[]).forEach(d => { const s = document.createElement("span"); s.className = "det"; s.textContent = d; el.appendChild(s); });
}
async function anexarPDF(arquivo){
  nf = null; $("#destBox").hidden = true; atualizaBotao();
  if (arquivo.size > 10*1024*1024) return mostraNF("err","PDF maior que 10 MB.",["Anexe o PDF original da nota."]);
  const cab = new TextDecoder().decode(await arquivo.slice(0,5).arrayBuffer());
  if (cab !== "%PDF-") return mostraNF("err","O arquivo não é um PDF válido.",["Anexe o PDF da nota fiscal (DANFE ou NFC-e)."]);
  mostraNF("wait","Lendo o PDF…");
  let lido;
  try { lido = await lerPDF(arquivo); }
  catch (e) { return mostraNF("err","Não foi possível abrir o PDF.",[(e && e.message) || "Arquivo corrompido ou protegido."]); }
  const { texto, itens } = lido;
  const chave = acharChave(texto);
  let info;
  if (chave) info = { numero: numInt(chave.slice(25,34)), serie: numInt(chave.slice(22,25)), modelo: chave.slice(20,22)==="65"?"NFC-e":"NF-e", cnpjEmit: chave.slice(6,20), origem: "chave de acesso" };
  else { const n = acharNumeroImpresso(texto); if (n) info = { numero: numInt(n), origem: "número impresso no documento" }; }
  if (!info){
    if (!texto.trim()) return mostraNF("err","Não há texto legível no PDF.",["Parece ser uma imagem escaneada. Anexe o PDF gerado pelo sistema emissor da nota."]);
    return mostraNF("err","Não encontrei o número da nota no PDF.",["Nem a chave de acesso nem o campo “Nº” foram localizados."]);
  }
  nf = { arquivo, ...info, confere:false, emissao: acharEmissao(texto, itens) };
  const pos = destPorPosicao(itens, info.cnpjEmit || ""), txt = destPorTexto(texto, info.cnpjEmit || "");
  const dest = pos ? { nome: pos.nome || (txt && txt.nome) || "", doc: pos.doc || (txt && txt.doc) || "" } : txt;
  $("#fDestNome").value = dest && dest.nome || "";
  $("#fDestDoc").value = dest && dest.doc ? fmtDoc(dest.doc) : "";
  nf.destLido = { nome: $("#fDestNome").value, doc: dest && dest.doc || "" };
  $("#destOrigem").textContent = dest && (dest.nome || dest.doc) ? "Cliente favorecido lido da nota. Confira e corrija se precisar." : "Não consegui ler o cliente favorecido neste PDF. Preencha à mão.";
  $("#destBox").hidden = false;
  conferirNF(); atualizaBotao();
}
function conferirNF(){
  if (!nf) return;
  const dig = numInt($("#fNota").value);
  nf.confere = !!dig && dig === nf.numero;
  const det = [`Lido no PDF (${nf.origem}): nota ${nf.numero}` + (nf.serie ? `, série ${nf.serie}` : "") + (nf.modelo ? `, ${nf.modelo}` : "")];
  det.push(nf.emissao ? `Emitida em ${nf.emissao.texto} (${nf.emissao.fonte})` : "Horário de emissão não encontrado no PDF.");
  if (nf.cnpjEmit){
    det.push(`CNPJ emitente: ${maskCNPJ(nf.cnpjEmit)}`);
    if (posto && nf.cnpjEmit !== posto.cnpj) det.push(`Atenção: o emitente é diferente do CNPJ deste posto (${maskCNPJ(posto.cnpj)}).`);
  }
  if (!dig) mostraNF("wait","PDF lido. Digite o número da nota para conferir.", det);
  else if (nf.confere) mostraNF("ok",`Confere: nota ${nf.numero} digitada e no PDF.`, det);
  else mostraNF("err",`Não confere: digitado ${dig}, no PDF ${nf.numero}. Corrija o número digitado.`, det);
}
$("#fPdf").addEventListener("change", e => { const f = e.target.files && e.target.files[0]; if (f) anexarPDF(f); else { nf = null; $("#destBox").hidden = true; mostraNF("wait","Anexe o PDF da nota (DANFE ou NFC-e)."); atualizaBotao(); } });

/* ----- conferência de horário e alerta para a matriz ----- */
function verificaHorario(){
  if (!pendente || !nf) return null;
  if (!nf.emissao) return { ok:false, tipo:"horario_nao_lido", titulo:"Não foi possível ler o horário de emissão da nota.", det:"Sem esse horário o sistema não consegue conferir a nota com a foto." };
  const dif = Math.abs(pendente.capturadoMs - nf.emissao.ms) / 60000;
  const difTxt = dif < 60 ? `${Math.round(dif)} min` : `${Math.floor(dif/60)} h ${Math.round(dif%60)} min`;
  if (dif > LIMITE_MIN) return { ok:false, tipo:"atraso", dif, titulo:`Diferença de ${difTxt} entre a emissão da nota e a foto.`, det:`Emissão: ${nf.emissao.texto} (${nf.emissao.fonte}). Foto: ${pendente.brasilia}. Limite: ${LIMITE_MIN} min.` };
  return { ok:true, dif };
}
function mostraAlertaHorario(v){
  const el = $("#alertaMatriz");
  if (!v || v.ok){ el.hidden = true; el.innerHTML = ""; return; }
  el.innerHTML = "";
  const b = document.createElement("b"); b.textContent = "Bloqueado: entre em contato com a matriz."; el.appendChild(b);
  [v.titulo, v.det].forEach(t => { const s = document.createElement("span"); s.textContent = t; el.appendChild(s); });
  el.hidden = false;
}
function enviarAlerta(v){
  const chave = [v.tipo, numInt($("#fNota").value) || nf.numero, nf.emissao ? nf.emissao.texto : "", pendente.brasilia].join("|");
  if (alertasEnviados.has(chave)) return;
  alertasEnviados.add(chave);
  api("/api/alertas", { method:"POST", body:{
    tipo: v.tipo, nota: $("#fNota").value.trim() || nf.numero, cliente: $("#fCliente").value.trim(),
    emissao: nf.emissao ? nf.emissao.texto : null, emissaoFonte: nf.emissao ? nf.emissao.fonte : null,
    fotoEm: pendente.brasilia, difMin: v.dif
  } }).catch(() => alertasEnviados.delete(chave));
}

/* ----- captura com carimbo ----- */
function cortar(ctx, txt, max){ if (ctx.measureText(txt).width <= max) return txt; while (txt.length && ctx.measureText(txt+"…").width > max) txt = txt.slice(0,-1); return txt+"…"; }
$("#btnFoto").onclick = async () => {
  const cliente = $("#fCliente").value.trim(), nota = $("#fNota").value.trim();
  if (!stream || !video.videoWidth) return showMsg($("#capMsg"), "A câmera ainda não está pronta.");
  if (!cliente || !nota) return showMsg($("#capMsg"), "Preencha cliente/motorista e número da nota antes da foto.");
  try { await document.fonts.load("700 20px 'JetBrains Mono'"); } catch {}
  const quando = agora(), p = brt(quando);
  const w = video.videoWidth, h = video.videoHeight;
  const cv = document.createElement("canvas"); cv.width = w; cv.height = h;
  const ctx = cv.getContext("2d"); ctx.drawImage(video, 0, 0, w, h);
  const fs = Math.max(14, Math.round(w/48)), lh = Math.round(fs*1.45), pad = Math.round(fs*.8);
  const linhas = [
    `${brtTexto(p)}  (Horário de Brasília)`,
    `Loja: ${posto.nome}  |  CNPJ: ${maskCNPJ(posto.cnpj)}`,
    `Cliente/Motorista: ${cliente}  |  Nota: ${nota}`
  ];
  const bandH = linhas.length*lh + pad*2;
  ctx.fillStyle = "rgba(0,0,0,0.74)"; ctx.fillRect(0, h-bandH, w, bandH);
  ctx.fillStyle = "#f0b429"; ctx.fillRect(0, h-bandH, w, Math.max(2, Math.round(fs/6)));
  ctx.textBaseline = "top"; ctx.textAlign = "left";
  linhas.forEach((t,i) => {
    ctx.font = `${i===0?700:500} ${fs}px "JetBrains Mono", Consolas, monospace`;
    ctx.fillStyle = i===0 ? "#ffffff" : "#e3ebe8";
    ctx.fillText(cortar(ctx, t, w-pad*2), pad, h-bandH+pad+i*lh);
  });
  const blob = await new Promise(r => cv.toBlob(r, "image/jpeg", 0.9));
  if (pendente) URL.revokeObjectURL(pendente.url);
  pendente = { blob, url: URL.createObjectURL(blob), capturadoMs: quando.getTime(), brasilia: brtTexto(p), nota, cliente };
  $("#preview").src = pendente.url; $("#preview").hidden = false; video.hidden = true;
  $("#capActions").hidden = true; $("#revActions").hidden = false;
  atualizaBotao();
  const v = verificaHorario();
  if (v && !v.ok) showMsg($("#capMsg"), "Foto tirada, mas o salvamento está bloqueado. Veja o alerta acima.");
  else showMsg($("#capMsg"), nf && nf.confere ? "Confira a foto e o carimbo, depois salve." : "Foto tirada. Anexe o PDF da nota com o mesmo número para liberar o salvamento.", "ok");
};
function voltarCaptura(){
  if (pendente) URL.revokeObjectURL(pendente.url);
  pendente = null; $("#preview").hidden = true; video.hidden = false;
  $("#capActions").hidden = false; $("#revActions").hidden = true;
  atualizaBotao();
}
$("#btnRefazer").onclick = () => { voltarCaptura(); showMsg($("#capMsg"), ""); };

$("#btnSalvar").onclick = async () => {
  if (!pendente) return;
  conferirNF();
  if (!nf) return showMsg($("#capMsg"), "Anexe o PDF da nota fiscal.");
  if (!nf.confere) return showMsg($("#capMsg"), "O número da nota no PDF precisa ser igual ao número digitado.");
  if (numInt(pendente.nota) !== numInt($("#fNota").value) || pendente.cliente !== $("#fCliente").value.trim())
    return showMsg($("#capMsg"), "Cliente ou número da nota mudou depois da foto. Descarte e tire a foto de novo para o carimbo sair certo.");
  const v = verificaHorario();
  if (!v || !v.ok){ mostraAlertaHorario(v); return showMsg($("#capMsg"), "Salvamento bloqueado. Entre em contato com a matriz."); }
  const destNome = $("#fDestNome").value.trim(), destDoc = soDig($("#fDestDoc").value);
  if (!destNome) return showMsg($("#capMsg"), "Informe o cliente da nota (nome ou razão social). Se não houver, escreva “Consumidor não identificado”.");
  if (destDoc && !(destDoc.length===14 ? validCNPJ(destDoc) : destDoc.length===11 && validCPF(destDoc))) return showMsg($("#capMsg"), "CNPJ/CPF do cliente da nota inválido. Corrija ou deixe em branco.");
  const editado = destNome !== nf.destLido.nome || destDoc !== nf.destLido.doc;

  const fd = new FormData();
  fd.append("foto", pendente.blob, "foto.jpg");
  fd.append("nf", nf.arquivo, "nota.pdf");
  fd.append("meta", JSON.stringify({
    cliente: pendente.cliente, nota: pendente.nota, capturadoEm: new Date(pendente.capturadoMs).toISOString(),
    destNome, destDoc, destOrigem: editado ? "editado à mão" : "lido do PDF",
    nf: { numero: nf.numero, serie: nf.serie || "", modelo: nf.modelo || "", cnpjEmit: nf.cnpjEmit || "", emissaoMs: nf.emissao.ms, emissaoFonte: nf.emissao.fonte }
  }));
  $("#btnSalvar").disabled = true; showMsg($("#capMsg"), "Enviando…", "ok");
  try {
    const r = await api("/api/fotos", { method:"POST", body: fd });
    limparTudo();
    showMsg($("#capMsg"), `Salvo: ${r.arquivo} + ${r.arquivoNf}`, "ok");
    atualizarContagem();
  } catch (e) {
    if (e.dados && e.dados.alertaMatriz) mostraAlertaHorario({ ok:false, titulo: e.message, det: "O servidor bloqueou o envio." });
    showMsg($("#capMsg"), e.message);
    atualizaBotao();
  }
};

/* ----- banco do posto (só visualização) ----- */
async function atualizarContagem(){
  try { const r = await api("/api/fotos?limite=1"); $("#nFotosPosto").textContent = r.geral; } catch {}
}
$("#btnAbrirBanco").onclick = async () => { $("#drawer").hidden = false; await carregarOpcoesPosto(); listarPosto(); };
$("#btnFecharBanco").onclick = () => { $("#drawer").hidden = true; };
$("#drawer").addEventListener("click", e => { if (e.target.id === "drawer") $("#drawer").hidden = true; });
async function carregarOpcoesPosto(){
  try {
    const o = await api("/api/opcoes");
    preencheSelect($("#pMes"), o.meses.map(m => [m, `${MESES[+m.slice(5)-1]} de ${m.slice(0,4)}`]));
    preencheSelect($("#pCli"), o.clientes.map(c => [c.valor, c.nome + (c.doc ? " · " + fmtDoc(c.doc) : "")]));
  } catch {}
}
async function listarPosto(){
  const q = new URLSearchParams();
  [["q","#pBusca"],["mes","#pMes"],["cli","#pCli"],["tipo","#pTipo"]].forEach(([k,s]) => { const v = $(s).value.trim(); if (v) q.set(k, v); });
  const lista = $("#pLista");
  try {
    const r = await api("/api/fotos?" + q);
    $("#pCount").textContent = r.total === r.geral ? `${r.geral} fotos` : `${r.total} de ${r.geral} fotos` + (r.fotos.length < r.total ? ` (mostrando ${r.fotos.length})` : "");
    lista.innerHTML = "";
    if (!r.fotos.length){ lista.innerHTML = `<div class="empty">${r.geral ? "Nenhuma foto com esses filtros." : "Nenhuma foto salva ainda."}</div>`; return; }
    r.fotos.forEach(f => lista.appendChild(montaItem(f, false)));
  } catch (e) { lista.innerHTML = ""; const d = document.createElement("div"); d.className = "empty"; d.textContent = e.message; lista.appendChild(d); }
}
$("#pBusca").addEventListener("input", debounce(listarPosto));
["#pMes","#pCli","#pTipo"].forEach(s => $(s).addEventListener("change", listarPosto));
$("#pLimpar").onclick = () => { ["#pBusca","#pMes","#pCli","#pTipo"].forEach(s => $(s).value = ""); listarPosto(); };

/* ----- item do banco (comum) ----- */
function montaItem(f, ehAdmin){
  const el = document.createElement("div"); el.className = "item";
  el.innerHTML = `<img alt="" loading="lazy"><div style="min-width:0"><div class="cli"></div><div class="when"></div><div class="meta"></div><div class="row"><button data-a="ver">Ver foto</button></div></div>`;
  const src = `/api/fotos/${f.id}/foto`;
  const img = el.querySelector("img"); img.src = src;
  if (!ehAdmin){ img.addEventListener("contextmenu", e => e.preventDefault()); img.draggable = false; }
  el.querySelector(".cli").textContent = f.dest_nome || f.cliente;
  el.querySelector(".when").textContent = f.capturado_txt;
  const meta = el.querySelector(".meta");
  if (ehAdmin){ const pc = document.createElement("span"); pc.className = "chip posto-chip"; pc.textContent = f.posto_nome || "Posto"; meta.appendChild(pc); }
  const partes = [`Nota ${f.nota}`];
  if (f.dest_doc) partes.push(`${f.dest_tipo === "PF" ? "CPF" : "CNPJ"} ${fmtDoc(f.dest_doc)}`);
  partes.push(`Motorista: ${f.cliente}`);
  meta.appendChild(document.createTextNode(partes.join(" · ")));
  const chip = document.createElement("span"); chip.className = "chip"; chip.textContent = "NF conferida";
  chip.title = [`Emissão ${f.nf_emissao || "?"}`, f.dif_min != null ? `diferença ${f.dif_min} min` : "", f.dest_origem === "editado à mão" ? "cliente corrigido à mão" : ""].filter(Boolean).join(" · ");
  meta.appendChild(chip);
  const ver = () => { $("#viewImg").src = src; $("#viewName").textContent = ehAdmin ? f.arquivo : `${f.dest_nome || f.cliente} · ${f.capturado_txt}`; $("#viewImg").oncontextmenu = ehAdmin ? null : (e => e.preventDefault()); $("#viewer").hidden = false; };
  img.onclick = ver; el.querySelector('[data-a="ver"]').onclick = ver;
  if (ehAdmin){
    const row = el.querySelector(".row");
    const a1 = document.createElement("a"); a1.className = "btn"; a1.href = src + "?download=1"; a1.textContent = "Baixar foto"; row.appendChild(a1);
    const a2 = document.createElement("a"); a2.className = "btn"; a2.href = `/api/fotos/${f.id}/nf`; a2.textContent = "Baixar NF"; row.appendChild(a2);
  }
  return el;
}
$("#viewClose").onclick = () => { $("#viewer").hidden = true; };

/* =====================================================================
   PORTAL DA MATRIZ
   ===================================================================== */
function entrarAdmin(me){
  posto = null;
  $("#avisoSenha").hidden = !me.senhaPadrao;
  mostrar("#admin"); abrirAba("fotos");
  carregarOpcoesAdmin().then(listarAdmin);
  contarAlertas();
}
function abrirAba(aba){
  $$(".abas button").forEach(b => b.setAttribute("aria-selected", b.dataset.aba === aba));
  $$("[data-painel]").forEach(p => p.hidden = p.dataset.painel !== aba);
  if (aba === "alertas") listarAlertas();
  if (aba === "postos") listarPostos();
  if (aba === "fotos") carregarOpcoesAdmin();
}
$$(".abas button").forEach(b => b.onclick = () => abrirAba(b.dataset.aba));

/* ----- fotos de todos os postos ----- */
let ultimaListaAdmin = [];
async function carregarOpcoesAdmin(){
  try {
    const o = await api("/api/opcoes");
    preencheSelect($("#aPosto"), o.postos.map(p => [p.id, `${p.nome} · ${maskCNPJ(p.cnpj)}`]));
    preencheSelect($("#aCli"), o.clientes.map(c => [c.valor, c.nome + (c.doc ? " · " + fmtDoc(c.doc) : "")]));
  } catch {}
}
function filtrosAdmin(){
  const q = new URLSearchParams();
  [["q","#aBusca"],["posto","#aPosto"],["cli","#aCli"],["tipo","#aTipo"],["de","#aDe"],["ate","#aAte"]].forEach(([k,s]) => { const v = $(s).value.trim(); if (v) q.set(k, v); });
  return q;
}
async function listarAdmin(){
  const de = $("#aDe").value, ate = $("#aAte").value;
  if (de && ate && de > ate) showMsg($("#aMsg"), "A data inicial é depois da data final."); else showMsg($("#aMsg"), "");
  const q = filtrosAdmin(); q.set("limite", "500");
  const lista = $("#aLista");
  try {
    const r = await api("/api/fotos?" + q);
    ultimaListaAdmin = r.fotos;
    $("#aCount").textContent = (r.total === r.geral ? `${r.geral} fotos` : `${r.total} de ${r.geral} fotos`) + (r.fotos.length < r.total ? ` (mostrando as ${r.fotos.length} mais recentes)` : "");
    $("#aZip").disabled = !r.fotos.length;
    $("#aZipInfo").textContent = r.fotos.length ? `${r.fotos.length} fotos e ${r.fotos.length} notas` : "";
    lista.innerHTML = "";
    if (!r.fotos.length){ lista.innerHTML = `<div class="empty">${r.geral ? "Nenhuma foto com esses filtros." : "Nenhuma foto em nenhum posto ainda."}</div>`; return; }
    r.fotos.forEach(f => lista.appendChild(montaItem(f, true)));
  } catch (e) { showMsg($("#aMsg"), e.message); }
}
$("#aBusca").addEventListener("input", debounce(listarAdmin));
["#aPosto","#aCli","#aTipo","#aDe","#aAte"].forEach(s => $(s).addEventListener("change", listarAdmin));
$("#aLimpar").onclick = () => { ["#aBusca","#aPosto","#aCli","#aTipo","#aDe","#aAte"].forEach(s => $(s).value = ""); listarAdmin(); };

$("#aZip").onclick = async () => {
  const fotos = ultimaListaAdmin;
  if (!fotos.length) return;
  if (!window.JSZip) return showMsg($("#aMsg"), "Não foi possível montar o .zip agora. Recarregue a página.");
  const btn = $("#aZip"); btn.disabled = true;
  try {
    const z = new JSZip();
    for (let i = 0; i < fotos.length; i++){
      const f = fotos[i];
      showMsg($("#aMsg"), `Montando o .zip: ${i+1} de ${fotos.length}…`, "ok");
      const pasta = `${normCNPJ(f.posto_cnpj || "")}_${(f.posto_nome || "posto").replace(/[\\/:*?"<>|]+/g,"-")}/`;
      const [rf, rn] = await Promise.all([fetch(`/api/fotos/${f.id}/foto?download=1`, { credentials:"same-origin" }), fetch(`/api/fotos/${f.id}/nf`, { credentials:"same-origin" })]);
      if (rf.ok) z.file(pasta + f.arquivo, await rf.blob());
      if (rn.ok) z.file(pasta + f.arquivo_nf, await rn.blob());
    }
    const blob = await z.generateAsync({ type:"blob" });
    const p = brt(agora());
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob);
    a.download = `fotos_matriz_${p.year}-${p.month}-${p.day}_${p.hour}-${p.minute}-${p.second}.zip`;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    showMsg($("#aMsg"), "Arquivo .zip gerado.", "ok");
  } catch (e) { showMsg($("#aMsg"), "Não foi possível gerar o .zip: " + e.message); }
  finally { btn.disabled = false; }
};

/* ----- alertas ----- */
async function contarAlertas(){
  try { const r = await api("/api/alertas"); const n = r.abertos; $("#nAlertas").textContent = n; $("#nAlertas").hidden = !n; } catch {}
}
setInterval(() => { if (!$("#admin").hidden) contarAlertas(); }, 60000);
async function listarAlertas(){
  const lista = $("#alLista");
  try {
    const r = await api("/api/alertas" + ($("#alTodos").checked ? "?todos=1" : ""));
    $("#nAlertas").textContent = r.abertos; $("#nAlertas").hidden = !r.abertos;
    lista.innerHTML = "";
    if (!r.alertas.length){ lista.innerHTML = `<div class="empty">Nenhum alerta ${$("#alTodos").checked ? "registrado" : "em aberto"}.</div>`; return; }
    r.alertas.forEach(a => {
      const el = document.createElement("div"); el.className = "al" + (a.visto ? " visto" : "");
      const criado = brtTexto(brt(new Date(a.criado_em)));
      el.innerHTML = `<div class="row" style="justify-content:space-between"><div><span class="chip erro"></span> <b class="pn"></b></div><span class="mono hint"></span></div><div class="det d1"></div><div class="det d2"></div><div class="row"></div>`;
      el.querySelector(".chip").textContent = a.tipo_txt;
      el.querySelector(".pn").textContent = `${a.posto_nome || "Posto"} · CNPJ ${maskCNPJ(a.posto_cnpj || "")}`;
      el.querySelector(".mono").textContent = criado;
      el.querySelector(".d1").textContent = `Nota ${a.nota || "?"} · Motorista: ${a.cliente || "?"}`;
      el.querySelector(".d2").textContent = a.tipo === "atraso"
        ? `Emissão ${a.emissao || "?"} · Foto ${a.foto_em || "?"} · Diferença ${a.dif_min != null ? a.dif_min + " min" : "?"}${a.emissao_fonte ? " (" + a.emissao_fonte + ")" : ""}`
        : `Foto ${a.foto_em || "?"} · horário de emissão não encontrado no PDF`;
      const row = el.querySelector(".row:last-child");
      if (a.visto){ const s = document.createElement("span"); s.className = "hint"; s.textContent = "Visto em " + brtTexto(brt(new Date(a.visto_em))); row.appendChild(s); }
      else { const b = document.createElement("button"); b.textContent = "Marcar como visto"; b.onclick = async () => { b.disabled = true; try { await api(`/api/alertas/${a.id}`, { method:"PUT", body:{ visto:true } }); listarAlertas(); } catch (e) { b.disabled = false; alertaErro(row, e.message); } }; row.appendChild(b); }
      lista.appendChild(el);
    });
  } catch (e) { lista.innerHTML = ""; alertaErro(lista, e.message); }
}
function alertaErro(onde, txt){ const m = document.createElement("div"); m.className = "msg err"; m.textContent = txt; onde.appendChild(m); }
$("#alTodos").addEventListener("change", listarAlertas);

/* ----- postos ----- */
$("#nCnpj").addEventListener("input", e => { e.target.value = maskCNPJ(e.target.value); });
$("#fNovoPosto").addEventListener("submit", async e => {
  e.preventDefault();
  const cnpj = $("#nCnpj").value, nome = $("#nNome").value.trim(), senha = $("#nSenha").value;
  if (!validCNPJ(cnpj)) return showMsg($("#nMsg"), "CNPJ inválido. Confira os dígitos.");
  try {
    await api("/api/postos", { method:"POST", body:{ cnpj, nome, senha } });
    $("#nCnpj").value = ""; $("#nNome").value = ""; $("#nSenha").value = "";
    showMsg($("#nMsg"), `“${nome}” cadastrado. O posto já pode entrar com o CNPJ e a senha.`, "ok");
    listarPostos();
  } catch (err) { showMsg($("#nMsg"), err.message); }
});
async function listarPostos(){
  const box = $("#psLista");
  try {
    const r = await api("/api/postos");
    box.innerHTML = "";
    if (!r.postos.length){ box.innerHTML = `<div class="empty">Nenhum posto cadastrado. Use o formulário acima.</div>`; return; }
    r.postos.forEach(p => box.appendChild(montaPosto(p)));
  } catch (e) { box.innerHTML = ""; alertaErro(box, e.message); }
}
function montaPosto(p){
  const el = document.createElement("div"); el.className = "posto";
  el.innerHTML = `
    <div class="row" style="justify-content:space-between"><div><b class="pn"></b><div class="mono hint pc"></div></div><button data-a="editar">Editar posto</button></div>
    <div class="stack ed" hidden>
      <div class="fields"><div><label>CNPJ do posto</label><input class="mono e-cnpj"></div><div><label>Nome do posto</label><input class="e-nome" maxlength="60"></div></div>
      <div class="row"><button class="primary" data-a="salvar">Salvar alterações</button><button data-a="cancelar">Cancelar</button></div>
      <span class="hint">As fotos e alertas continuam vinculados a este posto. O posto passa a entrar com o CNPJ novo.</span>
    </div>
    <div class="row"><input type="text" placeholder="Nova senha" aria-label="Nova senha" autocomplete="off" class="e-senha"><button data-a="senha">Alterar senha</button></div>
    <div class="msg" hidden></div>`;
  el.querySelector(".pn").textContent = p.nome;
  el.querySelector(".pc").textContent = `CNPJ ${maskCNPJ(p.cnpj)} · ${p.fotos} ${p.fotos===1?"foto":"fotos"}` + (p.alertas ? ` · ${p.alertas} alerta(s) em aberto` : "");
  const msg = el.querySelector(".msg"), ed = el.querySelector(".ed");
  const iC = el.querySelector(".e-cnpj"), iN = el.querySelector(".e-nome");
  iC.addEventListener("input", () => { iC.value = maskCNPJ(iC.value); });
  el.querySelector('[data-a="editar"]').onclick = () => { iC.value = maskCNPJ(p.cnpj); iN.value = p.nome; ed.hidden = false; showMsg(msg, ""); };
  el.querySelector('[data-a="cancelar"]').onclick = () => { ed.hidden = true; };
  el.querySelector('[data-a="salvar"]').onclick = async () => {
    if (!validCNPJ(iC.value)) return showMsg(msg, "CNPJ inválido. Confira os dígitos.");
    try { await api(`/api/postos/${p.id}`, { method:"PUT", body:{ cnpj: iC.value, nome: iN.value } }); listarPostos(); carregarOpcoesAdmin(); }
    catch (e) { showMsg(msg, e.message); }
  };
  el.querySelector('[data-a="senha"]').onclick = async () => {
    const s = el.querySelector(".e-senha");
    if (s.value.length < 4) return showMsg(msg, "A senha precisa ter pelo menos 4 caracteres.");
    try { await api(`/api/postos/${p.id}/senha`, { method:"PUT", body:{ senha: s.value } }); s.value = ""; showMsg(msg, "Senha alterada. O posto precisa entrar de novo com a senha nova.", "ok"); }
    catch (e) { showMsg(msg, e.message); }
  };
  return el;
}

/* ---------- início ---------- */
iniciar();
