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
    // resposta que não veio do sistema (servidor fora do ar ou reiniciando)
    throw Object.assign(new Error("O sistema está indisponível no momento. Tente de novo em instantes."), { status: r.status });
  }
  if (r.status === 401 && caminho !== "/api/login"){ irLogin(opts.silencioso ? "" : "Sua sessão expirou. Entre de novo."); throw Object.assign(new Error(dados.erro || "Sessão expirada."), { status: 401 }); }
  if (!r.ok) throw Object.assign(new Error(dados.erro || "Não foi possível concluir agora. Tente de novo em instantes."), { status: r.status, dados });
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

/* ---------- localização do aparelho (só para postos com controle de localização) ---------- */
function pegarLocal(maxIdadeMs = 0){
  return new Promise((ok, falha) => {
    if (!window.isSecureContext || !navigator.geolocation) return falha(new Error("Este navegador não informa a localização. Use o Chrome, Edge ou Safari atualizado."));
    navigator.geolocation.getCurrentPosition(
      p => ok({ lat: +p.coords.latitude.toFixed(6), lng: +p.coords.longitude.toFixed(6), precisao: Math.round(p.coords.accuracy) }),
      e => falha(new Error(e.code === 1
        ? "Localização bloqueada. Libere a localização deste site no navegador (ícone ao lado do endereço) e tente de novo."
        : "Não foi possível obter a localização agora. Verifique se a localização do aparelho está ligada e tente de novo.")),
      { enableHighAccuracy: true, timeout: 20000, maximumAge: maxIdadeMs });
  });
}
const linkMapa = (lat, lng) => `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
const fmtDist = m => m == null ? "" : m >= 1000 ? `${(m/1000).toFixed(1).replace(".", ",")} km` : `${m} m`;
function aMapa(lat, lng, texto){ const a = document.createElement("a"); a.href = linkMapa(lat, lng); a.target = "_blank"; a.rel = "noopener noreferrer"; a.textContent = texto || "Ver no mapa"; return a; }

$("#lUsuario").addEventListener("input", e => { const v = e.target.value; if (/^\d/.test(v)) e.target.value = maskCNPJ(v); });
$("#fEntrar").addEventListener("submit", async e => {
  e.preventDefault();
  const usuario = $("#lUsuario").value.trim(), senha = $("#lSenha").value;
  if (/^\d/.test(usuario) && !validCNPJ(usuario)) return showMsg($("#lMsg"), "CNPJ inválido. Confira os dígitos.");
  $("#lBtn").disabled = true;
  try {
    try { await api("/api/login", { method:"POST", body:{ usuario, senha } }); }
    catch (err) {
      // posto com controle de localização: o navegador pede a autorização e o login é refeito com a posição
      if (!(err.status === 428 && err.dados && err.dados.precisaLocal)) throw err;
      showMsg($("#lMsg"), "Este acesso exige a localização. Autorize no aviso do navegador…", "ok");
      const local = await pegarLocal();
      await api("/api/login", { method:"POST", body:{ usuario, senha, local } });
    }
    showMsg($("#lMsg"), ""); await iniciar();
  }
  catch (err) { showMsg($("#lMsg"), err.message); }
  finally { $("#lBtn").disabled = false; }
});

async function iniciar(){
  let me;
  try { me = await api("/api/me", { silencioso: true }); } catch (e) { if (e.status !== 401) { mostrar("#login"); showMsg($("#lMsg"), e.message); } return; }
  if (!me || !me.papel){ mostrar("#login"); return showMsg($("#lMsg"), "O sistema está indisponível no momento. Tente de novo em instantes."); }
  await sincronizar();
  if (me.papel === "posto") entrarPosto(me.posto); else entrarAdmin(me);
}

/* =====================================================================
   PORTAL DO POSTO
   ===================================================================== */
let posto = null, meuIP = "";
// o IP vai só para o carimbo da foto; não aparece na tela do posto
async function atualizarIP(){ try { meuIP = (await api("/api/ip")).ip || ""; } catch {} return meuIP; }
// miniatura borrada (LGPD): reduz a foto a 16 px de largura e amplia de novo,
// assim rosto, placa e textos do carimbo ficam ilegíveis
async function miniBorrada(cvOrig){
  const pw = 16, ph = Math.max(1, Math.round(16 * cvOrig.height / cvOrig.width));
  const pq = document.createElement("canvas"); pq.width = pw; pq.height = ph;
  const c1 = pq.getContext("2d"); c1.imageSmoothingEnabled = true; c1.imageSmoothingQuality = "high";
  c1.drawImage(cvOrig, 0, 0, pw, ph);
  const W = 160, H = Math.round(160 * cvOrig.height / cvOrig.width);
  const gd = document.createElement("canvas"); gd.width = W; gd.height = H;
  const c2 = gd.getContext("2d"); c2.imageSmoothingEnabled = true; c2.imageSmoothingQuality = "high";
  c2.drawImage(pq, 0, 0, W, H);
  return await new Promise(r => gd.toBlob(r, "image/jpeg", 0.7));
}
setInterval(() => { if (posto && !$("#posto").hidden) atualizarIP(); }, 5 * 60 * 1000);
function entrarPosto(p){
  posto = p;
  $("#hNome").textContent = p.nome; $("#hCnpj").textContent = "CNPJ " + maskCNPJ(p.cnpj);
  limparTudo(); mostrar("#posto");
  ligarCamera();
  atualizarContagem();
  atualizarIP();
  // confirmação do envio anterior, guardada antes do recarregamento automático
  let ultimo = null; try { ultimo = sessionStorage.getItem("ultimoEnvio"); sessionStorage.removeItem("ultimoEnvio"); } catch {}
  if (ultimo) showMsg($("#capMsg"), "Último envio concluído. " + ultimo + " Pronto para o próximo abastecimento.", "ok");
}

/* Depois de um envio concluído, a página recarrega sozinha e fica pronta para o próximo abastecimento */
const SEGUNDOS_RECARGA = 4;
let recargaT = null;
function recarregar(){ clearInterval(recargaT); location.reload(); }
function envioConcluido(msg){
  try { sessionStorage.setItem("ultimoEnvio", msg); } catch {}
  pararCamera();
  $("#okMsg").textContent = msg;
  $("#okEnvio").hidden = false;
  let n = SEGUNDOS_RECARGA;
  const conta = () => { $("#okConta").textContent = `Preparando o próximo registro em ${n} s…`; };
  conta();
  recargaT = setInterval(() => { n--; if (n <= 0) recarregar(); else conta(); }, 1000);
  $("#okAgora").focus();
}
$("#okAgora").onclick = recarregar;

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
  mostraNF("wait","Anexe o PDF da nota (DANFE ou NFC-e). O sistema confere o número e o horário da nota (hora da saída).");
  showMsg($("#capMsg"), ""); mostraAlertaHorario(null);
  atualizaBotao();
}

/* ----- leitura do PDF da nota ----- */
if (window.pdfjsLib) pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
const { acharChave, acharNumeroImpresso, acharEmissao, destPorPosicao, destPorTexto } = window.LeituraNF;
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
  det.push(nf.emissao ? `Horário da nota: ${nf.emissao.texto} (${nf.emissao.fonte})` : "Horário da nota (hora da saída) não encontrado no PDF.");
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
  if (!nf.emissao) return { ok:false, tipo:"horario_nao_lido", titulo:"Não foi possível ler o horário da nota (hora da saída).", det:"Sem esse horário o sistema não consegue conferir a nota com a foto." };
  const dif = Math.abs(pendente.capturadoMs - nf.emissao.ms) / 60000;
  const difTxt = dif < 60 ? `${Math.round(dif)} min` : `${Math.floor(dif/60)} h ${Math.round(dif%60)} min`;
  if (dif > LIMITE_MIN) return { ok:false, tipo:"atraso", dif, titulo:`Diferença de ${difTxt} entre o horário da nota e a foto.`, det:`Nota: ${nf.emissao.texto} (${nf.emissao.fonte}). Foto: ${pendente.brasilia}. Limite: ${LIMITE_MIN} min.` };
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
  // o alerta leva a foto e o PDF, para a matriz abrir na aba Alertas
  const fd = new FormData();
  fd.append("foto", pendente.blob, "foto.jpg");
  if (nf.arquivo) fd.append("nf", nf.arquivo, "nota.pdf");
  fd.append("meta", JSON.stringify({
    tipo: v.tipo, nota: $("#fNota").value.trim() || nf.numero, cliente: $("#fCliente").value.trim(),
    emissao: nf.emissao ? nf.emissao.texto : null, emissaoFonte: nf.emissao ? nf.emissao.fonte : null,
    fotoEm: pendente.brasilia, fotoEmISO: new Date(pendente.capturadoMs).toISOString(), difMin: v.dif
  }));
  api("/api/alertas", { method:"POST", body: fd }).catch(() => alertasEnviados.delete(chave));
}

/* ----- captura com carimbo ----- */
function cortar(ctx, txt, max){ if (ctx.measureText(txt).width <= max) return txt; while (txt.length && ctx.measureText(txt+"…").width > max) txt = txt.slice(0,-1); return txt+"…"; }
$("#btnFoto").onclick = async () => {
  const cliente = $("#fCliente").value.trim(), nota = $("#fNota").value.trim();
  if (!stream || !video.videoWidth) return showMsg($("#capMsg"), "A câmera ainda não está pronta.");
  if (!cliente || !nota) return showMsg($("#capMsg"), "Preencha cliente/motorista e número da nota antes da foto.");
  try { await document.fonts.load("700 20px 'JetBrains Mono'"); } catch {}
  let local = null;
  if (posto.usa_local){
    showMsg($("#capMsg"), "Obtendo a localização…", "ok");
    try { local = await pegarLocal(30000); }
    catch (e) { return showMsg($("#capMsg"), e.message + " Sem a localização, a foto não pode ser registrada."); }
    showMsg($("#capMsg"), "");
  }
  const ip = await atualizarIP();
  const quando = agora(), p = brt(quando);
  const w = video.videoWidth, h = video.videoHeight;
  const cv = document.createElement("canvas"); cv.width = w; cv.height = h;
  const ctx = cv.getContext("2d"); ctx.drawImage(video, 0, 0, w, h);
  const fs = Math.max(14, Math.round(w/48)), lh = Math.round(fs*1.45), pad = Math.round(fs*.8);
  const linhas = [
    `${brtTexto(p)}  (Horário de Brasília)`,
    `Loja: ${posto.nome}  |  CNPJ: ${maskCNPJ(posto.cnpj)}`,
    `Cliente/Motorista: ${cliente}  |  Nota: ${nota}`,
    `IP: ${ip || "não identificado"}`
  ];
  if (local) linhas.push(`Local: ${local.lat.toFixed(6)}, ${local.lng.toFixed(6)}  (precisão ±${local.precisao} m)`);
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
  let mini = null; try { mini = await miniBorrada(cv); } catch {}
  if (pendente) URL.revokeObjectURL(pendente.url);
  pendente = { blob, mini, local, url: URL.createObjectURL(blob), capturadoMs: quando.getTime(), brasilia: brtTexto(p), nota, cliente, ip };
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
  if (pendente.mini) fd.append("mini", pendente.mini, "mini.jpg");
  fd.append("meta", JSON.stringify({
    cliente: pendente.cliente, nota: pendente.nota, capturadoEm: new Date(pendente.capturadoMs).toISOString(), ipCarimbo: pendente.ip || "", local: pendente.local || null,
    destNome, destDoc, destOrigem: editado ? "editado à mão" : "lido do PDF",
    nf: { numero: nf.numero, serie: nf.serie || "", modelo: nf.modelo || "", cnpjEmit: nf.cnpjEmit || "", emissaoMs: nf.emissao.ms, emissaoFonte: nf.emissao.fonte }
  }));
  $("#btnSalvar").disabled = true; showMsg($("#capMsg"), "Enviando…", "ok");
  try {
    const r = await api("/api/fotos", { method:"POST", body: fd });
    limparTudo();
    envioConcluido(`Salvo: ${r.arquivo} + ${r.arquivoNf}. Impressão digital (hash) da foto: ${String(r.hashFoto || "").slice(0, 16)}…`);
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
const curto = h => h ? h.slice(0, 12) + "…" : "";
let meusPoderes = {}, ehAdmin = false;
const tenho = p => ehAdmin || !!meusPoderes[p];
function abrirViewer(src, titulo, hash, protegido){
  const img = $("#viewImg");
  img.src = src;
  $("#viewName").textContent = titulo;
  $("#viewHash").textContent = hash ? `Hash SHA-256 da foto: ${hash}` : "";
  img.oncontextmenu = protegido ? (e => e.preventDefault()) : null;
  img.draggable = !protegido;
  $("#viewer").classList.toggle("protegido", !!protegido);
  $("#viewer").hidden = false;
}
function montaItem(f, ehMatriz){
  const el = document.createElement("div"); el.className = "item" + (ehMatriz ? "" : " item-posto");
  // posto: só a miniatura borrada (envios antigos, sem miniatura, mostram só o registro)
  const fig = ehMatriz ? `<img alt="" loading="lazy">`
    : f.tem_mini ? `<img class="mini-borrada" alt="Miniatura borrada" loading="lazy" draggable="false">`
    : `<div class="foto-ph" aria-hidden="true"><span>FOTO</span></div>`;
  el.innerHTML = `${fig}<div style="min-width:0"><div class="cli"></div><div class="when"></div><div class="meta"></div><div class="meta seg"></div><div class="row">${ehMatriz ? `<button data-a="ver">Ver foto</button>` : ""}</div></div>`;
  const src = `/api/fotos/${f.id}/foto`;
  if (ehMatriz) el.querySelector("img").src = src;
  else if (f.tem_mini){ const im = el.querySelector("img"); im.src = `/api/fotos/${f.id}/mini`; im.oncontextmenu = e => e.preventDefault(); }
  el.querySelector(".cli").textContent = f.dest_nome || f.cliente;
  el.querySelector(".when").textContent = f.capturado_txt;
  const meta = el.querySelector(".meta");
  if (ehMatriz){ const pc = document.createElement("span"); pc.className = "chip posto-chip"; pc.textContent = f.posto_nome || "Posto"; meta.appendChild(pc); }
  const partes = [`Nota ${f.nota}`];
  if (f.dest_doc) partes.push(`${f.dest_tipo === "PF" ? "CPF" : "CNPJ"} ${fmtDoc(f.dest_doc)}`);
  partes.push(`Motorista: ${f.cliente}`);
  meta.appendChild(document.createTextNode(partes.join(" · ")));
  const seg = el.querySelector(".seg");
  if (ehMatriz){
    const chip = document.createElement("span");
    if (f.verif_servidor && f.verif_servidor.startsWith("conferida")) { chip.className = "chip"; chip.textContent = "NF conferida no servidor"; }
    else if (f.verif_servidor) { chip.className = "chip aviso-chip"; chip.textContent = "NF não conferida no servidor"; }
    else { chip.className = "chip neutro"; chip.textContent = "Envio anterior à conferência no servidor"; }
    chip.title = [`Horário da nota ${f.nf_emissao || "?"}`, f.dif_min != null ? `diferença ${f.dif_min} min` : "", f.dest_origem === "editado à mão" ? "cliente corrigido à mão" : "", f.divergencia ? "Divergência: " + f.divergencia : ""].filter(Boolean).join(" · ");
    seg.appendChild(chip);
    const info = [];
    if (f.ip) info.push(`IP ${f.ip}`);
    if (f.dist_m != null) info.push(`${fmtDist(f.dist_m)} do posto`);
    if (f.hash_foto) info.push(`hash ${curto(f.hash_foto)}`);
    if (info.length) seg.appendChild(document.createTextNode(" " + info.join(" · ")));
    if (f.divergencia){ const d = document.createElement("div"); d.className = "diverg"; d.textContent = "⚠ " + f.divergencia; seg.appendChild(d); }
    if (f.hash_foto) seg.title = `Hash SHA-256 da foto: ${f.hash_foto}` + (f.hash_nf ? `\nHash SHA-256 da NF: ${f.hash_nf}` : "");
  } else seg.remove();
  if (ehMatriz){
    const ver = () => abrirViewer(src, f.arquivo, f.hash_foto, false);
    el.querySelector('[data-a="ver"]').onclick = ver;
    if (f.lat != null){ const am = aMapa(f.lat, f.lng); am.className = "btn"; am.title = `${f.lat}, ${f.lng}` + (f.precisao != null ? ` (precisão ±${f.precisao} m)` : ""); el.querySelector(".row").appendChild(am); }
    if (f.dist_m != null && f.dist_m > 500){ const d = document.createElement("div"); d.className = "diverg"; d.textContent = `⚠ Foto tirada a ${fmtDist(f.dist_m)} do local cadastrado do posto`; seg.appendChild(d); }
    el.querySelector("img").onclick = ver;
    if (tenho("baixar")){
      const row = el.querySelector(".row");
      const a1 = document.createElement("a"); a1.className = "btn"; a1.href = src + "?download=1"; a1.textContent = "Baixar foto"; row.appendChild(a1);
      const a2 = document.createElement("a"); a2.className = "btn"; a2.href = `/api/fotos/${f.id}/nf`; a2.textContent = "Baixar NF"; row.appendChild(a2);
    }
  }
  return el;
}
$("#viewClose").onclick = () => { $("#viewer").hidden = true; $("#viewImg").removeAttribute("src"); };
$("#viewImg").addEventListener("dragstart", e => { if ($("#viewer").classList.contains("protegido")) e.preventDefault(); });

/* =====================================================================
   PORTAL DA MATRIZ (admin e usuários da matriz, cada um com seus poderes)
   ===================================================================== */
function entrarAdmin(me){
  posto = null;
  ehAdmin = me.papel === "admin";
  meusPoderes = me.perms || {};
  const b = document.body.classList;
  b.toggle("nao-admin", !ehAdmin);
  ["baixar","alertas","postos","usuarios"].forEach(p => b.toggle("sem-" + p, !tenho(p)));
  const lista = { baixar:"baixar", alertas:"alertas", postos:"postos", usuarios:"usuários" };
  const tem = Object.keys(lista).filter(tenho).map(k => lista[k]);
  $("#aQuem").textContent = ehAdmin ? "Administrador" : `${me.nome || ""} · ${tem.length ? "pode: " + tem.join(", ") : "somente visualizar"}`;
  $("#avisoSenha").hidden = !me.senhaPadrao;
  mostrar("#admin"); abrirAba("fotos");
  carregarOpcoesAdmin().then(listarAdmin);
  if (tenho("alertas")) contarAlertas();
}
function abrirAba(aba){
  const permitido = { alertas: tenho("alertas"), usuarios: tenho("usuarios"), registros: ehAdmin };
  if (permitido[aba] === false) aba = "fotos";
  $$(".abas button").forEach(b => b.setAttribute("aria-selected", b.dataset.aba === aba));
  $$("[data-painel]").forEach(p => p.hidden = p.dataset.painel !== aba);
  if (aba === "alertas") listarAlertas();
  if (aba === "postos") listarPostos();
  if (aba === "usuarios") listarUsuarios();
  if (aba === "registros") listarRegistros();
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
    $("#aZip").disabled = !r.fotos.length; $("#aExcel").disabled = !r.total;
    $("#aZipInfo").textContent = r.fotos.length && tenho("baixar") ? `${r.fotos.length} fotos e ${r.fotos.length} notas no .zip` : "";
    lista.innerHTML = "";
    if (!r.fotos.length){ lista.innerHTML = `<div class="empty">${r.geral ? "Nenhuma foto com esses filtros." : "Nenhuma foto em nenhum posto ainda."}</div>`; return; }
    r.fotos.forEach(f => lista.appendChild(montaItem(f, true)));
  } catch (e) { showMsg($("#aMsg"), e.message); }
}
$("#aBusca").addEventListener("input", debounce(listarAdmin));
["#aPosto","#aCli","#aTipo","#aDe","#aAte"].forEach(s => $(s).addEventListener("change", listarAdmin));
$("#aLimpar").onclick = () => { ["#aBusca","#aPosto","#aCli","#aTipo","#aDe","#aAte"].forEach(s => $(s).value = ""); listarAdmin(); };

function baixarBlob(blob, nome){
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = nome;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
const carimboArquivo = () => { const p = brt(agora()); return `${p.year}-${p.month}-${p.day}_${p.hour}-${p.minute}-${p.second}`; };

$("#aZip").onclick = async () => {
  const fotos = ultimaListaAdmin;
  if (!fotos.length || !tenho("baixar")) return;
  if (!window.JSZip) return showMsg($("#aMsg"), "Não foi possível montar o .zip agora. Recarregue a página.");
  const btn = $("#aZip"); btn.disabled = true;
  const lote = Date.now().toString(36) + Math.random().toString(36).slice(2, 8); // agrupa o .zip num único registro de ação
  try {
    const z = new JSZip();
    for (let i = 0; i < fotos.length; i++){
      const f = fotos[i];
      showMsg($("#aMsg"), `Montando o .zip: ${i+1} de ${fotos.length}…`, "ok");
      const pasta = `${normCNPJ(f.posto_cnpj || "")}_${(f.posto_nome || "posto").replace(/[\\/:*?"<>|]+/g,"-")}/`;
      const [rf, rn] = await Promise.all([fetch(`/api/fotos/${f.id}/foto?download=1&lote=${lote}`, { credentials:"same-origin" }), fetch(`/api/fotos/${f.id}/nf?lote=${lote}`, { credentials:"same-origin" })]);
      if (rf.ok) z.file(pasta + f.arquivo, await rf.blob());
      if (rn.ok) z.file(pasta + f.arquivo_nf, await rn.blob());
    }
    baixarBlob(await z.generateAsync({ type:"blob" }), `fotos_matriz_${carimboArquivo()}.zip`);
    showMsg($("#aMsg"), "Arquivo .zip gerado.", "ok");
  } catch (e) { showMsg($("#aMsg"), "Não foi possível gerar o .zip agora. Tente de novo."); }
  finally { btn.disabled = false; }
};

