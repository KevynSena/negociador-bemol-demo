import { spawn } from "node:child_process";
import nodePath from "node:path";
import { inflateSync } from "node:zlib";
import { NextRequest, NextResponse } from "next/server";
import { buildDemoSimulation, isDemoRequest } from "@/lib/demo-data";
import { getBoletoAcordo, getOpcoesNegociacao, getToken } from "@/lib/nectar/client";
import type { NectarContract, NectarNegotiationOption } from "@/lib/nectar/types";
import { extractTagValue, parseMoney } from "@/lib/nectar/xml";


type SimulatePayload = {
  contracts: NectarContract[];
  cnpjcpf?: string;
  vencPrimParcela: string;
  parcelasPreferidas: number;
  tiponegociacao?: string;
  tpDesconto?: string;
  debugBoleto?: boolean;
  emitAllOpenTitles?: boolean;
  selectedTitleIdsByContract?: Record<string, string[]>;
};

type SimulationRow = {
  contract: NectarContract;
  selectedOption: NectarNegotiationOption | null;
  aVistaOption: NectarNegotiationOption | null;
  rawOptions: NectarNegotiationOption[];
  processingMode: "titulo" | "negociacao";
  pendingTitlesSummary?: string;
  pendingTitlesCount?: number;
  pendingTitlesUnitValue?: number;
  pendingTitlesTotal?: number;
  overdueTitlesCount?: number;
  selectedTitleIds?: string[];
  boletoDebug?: Array<{
    idTra: string;
    linhaDigitavel: string | null;
    valorResolvido: number;
    origemValor: string;
    etapas?: BoletoValueTrace;
  }>;
};

type CachedSimulationEntry = {
  dayKey: string;
  value: SimulationRow;
};

const SIMULATION_CONCURRENCY_LIMIT = 3;
const MIN_INSTALLMENT_VALUE = 50;
const simulationCache = new Map<string, CachedSimulationEntry>();

function selectBestOption(options: NectarNegotiationOption[], parcelasPreferidas: number): NectarNegotiationOption | null {
  if (options.length === 0) return null;
  const exact = options.find((item) => item.parcelasNum === parcelasPreferidas);
  if (exact) return exact;
  const sorted = [...options].sort((a, b) => a.parcelasNum - b.parcelasNum);
  const nextHigher = sorted.find((item) => item.parcelasNum > parcelasPreferidas);
  if (nextHigher) return nextHigher;
  return sorted[sorted.length - 1];
}

function isCashOption(option: NectarNegotiationOption): boolean {
  const parcelas = option.parcelasNum ?? 1;
  const valorDemais = option.valorDemais ?? 0;
  return parcelas <= 1 || valorDemais <= 0;
}

function filterNegotiationOptions(options: NectarNegotiationOption[]): NectarNegotiationOption[] {
  return options.filter((option) => {
    if (isCashOption(option)) {
      return true;
    }

    return (option.valorDemais ?? 0) >= MIN_INSTALLMENT_VALUE;
  });
}

