import { NextRequest, NextResponse } from "next/server";
import { getDemoContracts, isDemoRequest } from "@/lib/demo-data";
import { getDadosDivida, getToken } from "@/lib/nectar/client";
import { extractTagValue, parseMoney } from "@/lib/nectar/xml";

type ContractsPayload = {
  cnpjcpf: string;
  debugIdCon?: string;
};

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as ContractsPayload;
    if (!body.cnpjcpf) {
      return NextResponse.json({ error: "Campo obrigatorio: cnpjcpf." }, { status: 400 });
    }

    if (isDemoRequest(body.cnpjcpf)) {
      const contracts = getDemoContracts().sort((a, b) => b.diasAtraso - a.diasAtraso);
      return NextResponse.json({
        tokenLoaded: true,
        totalContratos: contracts.length,
        contracts,
        debug: null,
        demo: true,
      });
    }

    const includeDebug = Boolean(body.debugIdCon?.trim());
    const debugIdCon = (body.debugIdCon || "17020037").trim();
    const token = await getToken();
    const data = await getDadosDivida({
      cnpjcpf: body.cnpjcpf,
      agrupamento: "BEMOL",
      atualizarDivida: "1",
      codigoToken: token,
      debugIdCon: includeDebug ? debugIdCon : undefined,
    });
    const sortedContracts = [...data.contracts].sort((a, b) => b.diasAtraso - a.diasAtraso);
    const debug = includeDebug ? buildContractDebug(data.xml, debugIdCon, sortedContracts) : null;

    return NextResponse.json({
      tokenLoaded: Boolean(token),
      totalContratos: sortedContracts.length,
      contracts: sortedContracts,
      debug: includeDebug
        ? {
            ...debug,
            parseMergeTrail: data.parseDebug
              ? {
                  targetIdCon: data.parseDebug.targetIdCon,
                  point1_valorBaseCalculado_parse: data.parseDebug.parseValueAfterContractScan,
                  point2_valorObjetoIntermediario: data.parseDebug.intermediateValueBeforeMapInsert,
                  point3_valorExistenteAntesMerge: data.parseDebug.existingValueBeforeMerge,
                  point4_regraMerge: data.parseDebug.mergeRuleUsed,
                  point4_valorAposMergeNoMapa: data.parseDebug.mergedValueInMap,
                  point5_valorFinalNoResponse: data.parseDebug.finalValueInResponse,
                  matchingKeysSeen: data.parseDebug.matchingKeysSeen,
                  totalContractBlocksFound: data.parseDebug.totalContractBlocksFound,
                  pipelineLogs: data.parseDebug.pipelineLogs,
                }
              : null,
          }
        : null,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Falha ao consultar contratos no WS SGC." },
      { status: 500 },
    );
  }
}