/* ----- relatório Excel (respeita os filtros) ----- */
$("#aExcel").onclick = async () => {
  if (!tenho("baixar")) return;
  if (!window.XLSX) return showMsg($("#aMsg"), "O gerador de Excel não carregou. Recarregue a página.");
  const btn = $("#aExcel"); btn.disabled = true; showMsg($("#aMsg"), "Gerando o relatório…", "ok");
  try {
    const q = filtrosAdmin(); q.set("relatorio", "1"); q.set("limite", "20000");
    const r = await api("/api/fotos?" + q);
    const linhas = r.fotos.map(f => ({
      "Data/hora da foto (Brasília)": f.capturado_txt,
      "Posto": f.posto_nome || "", "CNPJ do posto": maskCNPJ(f.posto_cnpj || ""),
      "Nota": f.nota, "Série": f.nf_serie || "", "Modelo": f.nf_modelo || "",
      "Motorista / cliente informado": f.cliente,
      "Cliente da nota": f.dest_nome || "", "CNPJ/CPF do cliente": fmtDoc(f.dest_doc || ""),
      "Tipo de cliente": f.dest_tipo === "PJ" ? "Pessoa jurídica" : f.dest_tipo === "PF" ? "Pessoa física" : "Não identificado",
      "Cliente corrigido à mão": f.dest_origem === "editado à mão" ? "Sim" : "Não",
      "Horário da nota": f.nf_emissao || "", "Origem do horário": f.nf_emissao_fonte || "",
      "Diferença nota x foto (min)": f.dif_min,
      "Conferência no servidor": f.verif_servidor || "anterior à conferência no servidor",
      "Divergências": f.divergencia || "",
      "IP do envio": f.ip || "", "IP no carimbo": f.ip_carimbo || "",
      "Latitude": f.lat ?? "", "Longitude": f.lng ?? "", "Precisão da localização (m)": f.precisao ?? "",
      "Distância do posto (m)": f.dist_m ?? "", "Mapa": f.lat != null ? linkMapa(f.lat, f.lng) : "",
      "Hash SHA-256 da foto": f.hash_foto || "", "Hash SHA-256 da NF": f.hash_nf || "",
      "Chave de acesso": f.nf_chave || "", "CNPJ emitente": maskCNPJ(f.nf_cnpj_emit || ""),
      "Arquivo da foto": f.arquivo, "Arquivo da NF": f.arquivo_nf
    }));
    const ws = XLSX.utils.json_to_sheet(linhas);
    ws["!cols"] = Object.keys(linhas[0] || {}).map(k => ({ wch: Math.min(60, Math.max(12, k.length + 2)) }));
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "Autenticações");
    const filtros = [["Gerado em (Brasília)", brtTexto(brt(agora()))], ["Registros", String(linhas.length)]];
    [["Posto","#aPosto"],["Cliente","#aCli"],["Tipo de cliente","#aTipo"],["Data de","#aDe"],["Data até","#aAte"],["Busca","#aBusca"]].forEach(([n,s]) => { const el = $(s); const v = el.tagName === "SELECT" ? (el.value ? el.options[el.selectedIndex].text : "") : el.value; if (v) filtros.push([n, v]); });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Filtro", "Valor"], ...filtros]), "Filtros");
    const out = XLSX.write(wb, { bookType:"xlsx", type:"array" });
    baixarBlob(new Blob([out], { type:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), `relatorio_foto_abastecimento_${carimboArquivo()}.xlsx`);
    showMsg($("#aMsg"), `Relatório gerado com ${linhas.length} registro(s).`, "ok");
  } catch (e) { showMsg($("#aMsg"), e.message || "Não foi possível gerar o relatório agora."); }
  finally { btn.disabled = false; }
};