function isEmprestimo(contract: NectarContract): boolean {
  const produto = (contract.produto ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  return produto.includes("emprestimo");
}

function shouldEmitTitulo(contract: NectarContract): boolean {
  const atraso = Number(contract.diasAtraso ?? 0);
  if (atraso <= 60) return true;
  if (isEmprestimo(contract)) return atraso <= 60;
  return atraso <= 90;
}

function getTodayIsoLocal(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function getIsoDatePart(dateValue: string): string {
  return (dateValue ?? "").slice(0, 10);
}

function toBrDateFromIso(isoDate: string): string {
  const dateOnly = (isoDate ?? "").slice(0, 10);
  const [yyyy, mm, dd] = dateOnly.split("-");
  if (!yyyy || !mm || !dd) return "";
  return `${dd}/${mm}/${yyyy}`;
}

function toIsoFromBrDate(brDate: string): string {
  const normalized = (brDate ?? "").trim();
  const match = normalized.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) return "";
  const [, dd, mm, yyyy] = match;
  return `${yyyy}-${mm}-${dd}`;
}

function diffDaysFromTodayBrDate(brDate: string): number | null {
  const iso = toIsoFromBrDate(brDate);
  if (!iso) return null;
  const [yyyy, mm, dd] = iso.split("-").map(Number);
  if (!yyyy || !mm || !dd) return null;
  const target = new Date(yyyy, mm - 1, dd);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((target.getTime() - today.getTime()) / 86_400_000);
}

function pruneSimulationCache(dayKey: string): void {
  for (const [key, entry] of simulationCache.entries()) {
    if (entry.dayKey !== dayKey) {
      simulationCache.delete(key);
    }
  }
}

function buildSimulationCacheKey(payload: SimulatePayload, contract: NectarContract, dayKey: string): string {
  return [
    dayKey,
    payload.cnpjcpf ?? "",
    contract.idCon,
    contract.idServ,
    payload.vencPrimParcela,
    String(payload.parcelasPreferidas ?? 1),
    payload.tiponegociacao ?? "3",
    payload.tpDesconto ?? "1",
    payload.debugBoleto ? "debug" : "nodebug",
    payload.emitAllOpenTitles ? "alltitles" : "overduetitles",
    shouldEmitTitulo(contract) ? "titulo" : "negociacao",
  ].join("|");
}

function cloneSimulationRow(row: SimulationRow): SimulationRow {
  return JSON.parse(JSON.stringify(row)) as SimulationRow;
}

async function mapWithConcurrencyLimit<T, R>(
  items: T[],
  limit: number,
  iteratee: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= items.length) return;
      results[currentIndex] = await iteratee(items[currentIndex], currentIndex);
    }
  }

  const workerCount = Math.min(Math.max(limit, 1), items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

function decodeValueFromBoletoDigits(digits: string): number {
  if (digits.length === 44) {
    const valor = Number.parseInt(digits.slice(9, 19), 10);
    return Number.isFinite(valor) ? valor / 100 : 0;
  }

  if (digits.length === 47) {
    const campo1 = digits.slice(0, 9);
    const campo2 = digits.slice(10, 20);
    const campo3 = digits.slice(21, 31);
    const campo4 = digits.slice(32, 33);
    const campo5 = digits.slice(33, 47);
    const barcode = `${campo1.slice(0, 4)}${campo4}${campo5}${campo1.slice(4)}${campo2}${campo3}`;
    const valor = Number.parseInt(barcode.slice(9, 19), 10);
    return Number.isFinite(valor) ? valor / 100 : 0;
  }

  if (digits.length === 48) {
    const valor = Number.parseInt(digits.slice(4, 15), 10);
    return Number.isFinite(valor) ? valor / 100 : 0;
  }

  return 0;
}

function extractValueFromLinhaDigitavel(linhaDigitavel: string | null): number {
  if (!linhaDigitavel) return 0;
  const digits = linhaDigitavel.replace(/\D/g, "");
  return decodeValueFromBoletoDigits(digits);
}

function parsePdfToUnicodeMap(pdfText: string): Map<number, string> {
  const map = new Map<number, string>();

  const bfcharBlocks = Array.from(pdfText.matchAll(/beginbfchar([\s\S]*?)endbfchar/gi)).map((item) => item[1]);
  for (const block of bfcharBlocks) {
    const pairs = Array.from(block.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g));
    for (const pair of pairs) {
      const src = Number.parseInt(pair[1], 16);
      const dst = Number.parseInt(pair[2], 16);
      if (!Number.isFinite(src) || !Number.isFinite(dst)) continue;
      map.set(src, String.fromCodePoint(dst));
    }
  }

  const bfrangeBlocks = Array.from(pdfText.matchAll(/beginbfrange([\s\S]*?)endbfrange/gi)).map((item) => item[1]);
  for (const block of bfrangeBlocks) {
    const lines = block
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    for (const line of lines) {
      const arrayMatch = line.match(/^<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*\[(.+)\]$/);
      if (arrayMatch) {
        const start = Number.parseInt(arrayMatch[1], 16);
        const end = Number.parseInt(arrayMatch[2], 16);
        const values = Array.from(arrayMatch[3].matchAll(/<([0-9A-Fa-f]+)>/g)).map((item) => item[1]);

        for (let code = start; code <= end; code += 1) {
          const idx = code - start;
          const hex = values[idx];
          if (!hex) continue;
          const dst = Number.parseInt(hex, 16);
          if (!Number.isFinite(dst)) continue;
          map.set(code, String.fromCodePoint(dst));
        }
        continue;
      }

      const simpleMatch = line.match(/^<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>$/);
      if (!simpleMatch) continue;

      const start = Number.parseInt(simpleMatch[1], 16);
      const end = Number.parseInt(simpleMatch[2], 16);
      const dstStart = Number.parseInt(simpleMatch[3], 16);
      if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(dstStart)) continue;

      for (let code = start; code <= end; code += 1) {
        map.set(code, String.fromCodePoint(dstStart + (code - start)));
      }
    }
  }

  return map;
}

