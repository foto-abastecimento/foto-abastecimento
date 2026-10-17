/* Foto Abastecimento — leitura da nota fiscal (DANFE / NFC-e).
   O MESMO arquivo é usado na tela (navegador) e no servidor (Node), para as duas leituras seguirem as mesmas regras.
   No navegador vira window.NFLeitura; no servidor, globalThis.NFLeitura. */
(function (raiz) {
"use strict";
const soDig = s => String(s || "").replace(/\D/g, "");
const numInt = s => { const d = soDig(s).replace(/^0+/, ""); return d || (soDig(s) ? "0" : ""); };
const normCNPJ = s => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 14);
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
/* Horário da nota: campo HORA DA SAÍDA do DANFE (data da saída, ou da emissão se a da saída estiver vazia).
   O valor fica logo abaixo do rótulo, na mesma coluna; só aceita um horário válido (hh:mm ou hh:mm:ss). */
const RE_ROT_HSAIDA = /HORA\s+(?:D[AE]\s+)?SA\S{0,3}DA/i;
const RE_ROT_DSAIDA = /DATA\s+(?:D[AE]\s+)?SA\S{0,3}DA/i;
const RE_ROT_DEMIS = /DATA\s+(?:D[AE]\s+)?EMISS/i;
function valorNaColuna(itens, re, padrao){
  const pg = itens.filter(i => i.p === 1);
  for (const rot of pg.filter(i => re.test(i.s))){
    const centro = rot.x + rot.w/2, folga = Math.max(40, rot.w);
    const cand = pg.filter(i => i !== rot && i.y < rot.y - 0.5 && rot.y - i.y <= Math.max(22, rot.h*4) && Math.abs(i.x + i.w/2 - centro) <= folga && padrao.test(i.s))
      .sort((a,b) => (b.y - a.y) || (Math.abs(a.x+a.w/2-centro) - Math.abs(b.x+b.w/2-centro)));
    if (cand.length) return cand[0].s.match(padrao);
  }
  return null;
}
function horaValida(h, mi, s){ return +h <= 23 && +mi <= 59 && (s === undefined || +s <= 59); }
function acharHoraSaida(texto, itens){
  const t = texto.replace(/\s+/g," ");
  const RE_H = /(\d{2}):(\d{2})(?::(\d{2}))?/, RE_D = /(\d{2})\/(\d{2})\/(\d{4})/;
  let h = valorNaColuna(itens, RE_ROT_HSAIDA, RE_H);
  if (!h){ const m = t.match(/HORA\s+(?:D[AE]\s+)?SA\S{0,3}DA\s*:?\s*(\d{2}):(\d{2})(?::(\d{2}))?/i); if (m) h = m; }
  if (!h || !horaValida(h[1], h[2], h[3])) return null;
  let d = valorNaColuna(itens, RE_ROT_DSAIDA, RE_D) || valorNaColuna(itens, RE_ROT_DEMIS, RE_D);
  if (!d) d = t.match(/DATA\s+(?:D[AE]\s+)?SA\S{0,3}DA(?:\s*\/\s*ENTRADA)?\s*:?\s*(\d{2})\/(\d{2})\/(\d{4})/i) || t.match(/EMISS[ÃA]O[^\d]{0,40}?(\d{2})\/(\d{2})\/(\d{4})/i);
  if (!d) return null;
  const r = montaData(d[1], d[2], d[3], h[1], h[2], h[3]);
  return r ? { ...r, fonte: "hora da saída" } : null;
}
function acharEmissao(texto, itens){
  // 1º: HORA DA SAÍDA do DANFE (regra definida pela matriz)
  const saida = acharHoraSaida(texto, itens);
  if (saida) return saida;
  // reservas: notas sem esse campo preenchido (ex.: NFC-e)
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


/* Extrai texto e posições do PDF. pdfjs = biblioteca pdf.js (navegador ou Node); dados = Uint8Array. */
async function lerPDF(pdfjs, dados, opcoes){
  const pdf = await pdfjs.getDocument({ data: dados, isEvalSupported: false, disableFontFace: true, useSystemFonts: false, ...(opcoes || {}) }).promise;
  let texto = ""; const itens = [];
  try {
    for (let i = 1; i <= Math.min(pdf.numPages, 3); i++){
      const pg = await pdf.getPage(i); const tc = await pg.getTextContent();
      texto += tc.items.map(x => x.str).join(" ") + "\n";
      tc.items.forEach(it => {
        if (!it.str || !it.str.trim()) return;
        const [a, b, c, d, e, f] = it.transform;
        itens.push({ s: it.str.trim(), x: e, y: f, w: it.width || 0, h: it.height || Math.hypot(c, d) || 8, p: i });
      });
    }
  } finally { try { await pdf.destroy(); } catch (_) {} }
  return { texto, itens };
}

/* Interpreta o conteúdo da nota. Devolve null se não achar o número. */
function analisar(texto, itens){
  const chave = acharChave(texto);
  let info = null;
  if (chave) info = { numero: numInt(chave.slice(25,34)), serie: numInt(chave.slice(22,25)), modelo: chave.slice(20,22)==="65" ? "NFC-e" : "NF-e", cnpjEmit: chave.slice(6,20), chave, origem: "chave de acesso" };
  else { const n = acharNumeroImpresso(texto); if (n) info = { numero: numInt(n), origem: "número impresso no documento" }; }
  if (!info) return { semTexto: !texto.trim() };
  const emissao = acharEmissao(texto, itens);
  const pos = destPorPosicao(itens, info.cnpjEmit || ""), txt = destPorTexto(texto, info.cnpjEmit || "");
  const dest = pos ? { nome: pos.nome || (txt && txt.nome) || "", doc: pos.doc || (txt && txt.doc) || "" } : (txt || { nome: "", doc: "" });
  return { ...info, emissao, dest };
}

raiz.NFLeitura = { lerPDF, analisar, validCNPJ, validCPF, normCNPJ, soDig, numInt };
})(typeof window !== "undefined" ? window : globalThis);