/* ----- alertas + farol de IP ----- */
async function contarAlertas(){
  if (!tenho("alertas")) return;
  try { const r = await api("/api/alertas"); atualizarBadge(r); } catch {}
}
function atualizarBadge(r){
  const vermelhos = (r.semaforo || []).filter(x => x.cor === "vermelho" || (x.local && x.local.cor === "vermelho")).length;
  const n = r.abertos; $("#nAlertas").textContent = n || (vermelhos ? "!" : 0); $("#nAlertas").hidden = !n && !vermelhos;
}
setInterval(() => { if (!$("#admin").hidden) contarAlertas(); }, 60000);
async function listarAlertas(){
  const lista = $("#alLista"), sem = $("#semLista");
  try {
    const r = await api("/api/alertas" + ($("#alTodos").checked ? "?todos=1" : ""));
    atualizarBadge(r);
    sem.innerHTML = "";
    if (!r.semaforo.length) sem.innerHTML = `<div class="empty">Nenhum posto cadastrado.</div>`;
    r.semaforo.forEach(x => {
      const el = document.createElement("div"); el.className = "sem";
      el.innerHTML = `<span class="luz"></span><div style="min-width:0"><b class="pn"></b><div class="hint tx"></div><div class="mono hint ips"></div></div>
        <span class="luz loc"></span><div style="min-width:0"><div class="hint txl"></div><div class="mono hint locs"></div></div>`;
      el.querySelector(".luz").className = "luz " + x.cor;
      el.querySelector(".luz").title = x.cor === "verde" ? "Sem alteração de IP" : x.cor === "vermelho" ? "IP alterado" : "Histórico insuficiente";
      el.querySelector(".pn").textContent = `${x.posto_nome} · CNPJ ${maskCNPJ(x.posto_cnpj)}`;
      el.querySelector(".tx").textContent = x.texto;
      el.querySelector(".ips").textContent = (x.logins || []).map(e => `${e.ip} (${e.quando})`).join("  ·  ");
      const lc = x.local || { cor: "cinza", texto: "", registros: [] };
      el.querySelector(".luz.loc").className = "luz loc " + lc.cor;
      el.querySelector(".luz.loc").title = lc.cor === "verde" ? "Dentro de 500 m do posto" : lc.cor === "vermelho" ? "Fora de 500 m do posto" : "Sem dados de localização";
      el.querySelector(".txl").textContent = "Localização: " + lc.texto;
      const locs = el.querySelector(".locs");
      if (lc.lat != null){ locs.appendChild(aMapa(lc.lat, lc.lng, "local do posto")); }
      (lc.registros || []).forEach(g => {
        locs.appendChild(document.createTextNode("  ·  "));
        locs.appendChild(aMapa(g.lat, g.lng, `${g.origem} ${g.quando}${g.dist_m != null ? ` a ${fmtDist(g.dist_m)}` : ""}`));
      });
      sem.appendChild(el);
    });
    lista.innerHTML = "";
    if (!r.alertas.length){ lista.innerHTML = `<div class="empty">Nenhum alerta ${$("#alTodos").checked ? "registrado" : "em aberto"}.</div>`; return; }
    r.alertas.forEach(a => {
      const ehIP = a.tipo === "ip_alterado" || a.tipo === "ip_login" || a.tipo === "local_login" || a.tipo === "local_envio";
      const el = document.createElement("div"); el.className = "al" + (a.visto ? " visto" : "") + (ehIP ? " ip" : "");
      el.innerHTML = `<div class="al-corpo"><div class="al-texto"><div class="row" style="justify-content:space-between"><div><span class="chip erro"></span> <b class="pn"></b></div><span class="mono hint quando"></span></div><div class="det d1"></div><div class="det d2"></div><div class="det d3"></div><div class="row acoes"></div></div></div>`;
      el.querySelector(".chip").textContent = a.tipo_txt;
      el.querySelector(".pn").textContent = a.posto_nome ? `${a.posto_nome} · CNPJ ${maskCNPJ(a.posto_cnpj || "")}` : "Matriz";
      el.querySelector(".quando").textContent = "Registrado em " + brtTexto(brt(new Date(a.criado_em)));
      el.querySelector(".d1").textContent = a.tipo === "ip_login" || a.tipo === "local_login" ? "Login do posto" : a.tipo === "bloqueio" ? "Tentativas de login" : `Nota ${a.nota || "?"} · Motorista: ${a.cliente || "?"} · Foto: ${a.foto_em || "?"}`;
      el.querySelector(".d2").textContent = a.tipo === "atraso"
        ? `Horário da nota ${a.emissao || "?"} · Diferença ${a.dif_min != null ? a.dif_min + " min" : "?"}${a.emissao_fonte ? " (" + a.emissao_fonte + ")" : ""}`
        : a.tipo === "ip_login" ? `IP do login anterior ${a.ip_anterior || "?"} → IP deste login ${a.ip || "?"} (acesso liberado)`
        : a.tipo === "ip_alterado" ? `IP anterior ${a.ip_anterior || "?"} → IP deste envio ${a.ip || "?"} (envio aceito)`
        : a.tipo === "bloqueio" ? (a.detalhe || "Conta bloqueada por senhas erradas.")
        : a.tipo === "local_login" || a.tipo === "local_envio" ? (a.detalhe || `A ${fmtDist(a.dist_m)} do local cadastrado do posto`) + (a.ip ? ` · IP ${a.ip}` : "")
        : "Horário da nota (hora da saída) não encontrado no PDF";
      el.querySelector(".d3").textContent = [a.ip && !ehIP && a.tipo !== "bloqueio" ? `IP ${a.ip}` : "", a.hash_foto ? `hash da foto ${curto(a.hash_foto)}` : ""].filter(Boolean).join(" · ");
      if (a.hash_foto) el.querySelector(".d3").title = `Hash SHA-256 da foto: ${a.hash_foto}` + (a.hash_nf ? `\nHash SHA-256 da NF: ${a.hash_nf}` : "");
      const acoes = el.querySelector(".acoes");
      if (a.lat != null){ const am = aMapa(a.lat, a.lng); am.className = "btn"; acoes.appendChild(am); }
      if (a.tem_foto){
        const img = document.createElement("img"); img.className = "al-img"; img.alt = "Foto da tentativa"; img.loading = "lazy"; img.src = `/api/alertas/${a.id}/foto`;
        const abrir = () => abrirViewer(img.src, `Alerta · ${a.posto_nome || ""} · nota ${a.nota || "?"} · ${a.foto_em || ""}`, a.hash_foto, false);
        img.onclick = abrir;
        el.querySelector(".al-corpo").prepend(img);
        const bv = document.createElement("button"); bv.textContent = "Ver foto"; bv.onclick = abrir; acoes.appendChild(bv);
        if (r.podeBaixar){ const bf = document.createElement("a"); bf.className = "btn"; bf.href = `/api/alertas/${a.id}/foto?download=1`; bf.textContent = "Baixar foto"; acoes.appendChild(bf); }
      }
      if (a.tem_nf && r.podeBaixar){ const bn = document.createElement("a"); bn.className = "btn"; bn.href = `/api/alertas/${a.id}/nf`; bn.textContent = "Baixar NF"; acoes.appendChild(bn); }
      if (a.visto){ const s = document.createElement("span"); s.className = "hint"; s.textContent = "Visto em " + brtTexto(brt(new Date(a.visto_em))); acoes.appendChild(s); }
      else if (r.podeMarcar){ const b = document.createElement("button"); b.textContent = "Marcar como visto"; b.onclick = async () => { b.disabled = true; try { await api(`/api/alertas/${a.id}`, { method:"PUT", body:{ visto:true } }); listarAlertas(); } catch (e) { b.disabled = false; alertaErro(acoes, e.message); } }; acoes.appendChild(b); }
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
    await api("/api/postos", { method:"POST", body:{ cnpj, nome, senha, lat: $("#nLat").value, lng: $("#nLng").value, usa_local: $("#nUsaLocal").checked } });
    $("#nCnpj").value = ""; $("#nNome").value = ""; $("#nSenha").value = ""; $("#nLat").value = ""; $("#nLng").value = ""; $("#nUsaLocal").checked = false;
    showMsg($("#nMsg"), `“${nome}” cadastrado. O posto já pode entrar com o CNPJ e a senha.`, "ok");
    listarPostos();
  } catch (err) { showMsg($("#nMsg"), err.message); }
});
/* colar "-23.55, -46.63" (como o Google Maps copia) no campo latitude preenche os dois campos */
function colarCoordenadas(iLat, iLng){
  iLat.addEventListener("paste", e => {
    const t = (e.clipboardData || window.clipboardData).getData("text");
    const m = t.match(/(-?\d{1,2}[.,]\d+)\s*[,;\s]\s*(-?\d{1,3}[.,]\d+)/);
    if (m){ e.preventDefault(); iLat.value = m[1].replace(",", "."); iLng.value = m[2].replace(",", "."); }
  });
}
colarCoordenadas($("#nLat"), $("#nLng"));
async function listarPostos(){
  const box = $("#psLista");
  try {
    const r = await api("/api/postos");
    box.innerHTML = "";
    if (!r.postos.length){ box.innerHTML = `<div class="empty">Nenhum posto cadastrado.${r.podeAlterar ? " Use o formulário acima." : ""}</div>`; return; }
    r.postos.forEach(p => box.appendChild(montaPosto(p, r.podeAlterar)));
  } catch (e) { box.innerHTML = ""; alertaErro(box, e.message); }
}
function montaPosto(p, podeAlterar){
  const el = document.createElement("div"); el.className = "posto";
  el.innerHTML = `
    <div class="row" style="justify-content:space-between"><div><b class="pn"></b><div class="mono hint pc"></div><div class="bloq" hidden></div></div><div class="row"><button data-a="desbloquear" hidden>Desbloquear</button><button data-a="editar">Editar posto</button></div></div>
    <div class="stack ed" hidden>
      <div class="fields"><div><label>CNPJ do posto</label><input class="mono e-cnpj"></div><div><label>Nome do posto</label><input class="e-nome" maxlength="60"></div></div>
      <div class="fields3"><div><label>Latitude</label><input class="mono e-lat" inputmode="decimal" placeholder="-23.550520"></div><div><label>Longitude</label><input class="mono e-lng" inputmode="decimal" placeholder="-46.633308"></div>
        <div style="align-self:end"><label class="check"><input type="checkbox" class="e-usa"> Usa controle de localização</label></div></div>
      <div class="row"><button class="primary" data-a="salvar">Salvar alterações</button><button data-a="cancelar">Cancelar</button></div>
      <span class="hint">As fotos e alertas continuam vinculados a este posto. O posto passa a entrar com o CNPJ novo.</span>
    </div>
    <div class="row l-senha"><input type="text" placeholder="Nova senha" aria-label="Nova senha" autocomplete="off" class="e-senha"><button data-a="senha">Alterar senha</button></div>
    <div class="msg" hidden></div>`;
  el.querySelector(".pn").textContent = p.nome;
  el.querySelector(".pc").textContent = `CNPJ ${maskCNPJ(p.cnpj)} · ${p.fotos} ${p.fotos===1?"foto":"fotos"}` + (p.alertas ? ` · ${p.alertas} alerta(s) em aberto` : "")
    + (p.ultimo_login_txt ? ` · último login ${p.ultimo_login_txt} (IP ${p.ultimo_ip})` : " · ainda não fez login");
  if (p.bloqueado_ate_txt){ const b = el.querySelector(".bloq"); b.hidden = false; b.textContent = `Bloqueado por senhas erradas até ${p.bloqueado_ate_txt}`; }
  const lc = document.createElement("div"); lc.className = "mono hint";
  lc.textContent = (p.usa_local ? "Controle de localização ligado" : "Controle de localização desligado") + (p.lat != null ? ` · local ${p.lat}, ${p.lng} · ` : " · local não cadastrado");
  if (p.lat != null) lc.appendChild(aMapa(p.lat, p.lng));
  el.querySelector(".pc").after(lc);
  if (!podeAlterar){ el.querySelector('[data-a="editar"]').remove(); el.querySelector('[data-a="desbloquear"]').remove(); el.querySelector(".l-senha").remove(); return el; }
  const msg = el.querySelector(".msg"), ed = el.querySelector(".ed");
  const iC = el.querySelector(".e-cnpj"), iN = el.querySelector(".e-nome");
  const bD = el.querySelector('[data-a="desbloquear"]'); bD.hidden = !p.bloqueado_ate_txt;
  bD.onclick = async () => { try { await api(`/api/postos/${p.id}/desbloquear`, { method:"PUT", body:{} }); listarPostos(); } catch (e) { showMsg(msg, e.message); } };
  iC.addEventListener("input", () => { iC.value = maskCNPJ(iC.value); });
  const iLat = el.querySelector(".e-lat"), iLng = el.querySelector(".e-lng"), iUsa = el.querySelector(".e-usa");
  colarCoordenadas(iLat, iLng);
  el.querySelector('[data-a="editar"]').onclick = () => { iC.value = maskCNPJ(p.cnpj); iN.value = p.nome; iLat.value = p.lat ?? ""; iLng.value = p.lng ?? ""; iUsa.checked = !!p.usa_local; ed.hidden = false; showMsg(msg, ""); };
  el.querySelector('[data-a="cancelar"]').onclick = () => { ed.hidden = true; };
  el.querySelector('[data-a="salvar"]').onclick = async () => {
    if (!validCNPJ(iC.value)) return showMsg(msg, "CNPJ inválido. Confira os dígitos.");
    try { await api(`/api/postos/${p.id}`, { method:"PUT", body:{ cnpj: iC.value, nome: iN.value, lat: iLat.value, lng: iLng.value, usa_local: iUsa.checked } }); listarPostos(); carregarOpcoesAdmin(); }
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

/* ----- usuários da matriz e seus poderes ----- */
const NOMES_PODERES = { baixar: "Baixar fotos, notas e relatórios", alertas: "Ver alertas e farol de IP", postos: "Alterar postos", usuarios: "Alterar usuários da matriz" };
function caixasPoderes(alvo, marcados, desabilitar){
  alvo.innerHTML = "";
  Object.keys(NOMES_PODERES).forEach(k => {
    const l = document.createElement("label"); l.className = "check poder";
    const c = document.createElement("input"); c.type = "checkbox"; c.value = k; c.checked = !!marcados[k];
    c.disabled = !!desabilitar || !tenho(k);
    if (!tenho(k)) l.title = "Você não tem este poder, então não pode concedê-lo.";
    l.appendChild(c); l.appendChild(document.createTextNode(" " + NOMES_PODERES[k])); alvo.appendChild(l);
  });
}
const lerCaixas = alvo => Object.fromEntries([...alvo.querySelectorAll("input[type=checkbox]")].map(c => [c.value, c.checked]));
const resumoPoderes = p => { const l = Object.keys(NOMES_PODERES).filter(k => p[k]).map(k => NOMES_PODERES[k]); return l.length ? l.join(" · ") : "Somente visualizar fotos e postos"; };

$("#fNovoUsuario").addEventListener("submit", async e => {
  e.preventDefault();
  const usuario = $("#uUsuario").value.trim().toLowerCase(), nome = $("#uNome").value.trim(), senha = $("#uSenha").value;
  try {
    await api("/api/usuarios", { method:"POST", body:{ usuario, nome, senha, perms: lerCaixas($("#uPoderes")) } });
    $("#uUsuario").value = ""; $("#uNome").value = ""; $("#uSenha").value = ""; caixasPoderes($("#uPoderes"), {});
    showMsg($("#uMsg"), `Usuário “${usuario}” criado. Ele entra pela mesma tela de login, com esse usuário e a senha.`, "ok");
    listarUsuarios();
  } catch (err) { showMsg($("#uMsg"), err.message); }
});
async function listarUsuarios(){
  const box = $("#usLista");
  if (!$("#uPoderes").children.length) caixasPoderes($("#uPoderes"), {});
  try {
    const r = await api("/api/usuarios");
    box.innerHTML = "";
    if (!r.usuarios.length){ box.innerHTML = `<div class="empty">Nenhum usuário da matriz. Use o formulário acima.</div>`; return; }
    r.usuarios.forEach(u => {
      const el = document.createElement("div"); el.className = "posto" + (u.ativo ? "" : " inativo");
      el.innerHTML = `
        <div class="row" style="justify-content:space-between"><div><b class="pn"></b><div class="mono hint pc"></div><div class="hint pd"></div><div class="bloq" hidden></div></div><div class="row"><button data-a="desbloquear" hidden>Desbloquear</button><button data-a="ativo"></button></div></div>
        <div class="poderes"></div>
        <div class="row"><input type="text" class="e-nome" maxlength="60" aria-label="Nome"><button data-a="salvar">Salvar nome e poderes</button></div>
        <div class="row"><input type="text" placeholder="Nova senha" aria-label="Nova senha" autocomplete="off" class="e-senha"><button data-a="senha">Alterar senha</button></div>
        <div class="msg" hidden></div>`;
      el.querySelector(".pn").textContent = u.nome + (u.ativo ? "" : " (desativado)") + (u.eu ? " (você)" : "");
      el.querySelector(".pc").textContent = `Usuário: ${u.usuario} · criado em ${brtTexto(brt(new Date(u.criado_em)))}`;
      el.querySelector(".pd").textContent = "Poderes: " + resumoPoderes(u.perms);
      if (u.bloqueado_ate_txt){ const b = el.querySelector(".bloq"); b.hidden = false; b.textContent = `Bloqueado por senhas erradas até ${u.bloqueado_ate_txt}`; }
      const msg = el.querySelector(".msg"), iN = el.querySelector(".e-nome"); iN.value = u.nome;
      // quem tem poderes que eu não tenho (ou eu mesmo) só pode ser alterado pelo admin
      const travado = !ehAdmin && (u.eu || Object.keys(u.perms).some(k => u.perms[k] && !tenho(k)));
      caixasPoderes(el.querySelector(".poderes"), u.perms, travado);
      if (travado){
        el.querySelectorAll("button, input").forEach(x => x.disabled = true);
        showMsg(msg, u.eu ? "Para alterar o seu próprio usuário, fale com o administrador." : "Este usuário tem poderes que você não tem; só o administrador pode alterá-lo.", "ok");
        box.appendChild(el); return;
      }
      const bD = el.querySelector('[data-a="desbloquear"]'); bD.hidden = !u.bloqueado_ate_txt;
      bD.onclick = async () => { try { await api(`/api/usuarios/${u.id}/desbloquear`, { method:"PUT", body:{} }); listarUsuarios(); } catch (e) { showMsg(msg, e.message); } };
      const bA = el.querySelector('[data-a="ativo"]'); bA.textContent = u.ativo ? "Desativar" : "Reativar";
      bA.onclick = async () => { try { await api(`/api/usuarios/${u.id}`, { method:"PUT", body:{ nome: u.nome, ativo: !u.ativo } }); listarUsuarios(); } catch (e) { showMsg(msg, e.message); } };
      el.querySelector('[data-a="salvar"]').onclick = async () => { try { await api(`/api/usuarios/${u.id}`, { method:"PUT", body:{ nome: iN.value, ativo: !!u.ativo, perms: lerCaixas(el.querySelector(".poderes")) } }); listarUsuarios(); } catch (e) { showMsg(msg, e.message); } };
      el.querySelector('[data-a="senha"]').onclick = async () => {
        const s = el.querySelector(".e-senha");
        if (s.value.length < 6) return showMsg(msg, "A senha precisa ter pelo menos 6 caracteres.");
        try { await api(`/api/usuarios/${u.id}/senha`, { method:"PUT", body:{ senha: s.value } }); s.value = ""; showMsg(msg, "Senha alterada. O usuário precisa entrar de novo.", "ok"); }
        catch (e) { showMsg(msg, e.message); }
      };
      box.appendChild(el);
    });
  } catch (e) { box.innerHTML = ""; alertaErro(box, e.message); }
}

/* ----- registro de ações (só o admin) ----- */
async function listarRegistros(){
  if (!ehAdmin) return;
  const lista = $("#rgLista");
  const q = new URLSearchParams();
  [["quem","#rgQuem"],["tipo","#rgTipo"],["de","#rgDe"],["ate","#rgAte"]].forEach(([k,s]) => { const v = $(s).value; if (v) q.set(k, v); });
  try {
    const r = await api("/api/registros?" + q);
    const opc = [["admin","Administrador"],["matriz","Todos os usuários da matriz"],...r.usuarios.map(u => ["u:" + u.id, `Matriz · ${u.nome} (${u.usuario})`]),["postos","Todos os postos"],...r.postos.map(p => ["p:" + p.id, `Posto · ${p.nome}`]),["sistema","Sistema (bloqueios)"]];
    preencheSelect($("#rgQuem"), opc);
    $("#rgCount").textContent = r.total === r.registros.length ? `${r.total} registro(s)` : `${r.registros.length} de ${r.total} registros (os mais recentes)`;
    lista.innerHTML = "";
    if (!r.registros.length){ lista.innerHTML = `<div class="empty">Nenhuma ação registrada com esses filtros.</div>`; return; }
    const tab = document.createElement("div"); tab.className = "rg-tabela";
    tab.innerHTML = `<table><thead><tr><th>Quando (Brasília)</th><th>Quem</th><th>Ação</th><th>Detalhe</th><th>IP</th></tr></thead><tbody></tbody></table>`;
    const tb = tab.querySelector("tbody");
    r.registros.forEach(x => {
      const tr = document.createElement("tr"); tr.className = "rg-" + x.ator_tipo;
      [x.quando, x.ator_nome || x.ator_tipo, x.acao_txt, x.descricao || "", x.ip || ""].forEach((v, i) => { const td = document.createElement("td"); td.textContent = v; if (i === 0 || i === 4) td.className = "mono"; tr.appendChild(td); });
      tb.appendChild(tr);
    });
    lista.appendChild(tab);
  } catch (e) { lista.innerHTML = ""; alertaErro(lista, e.message); }
}
["#rgQuem","#rgTipo","#rgDe","#rgAte"].forEach(s => $(s).addEventListener("change", listarRegistros));
$("#rgAtualizar").onclick = listarRegistros;

/* ---------- início ---------- */
iniciar();