function decodePdfHexText(hex: string, cmap: Map<number, string>): string {
  const normalized = hex.replace(/[^0-9A-Fa-f]/g, "");
  if (!normalized) return "";

  let output = "";
  for (let idx = 0; idx + 3 < normalized.length; idx += 4) {
    const code = Number.parseInt(normalized.slice(idx, idx + 4), 16);
    if (!Number.isFinite(code)) continue;
    output += cmap.get(code) ?? "";
  }

  return output;
}

type PdfStreamObject = {
  objectBody: string;
  streamRaw: Buffer;
};

function extractPdfStreamObjects(pdfBytes: Buffer): PdfStreamObject[] {
  const pdfText = pdfBytes.toString("latin1");
  const objectRegex = /(\d+)\s+(\d+)\s+obj([\s\S]*?)endobj/g;
  const streams: PdfStreamObject[] = [];
  const objectBodies = new Map<number, string>();

  for (const objMatch of pdfText.matchAll(objectRegex)) {
    const objectNum = Number.parseInt(objMatch[1], 10);
    if (Number.isFinite(objectNum)) {
      objectBodies.set(objectNum, objMatch[3]);
    }
  }

  function resolveLength(objectBody: string): number {
    const direct = objectBody.match(/\/Length\s+(\d+)(?!\s+\d+\s+R)/i);
    if (direct) {
      const n = Number.parseInt(direct[1], 10);
      if (Number.isFinite(n) && n > 0) return n;
    }

    const indirect = objectBody.match(/\/Length\s+(\d+)\s+(\d+)\s+R/i);
    if (indirect) {
      const refObj = Number.parseInt(indirect[1], 10);
      if (Number.isFinite(refObj)) {
        const refBody = objectBodies.get(refObj);
        if (refBody) {
          const m = refBody.match(/^\s*(\d+)\s*$/);
          if (m) {
            const n = Number.parseInt(m[1], 10);
            if (Number.isFinite(n) && n > 0) return n;
          }
          const mAny = refBody.match(/(\d+)/);
          if (mAny) {
            const n = Number.parseInt(mAny[1], 10);
            if (Number.isFinite(n) && n > 0) return n;
          }
        }
      }
    }

    return 0;
  }

  for (const objMatch of pdfText.matchAll(objectRegex)) {
    const objectBody = objMatch[3];
    const objectStart = objMatch.index ?? -1;
    if (objectStart < 0) continue;

    const streamPos = pdfText.indexOf("stream", objectStart);
    if (streamPos < 0) continue;

    const length = resolveLength(objectBody);
    if (!Number.isFinite(length) || length <= 0) continue;

    let dataStart = streamPos + "stream".length;
    if (pdfText[dataStart] === "\r" && pdfText[dataStart + 1] === "\n") {
      dataStart += 2;
    } else if (pdfText[dataStart] === "\n") {
      dataStart += 1;
    }

    const dataEnd = dataStart + length;
    if (dataEnd > pdfBytes.length) continue;

    const streamRaw = Buffer.from(pdfBytes.subarray(dataStart, dataEnd));
    streams.push({ objectBody, streamRaw });
  }

  return streams;
}