function buildContractDebug(
  xml: string,
  targetIdCon: string,
  finalContracts: Array<{ idCon: string; numeroContrato: string; valorCorrigido: number; diasAtraso: number }>,
) {
  const decodedInnerXml = extractTagValue(xml, ["GetDadosDividaResult"]);
  const rawSourceXml = decodedInnerXml && decodedInnerXml.includes("<") ? decodedInnerXml : xml;
  const withoutNsPrefix = rawSourceXml
    .replace(/<[a-zA-Z0-9]+:/g, "<")
    .replace(/<\/[a-zA-Z0-9]+:/g, "</");
  const normalized = normalizeContractWrapper(withoutNsPrefix);
  const contractBlocks = extractContractBlocks(normalized);

  let foundBlock: string | null = null;
  for (const block of contractBlocks) {
    const idCon = (findInContext(block, ["IDCON", "IdCon", "idCon"]) ?? "").trim();
    if (idCon === targetIdCon) {
      foundBlock = block;
      break;
    }
  }

  if (!foundBlock) {
    return {
      idCon: targetIdCon,
      error: "idCon nao encontrado no XML",
      quantidadeContratosEncontradosNoXml: contractBlocks.length,
      contemIdConNoXml: withoutNsPrefix.includes(targetIdCon),
      contemMarcadorAgrupamento: /<Agrupamento\b/i.test(withoutNsPrefix),
      totalMarcadoresIdCon: Array.from(withoutNsPrefix.matchAll(/<IDCON\b[^>]*>/gi)).length,
      totalMarcadoresContrato: Array.from(withoutNsPrefix.matchAll(/<Contrato\b[^>]*>/gi)).length,
      previewXmlNormalizado: withoutNsPrefix.slice(0, 2200),
      listaFinalContratos: finalContracts.map((item) => ({
        idCon: item.idCon,
        numeroContrato: item.numeroContrato,
        valorBase: item.valorCorrigido,
        diasAtraso: item.diasAtraso,
      })),
    };
  }

  const wrapperBlocks = getTopLevelTagBlocks(foundBlock, "Divida");
  const wrapper = wrapperBlocks[0] ?? "";
  const wrapperInner = extractTagInner(wrapper, "Divida") ?? "";
  const debtItems = getTopLevelTagBlocks(wrapperInner, "Divida");
  const itensDividaValoresCapturados = debtItems
    .map((item) => parseMoney(findInContext(item, ["ValorAtualizado", "valorAtualizado"])))
    .filter((value) => value > 0);
  const valorBaseCalculado = itensDividaValoresCapturados.reduce((sum, item) => sum + item, 0);
  const numeroContrato = sanitizeContractNumber(
    extractContratoFromContractBlock(foundBlock) ?? findInContext(foundBlock, ["Contrato", "contrato"]) ?? targetIdCon,
    targetIdCon,
  );

  return {
    idCon: targetIdCon,
    numeroContrato,
    contractBlockPreview: foundBlock.slice(0, 800),
    wrapperDividaPreview: wrapper.slice(0, 800),
    qtdItensDividaEncontrados: debtItems.length,
    itensDividaValoresCapturados,
    valorBaseCalculado,
    quantidadeContratosEncontradosNoXml: contractBlocks.length,
    listaFinalContratos: finalContracts.map((item) => ({
      idCon: item.idCon,
      numeroContrato: item.numeroContrato,
      valorBase: item.valorCorrigido,
      diasAtraso: item.diasAtraso,
    })),
  };
}

function normalizeContractWrapper(xml: string): string {
  let normalized = xml;
  normalized = normalized.replace(/<Contrato[^>]*xmlns="[^"]*"[^>]*>/i, "<ContratosRaiz>");
  normalized = normalized.replace(/<\/Contrato>\s*<Resultado/i, "</ContratosRaiz><Resultado");
  return normalized;
}

function extractContractBlocks(sourceXml: string): string[] {
  const contractsRoot = extractBetween(sourceXml, "<ContratosRaiz>", "</ContratosRaiz>") ?? sourceXml;
  const contratoRanges = getTagRangesWithDepth(contractsRoot, "Contrato").sort((a, b) => {
    const lengthDiff = (a.end - a.start) - (b.end - b.start);
    return lengthDiff !== 0 ? lengthDiff : a.start - b.start;
  });

  const directBlocks = contratoRanges
    .map((range) => contractsRoot.slice(range.start, range.end))
    .filter((block) => {
      return Boolean(
        findInContext(block, ["IDCON", "IdCon", "idCon"]) ||
          findInContext(block, ["Agrupamento", "agrupamento"]),
      );
    });

  if (directBlocks.length > 0) {
    const deduped = new Map<string, string>();
    for (const block of directBlocks) {
      const idCon = (findInContext(block, ["IDCON", "IdCon", "idCon"]) ?? "").trim();
      if (idCon && !deduped.has(idCon)) {
        deduped.set(idCon, block);
      }
    }
    if (deduped.size > 0) {
      return Array.from(deduped.values());
    }
    return directBlocks;
  }

  const idConMatches = Array.from(contractsRoot.matchAll(/<(?:\w+:)?IDCON\b[^>]*>([^<]+)<\/(?:\w+:)?IDCON>/gi));
  if (idConMatches.length > 0 && contratoRanges.length > 0) {
    const blocks = new Map<string, string>();
    for (const match of idConMatches) {
      const idCon = (match[1] ?? "").trim();
      const index = match.index ?? -1;
      if (!idCon || index < 0) continue;
      const owner = contratoRanges.find((range) => range.start <= index && index < range.end);
      if (!owner) continue;
      const block = contractsRoot.slice(owner.start, owner.end);
      if (!blocks.has(idCon)) {
        blocks.set(idCon, block);
      }
    }
    if (blocks.size > 0) {
      return Array.from(blocks.values());
    }
  }

  return Array.from(
    contractsRoot.matchAll(/<Contrato\b[^>]*>[\s\S]*?<\/(?:\w+:)?Contrato>/gi),
  )
    .map((match) => match[0])
    .filter((block) => {
      return Boolean(
        findInContext(block, ["IDCON", "IdCon", "idCon"]) ||
          findInContext(block, ["Agrupamento", "agrupamento"]),
      );
    });
}