function extractDecodedPdfText(pdfBytes: Buffer, pdfText: string, cmap: Map<number, string>): string {
  const texts: string[] = [];

  for (const obj of extractPdfStreamObjects(pdfBytes)) {
    const { objectBody, streamRaw } = obj;
    let streamText = "";

    if (/\/FlateDecode/i.test(objectBody)) {
      try {
        streamText = inflateSync(streamRaw).toString("latin1");
      } catch {
        continue;
      }
    } else {
      streamText = streamRaw.toString("latin1");
    }

    const chunks: string[] = [];

    const tjMatches = Array.from(streamText.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g));
    for (const match of tjMatches) {
      chunks.push(decodePdfHexText(match[1], cmap));
    }

    const tjArrayMatches = Array.from(streamText.matchAll(/\[((?:.|\r|\n)*?)\]\s*TJ/g));
    for (const arrayMatch of tjArrayMatches) {
      const hexItems = Array.from(arrayMatch[1].matchAll(/<([0-9A-Fa-f]+)>/g));
      for (const item of hexItems) {
        chunks.push(decodePdfHexText(item[1], cmap));
      }
    }

    if (chunks.length > 0) texts.push(chunks.join(" "));
  }

  return texts.join("\n");
}

function getPdfPassword(cnpjcpf?: string): string {
  const digits = (cnpjcpf ?? "").replace(/\D/g, "");
  if (digits.length < 3) return "";
  return digits.slice(-3);
}

async function extractTextWithPdfJs(pdfBytes: Buffer, cnpjcpf?: string): Promise<string> {
  const password = getPdfPassword(cnpjcpf);
  const scriptPath = nodePath.join(process.cwd(), "scripts", "extract-pdf-text.mjs");
  const input = JSON.stringify({
    base64: pdfBytes.toString("base64"),
    password,
  });

  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdoutData = "";
    let stderrData = "";

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("PDF_TEXT_TIMEOUT"));
    }, 10000);

    child.stdout.on("data", (chunk) => {
      stdoutData += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderrData += chunk.toString();
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(stderrData || `PDF_TEXT_PROCESS_EXIT_${code}`));
        return;
      }
      resolve(stdoutData);
    });

    child.stdin.write(input);
    child.stdin.end();
  });

  const parsed = JSON.parse(stdout || "{}") as { ok?: boolean; text?: string; error?: string };
  if (!parsed.ok) {
    throw new Error(parsed.error || "PDF_TEXT_EXTRACTION_FAILED");
  }

  return parsed.text || "";
}

function getRetornoPdfBytes(xml: string): Buffer | null {
  const retornoPdf = extractTagValue(xml, ["RetornoPDF", "retornoPdf", "retorno_pdf"]);
  if (!retornoPdf) return null;
  try {
    return Buffer.from(retornoPdf.replace(/\s+/g, ""), "base64");
  } catch {
    return null;
  }
}


type BoletoValueTrace = {
  linhaDigitavel: number;
  pixCopiaCola: number;
  xmlTag: number;
  xmlGenericValorTag: number;
  xmlDigitSequence: number;
  retornoPdfTexto: number;
  retornoPdfBarcode: number;
  retornoPdfOcr: number;
  boletoUrlTexto: number;
  boletoUrlBarcode: number;
  boletoUrlOcr: number;
  retornoPdfPresente?: boolean;
  senhaPdfUsada?: string;
  erroPdfJs?: string;
};

type BoletoXmlResolve = {
  value: number;
  source: "retorno_pdf_valor_documento" | "retorno_pdf_linha_digitavel" | "linha_digitavel" | "zero";
  trace: BoletoValueTrace;
};

function extractLinhaDigitavelFromText(text: string): string | null {
  if (!text) return null;
  const normalized = text.replace(/\s+/g, " ");
  const formatted =
    normalized.match(/(\d{5}\.?\d{5}\s*\d{5}\.?\d{6}\s*\d{5}\.?\d{6}\s*\d\s*\d{14})/)?.[1] ?? null;
  if (formatted) {
    const digits = formatted.replace(/\D/g, "");
    if (digits.length === 47) return digits;
  }

  const compact = normalized.replace(/\s+/g, "");
  const all47 = compact.match(/\d{47}/g) ?? [];
  for (const candidate of all47) {
    const block = candidate.slice(33, 47);
    const factor = Number.parseInt(block.slice(0, 4), 10);
    const cents = Number.parseInt(block.slice(4), 10);
    if (Number.isFinite(factor) && Number.isFinite(cents) && cents > 0) return candidate;
  }
  return null;
}

function decodeLinhaDigitavelFinalBlock(linha47: string): number {
  const digits = linha47.replace(/\D/g, "");
  if (digits.length !== 47) return 0;
  const block = digits.slice(33, 47);
  const cents = Number.parseInt(block.slice(4), 10);
  if (!Number.isFinite(cents)) return 0;
  const value = cents / 100;
  return value > 0 && value <= 1_000_000 ? value : 0;
}

async function extractValueFromBoletoXml(xml: string, cnpjcpf?: string): Promise<BoletoXmlResolve> {
  const trace: BoletoValueTrace = {
    linhaDigitavel: 0,
    pixCopiaCola: 0,
    xmlTag: 0,
    xmlGenericValorTag: 0,
    xmlDigitSequence: 0,
    retornoPdfTexto: 0,
    retornoPdfBarcode: 0,
    retornoPdfOcr: 0,
    boletoUrlTexto: 0,
    boletoUrlBarcode: 0,
    boletoUrlOcr: 0,
    retornoPdfPresente: false,
    senhaPdfUsada: getPdfPassword(cnpjcpf),
    erroPdfJs: "",
  };

  // Regra operacional: nao inferir valor por tags XML genericas; usar o RetornoPDF.
  const retornoPdfBytes = getRetornoPdfBytes(xml);
  if (retornoPdfBytes) {
    trace.retornoPdfPresente = true;
    let decodedText = "";
    try {
      decodedText = await extractTextWithPdfJs(retornoPdfBytes, cnpjcpf);
    } catch (error) {
      trace.erroPdfJs = error instanceof Error ? error.message : "PDFJS_ERROR";
      const pdfText = retornoPdfBytes.toString("latin1");
      const cmap = parsePdfToUnicodeMap(pdfText);
      decodedText = extractDecodedPdfText(retornoPdfBytes, pdfText, cmap);
    }
    const normalized = decodedText.replace(/\s+/g, " ").trim();
    const compact = normalized.replace(/\s+/g, "");

    const valorDocumento =
      parseMoney((normalized.match(/VALOR(?:\s+DO\s+DOCUMENTO)?[^0-9]{0,30}(?:R\$\s*)?(\d{1,3}(?:[.,]\d{3})*[.,]\d{2})/i) ?? [])[1] ?? "") ||
      parseMoney((compact.match(/VALORDODOCUMENTO[^0-9]{0,30}(?:R\$)?(\d{1,3}(?:[.,]\d{3})*[.,]\d{2})/i) ?? [])[1] ?? "");
    trace.retornoPdfTexto = valorDocumento;
    if (valorDocumento > 0) {
      return { value: valorDocumento, source: "retorno_pdf_valor_documento", trace };
    }

    const linha47 = extractLinhaDigitavelFromText(normalized);
    if (linha47) {
      const valorLinha = decodeLinhaDigitavelFinalBlock(linha47);
      trace.retornoPdfBarcode = valorLinha;
      if (valorLinha > 0) {
        return { value: valorLinha, source: "retorno_pdf_linha_digitavel", trace };
      }
    }
  }

  return { value: 0, source: "zero", trace };
}

async function resolveTituloValueFromBoleto(
  boletoXml: string,
  linhaDigitavel: string | null,
  pixCopiaCola: string | null,
  cnpjcpf?: string,
  fallbackValue = 0,
): Promise<{ value: number; source: string; trace: BoletoValueTrace }> {
  void pixCopiaCola;
  const extracted = extractValueFromLinhaDigitavel(linhaDigitavel);
  if (extracted > 0) {
    return {
      value: extracted,
      source: "linha_digitavel",
      trace: {
        linhaDigitavel: extracted,
        pixCopiaCola: 0,
        xmlTag: 0,
        xmlGenericValorTag: 0,
        xmlDigitSequence: 0,
        retornoPdfTexto: 0,
        retornoPdfBarcode: 0,
        retornoPdfOcr: 0,
        boletoUrlTexto: 0,
        boletoUrlBarcode: 0,
        boletoUrlOcr: 0,
      },
    };
  }

  const xmlResolved = await extractValueFromBoletoXml(boletoXml, cnpjcpf);
  if (xmlResolved.value <= 0 && fallbackValue > 0) {
    return {
      value: fallbackValue,
      source: "titulo_fallback",
      trace: { ...xmlResolved.trace, linhaDigitavel: extracted, pixCopiaCola: 0 },
    };
  }

  return {
    value: xmlResolved.value,
    source: xmlResolved.source,
    trace: { ...xmlResolved.trace, linhaDigitavel: extracted, pixCopiaCola: 0 },
  };
}