function extractBetween(source: string, startMarker: string, endMarker: string): string | null {
  const start = source.indexOf(startMarker);
  if (start < 0) return null;
  const from = start + startMarker.length;
  const end = source.indexOf(endMarker, from);
  if (end < 0) return null;
  return source.slice(from, end);
}

function getTopLevelTagBlocks(context: string, tagName: string): string[] {
  const blocks: string[] = [];
  const ranges = getTagRangesWithDepth(context, tagName)
    .filter((item) => item.depth === 1)
    .sort((a, b) => a.start - b.start);
  for (const range of ranges) {
    blocks.push(context.slice(range.start, range.end));
  }
  return blocks;
}

function getTagRangesWithDepth(
  context: string,
  tagName: string,
): Array<{ start: number; end: number; depth: number }> {
  const ranges: Array<{ start: number; end: number; depth: number }> = [];
  const tokenRegex = new RegExp(`<(?:\\w+:)?\\/?${tagName}\\b[^>]*>`, "gi");
  const stack: Array<{ start: number; depth: number }> = [];
  for (const token of context.matchAll(tokenRegex)) {
    const raw = token[0];
    const index = token.index ?? 0;
    const isClosing = /^<\s*\/.*/i.test(raw);
    if (!isClosing) {
      stack.push({ start: index, depth: stack.length + 1 });
      continue;
    }
    const open = stack.pop();
    if (!open) continue;
    ranges.push({ start: open.start, end: index + raw.length, depth: open.depth });
  }
  return ranges;
}

function extractTagInner(block: string, tagName: string): string | null {
  const match = block.match(new RegExp(`^<(?:\\w+:)?${tagName}\\b[^>]*>([\\s\\S]*)<\\/(?:\\w+:)?${tagName}>$`, "i"));
  return match?.[1] ?? null;
}

function findInContext(context: string, tagNames: string[]): string | null {
  for (const tagName of tagNames) {
    const regex = new RegExp(`<(?:\\w+:)?${tagName}[^>]*>([\\s\\S]*?)<\\/(?:\\w+:)?${tagName}>`, "i");
    const match = context.match(regex);
    if (match?.[1]) return match[1].trim();
  }
  return null;
}

function extractContratoFromContractBlock(context: string): string | null {
  const contractAfterAgrupamento = context.match(
    /<(?:Agrupamento|agrupamento)[^>]*>[\s\S]*?<(?:NomeFantasia|nomeFantasia)[^>]*>[\s\S]*?<(?:Contrato|contrato)[^>]*>([\s\S]*?)<\/(?:Contrato|contrato)>/i,
  );
  if (contractAfterAgrupamento?.[1]) return contractAfterAgrupamento[1].trim();
  return null;
}

function sanitizeContractNumber(rawValue: string, fallback: string): string {
  if (!rawValue) return fallback;
  const text = rawValue.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const alphaNumMatch = text.match(/[A-Za-z]{2,}\d{5,}/);
  if (alphaNumMatch?.[0]) return alphaNumMatch[0].split("-")[0].trim();
  const numberMatch = text.match(/\d{8,}/);
  if (numberMatch?.[0]) return numberMatch[0].split("-")[0].trim();
  return fallback;
}