function buildPendingTitlesSummary(count: number, unitValue: number, dueDays: string[]): string {
  if (count <= 0) return "";
  const formatter = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
  const sameDay = dueDays.length > 0 && dueDays.every((item) => item === dueDays[0]);
  if (sameDay) {
    return `${count} parcela(s) a vencer no valor de ${formatter.format(unitValue)} para todo dia ${dueDays[0]}.`;
  }
  return `${count} parcela(s) a vencer no valor de ${formatter.format(unitValue)}.`;
}

async function simulateContract(
  payload: SimulatePayload,
  contract: NectarContract,
  token: string,
  todayIso: string,
): Promise<SimulationRow> {
  const diffDays = diffDaysFromTodayBrDate(payload.vencPrimParcela);
  if (shouldEmitTitulo(contract) && contract.titulos?.length) {
    const contractKey = `${contract.idCon}:${contract.idServ}`;
    const titulosEmAberto = contract.titulos.filter((titulo) => Boolean(getIsoDatePart(titulo.dataVencimento)));
    const vencidos = titulosEmAberto.filter((titulo) => {
      const dueIso = getIsoDatePart(titulo.dataVencimento);
      return dueIso < todayIso;
    });
    const titulosBase = payload.emitAllOpenTitles
      ? titulosEmAberto
      : vencidos;
    const selectedTitleIds = payload.selectedTitleIdsByContract?.[contractKey] ?? [];
    const titulosParaEmitir = selectedTitleIds.length > 0
      ? titulosBase.filter((titulo) => selectedTitleIds.includes(titulo.idTra))
      : titulosBase;

    const aVencer = payload.emitAllOpenTitles
      ? []
      : titulosEmAberto.filter((titulo) => {
        const dueIso = getIsoDatePart(titulo.dataVencimento);
        return dueIso >= todayIso;
      });

    let totalTitulos = 0;
    const boletoDebugItems: NonNullable<SimulationRow["boletoDebug"]> = [];

    for (const titulo of titulosParaEmitir) {
      const boleto = await getBoletoAcordo({
        tipo: "TITULO",
        idboleto: titulo.idTra,
        idcon: contract.idCon,
        idserv: contract.idServ,
        dtvencimento: toBrDateFromIso(titulo.dataVencimento),
        tipoenvio: "1",
        gerarPdf: "1",
        geraPix: "1",
        origemReal: "api",
        codigoToken: token,
      });

      const resolved = await resolveTituloValueFromBoleto(
        boleto.xml,
        boleto.linhaDigitavel,
        boleto.pixCopiaCola,
        payload.cnpjcpf,
        titulo.valorAtualizado > 0 ? titulo.valorAtualizado : titulo.valorOriginal,
      );
      totalTitulos += resolved.value;

      if (payload.debugBoleto) {
        boletoDebugItems.push({
          idTra: titulo.idTra,
          linhaDigitavel: boleto.linhaDigitavel,
          valorResolvido: resolved.value,
          origemValor: resolved.source,
          etapas: resolved.trace,
        });
      }
    }

    const pendingUnitValue = aVencer.length
      ? (aVencer[0].valorOriginal > 0 ? aVencer[0].valorOriginal : aVencer[0].valorAtualizado)
      : 0;
    const pendingTotal = pendingUnitValue * aVencer.length;
    const pendingDays = aVencer
      .map((item) => getIsoDatePart(item.dataVencimento).slice(8, 10))
      .filter((item) => item.length === 2);
    const pendingSummary = buildPendingTitlesSummary(aVencer.length, pendingUnitValue, pendingDays);

    const tituloOption: NectarNegotiationOption = {
      parcelasNum: Math.max(1, titulosParaEmitir.length),
      valorNegociar: totalTitulos,
      valorPrimeira: totalTitulos,
      valorDemais: 0,
      valorDesconto: 0,
      valorOriginal: totalTitulos,
      valorCorrigido: totalTitulos,
      vencimentoPrimeira: payload.vencPrimParcela,
      plano: "TITULO",
      codigoFaixa: "TITULO",
      descricaoFaixa: "Emissao de titulos",
    };

    return {
      contract,
      selectedOption: tituloOption,
      aVistaOption: tituloOption,
      rawOptions: [tituloOption],
      processingMode: "titulo",
      pendingTitlesSummary: pendingSummary,
      pendingTitlesCount: aVencer.length,
      pendingTitlesUnitValue: pendingUnitValue,
      pendingTitlesTotal: pendingTotal,
      overdueTitlesCount: titulosParaEmitir.length,
      selectedTitleIds: titulosParaEmitir.map((titulo) => titulo.idTra),
      boletoDebug: payload.debugBoleto ? boletoDebugItems : undefined,
    };
  }

  const response = await getOpcoesNegociacao({
    idCon: contract.idCon,
    idServ: contract.idServ,
    titulos: "",
    vencPrimParcela: payload.vencPrimParcela,
    tiponegociacao:
      payload.tiponegociacao ??
      contract.tiponegociacao ??
      ((diffDays ?? 0) > 1 ? "2" : "3"),
    tpDesconto: payload.tpDesconto ?? contract.tpDesconto ?? "1",
    percDescAplicNoPrincipal: contract.percDescAplicNoPrincipal ?? "",
    percDescAplicNaCorrecao: contract.percDescAplicNaCorrecao ?? "",
    percDescAplicNosHonorarios: contract.percDescAplicNosHonorarios ?? "",
    percDescAplicNaPontualidade: contract.percDescAplicNaPontualidade ?? "",
    percDescAplicNaMulta: contract.percDescAplicNaMulta ?? "",
    percDescAplicNoJuros: contract.percDescAplicNoJuros ?? "",
    codigoToken: token,
  });

  const filteredOptions = filterNegotiationOptions(response.options);
  const cashOptions = response.options.filter((item) => isCashOption(item));
  const effectiveOptions = filteredOptions.length > 0
    ? filteredOptions
    : cashOptions;
  const selected = selectBestOption(effectiveOptions, payload.parcelasPreferidas);
  const aVista = effectiveOptions.find((item) => item.parcelasNum === 1) ?? selected;

  return {
    contract,
    selectedOption: selected,
    aVistaOption: aVista,
    rawOptions: effectiveOptions,
    processingMode: "negociacao",
  };
}

export async function POST(req: NextRequest) {
  try {
    const payload = (await req.json()) as SimulatePayload;
    if (!payload.contracts?.length || !payload.vencPrimParcela) {
      return NextResponse.json({ error: "Informe contratos e vencPrimParcela." }, { status: 400 });
    }

    if (isDemoRequest(payload.cnpjcpf) || payload.contracts.some((contract) => contract.idCon.startsWith("DEMO"))) {
      return NextResponse.json({
        ...buildDemoSimulation(payload),
        demo: true,
      });
    }

    const token = await getToken();
    const todayIso = getTodayIsoLocal();
    pruneSimulationCache(todayIso);

    const rows = await mapWithConcurrencyLimit(
      payload.contracts,
      SIMULATION_CONCURRENCY_LIMIT,
      async (contract) => {
        const cacheKey = buildSimulationCacheKey(payload, contract, todayIso);
        const cached = simulationCache.get(cacheKey);
        if (cached) {
          return cloneSimulationRow(cached.value);
        }

        const row = await simulateContract(payload, contract, token, todayIso);
        simulationCache.set(cacheKey, {
          dayKey: todayIso,
          value: cloneSimulationRow(row),
        });
        return row;
      },
    );

    const totalAvista = rows.reduce((acc, row) => acc + (row.aVistaOption?.valorNegociar ?? 0), 0);
    const totalMensal = rows.reduce((acc, row) => acc + (row.selectedOption?.valorDemais || row.selectedOption?.valorPrimeira || 0), 0);

    return NextResponse.json({
      summary: {
        contratos: rows.length,
        totalAvista,
        totalMensal,
      },
      items: rows,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Falha ao simular negociacao no WS SGC." },
      { status: 500 },
    );
  }
}






