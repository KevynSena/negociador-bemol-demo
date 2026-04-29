import { NextRequest, NextResponse } from "next/server";
import { buildDemoCloseResponse, isDemoRequest } from "@/lib/demo-data";
import { clearNegotiationCache, getBoletoAcordo, getDadosDevedor, getDadosDivida, getToken, gravarNegociacao, insereAndamento } from "@/lib/nectar/client";
import type { NectarContract, NectarNegotiationOption } from "@/lib/nectar/types";

type ClosePayload = {
  cnpjcpf?: string;
  operatorIdPes?: string;
  operatorNome?: string;
  preferredPhone?: string | null;
  preferredEmail?: string | null;
  vencPrimParcela: string;
  parcelasPreferidas: number;
  tipoenvio?: "1" | "2" | "3" | "6";
  emitAllOpenTitles?: boolean;
  items: Array<{
    contract: NectarContract;
    processingMode?: "negociacao" | "titulo";
    selectedOption?: NectarNegotiationOption | null;
    selectedTitleIds?: string[];
  }>;
};

type SuccessfulCloseItem = {
  status: "success";
  mode: "negociacao" | "titulo";
  contract: NectarContract;
  selectedOption: NectarNegotiationOption | null;
  gravacao: {
    codigoRetorno: string | null;
    mensagemRetorno: string | null;
    idParcela: string | null;
  } | null;
  boleto: null | {
    codigoRetorno: string | null;
    mensagemRetorno: string | null;
    linhaDigitavel: string | null;
    pixCopiaCola: string | null;
    boletoUrl: string | null;
  };
  andamento: {
    codigoRetorno: string | null;
    mensagemRetorno: string | null;
  } | null;
};

type ErrorCloseItem = {
  status: "error";
  mode: "negociacao" | "titulo";
  contract: NectarContract;
  error: string;
};

type PendingAgreementClose = {
  contract: NectarContract;
  selected: NectarNegotiationOption;
  gravado: {
    codigoRetorno: string | null;
    mensagemRetorno: string | null;
    idParcela: string | null;
  };
  vencimentoPrimeira: string;
};

const TODAY_TOMORROW_MAX_DAYS = 1;
const DEFAULT_ANDAMENTO_CODIGO_CONTRATO = "BEMOLCON";
const DEFAULT_ANDAMENTO_CODIGO_TITULO = "BEMOLTITU";
const CLOSE_CONCURRENCY_LIMIT = 5;

function isSoapSuccessCode(code: string | null | undefined): boolean {
  const normalized = (code ?? "").trim();
  if (!normalized) return true;
  return (
    normalized === "0" ||
    normalized === "000000" ||
    normalized === "000017" ||
    normalized === "000018" ||
    /^0+$/.test(normalized)
  );
}

function ensureSoapSuccess(step: string, code: string | null | undefined, message: string | null | undefined): void {
  if (!isSoapSuccessCode(code)) {
    const codeLabel = (code ?? "").trim();
    const base = message?.trim() || `Falha em ${step}.`;
    throw new Error(codeLabel ? `${step}: ${base} [codigo=${codeLabel}]` : `${step}: ${base}`);
  }
}

function withStep(step: string, error: unknown): never {
  const message = error instanceof Error ? error.message : "Falha inesperada.";
  throw new Error(`${step}: ${message}`);
}

function getTodayLocalDate(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function parseBrDate(brDate: string): Date | null {
  const match = (brDate ?? "").trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) return null;
  const [, dd, mm, yyyy] = match;
  return new Date(Number(yyyy), Number(mm) - 1, Number(dd));
}

function diffInDaysFromToday(brDate: string): number | null {
  const target = parseBrDate(brDate);
  if (!target) return null;
  const today = getTodayLocalDate();
  return Math.round((target.getTime() - today.getTime()) / 86_400_000);
}

function getAndamentoCode(mode: "negociacao" | "titulo"): string {
  if (mode === "titulo") {
    return (process.env.NECTAR_ANDAMENTO_CODIGO_BOLETO ?? DEFAULT_ANDAMENTO_CODIGO_TITULO).trim();
  }
  return (process.env.NECTAR_ANDAMENTO_CODIGO_ACORDO ?? DEFAULT_ANDAMENTO_CODIGO_CONTRATO).trim();
}

function getTitlesToEmit(contract: NectarContract, emitAllOpenTitles: boolean): Array<NonNullable<NectarContract["titulos"]>[number]> {
  const todayIso = getTodayIsoLocal();
  const titles = contract.titulos ?? [];
  if (emitAllOpenTitles) {
    return titles.filter((title) => Boolean(getIsoDatePart(title.dataVencimento)));
  }
  return titles.filter((title) => {
    const dueIso = getIsoDatePart(title.dataVencimento);
    return Boolean(dueIso) && dueIso < todayIso;
  });
}
function findTagValue(context: string, tagNames: string[]): string | null {
  for (const tag of tagNames) {
    const regex = new RegExp(`<(?:\\w+:)?${tag}[^>]*>([\\s\\S]*?)<\\/(?:\\w+:)?${tag}>`, "i");
    const match = context.match(regex);
    if (match?.[1]) {
      return match[1].trim();
    }
  }
  return null;
}

function normalizeGetDadosDividaXml(xml: string): string {
  return xml
    .replace(/<[a-zA-Z0-9]+:/g, "<")
    .replace(/<\/[a-zA-Z0-9]+:/g, "</")
    .replace(/<Contrato[^>]*xmlns="[^"]*">/i, "<ContratosRaiz>")
    .replace(/<\/Contrato>\s*<Resultado>/i, "</ContratosRaiz><Resultado>");
}

function extractContractBlocksFromDadosDivida(xml: string): string[] {
  const normalized = normalizeGetDadosDividaXml(xml);
  const root = findTagValue(normalized, ["GetDadosDividaResult"]) ?? normalized;
  const contractsRootMatch = root.match(/<ContratosRaiz>([\s\S]*?)<\/ContratosRaiz>/i);
  const contractsRoot = contractsRootMatch?.[1] ?? root;
  return Array.from(
    contractsRoot.matchAll(/<Contrato>\s*<Agrupamento[\s\S]*?<\/Contrato>(?=\s*<Contrato>\s*<Agrupamento|\s*<Resultado>|\s*$)/gi),
  ).map((match) => match[0]);
}

function extractContractBlockByIdentifiers(xml: string, idCon: string, idServ: string): string | null {
  const blocks = extractContractBlocksFromDadosDivida(xml);
  const directMatch = blocks.find((block) => {
    const blockIdCon = (findTagValue(block, ["IDCON", "IdCon", "idCon"]) ?? "").trim();
    const blockIdServ = (findTagValue(block, ["IDSERV", "IdServ", "idServ", "idserv"]) ?? "").trim();
    return blockIdCon === idCon && blockIdServ === idServ;
  });
  if (directMatch) return directMatch;

  const normalized = normalizeGetDadosDividaXml(xml);
  const anchorRegex = new RegExp(
    `<IDCON>\\s*${idCon}\\s*<\\/IDCON>[\\s\\S]*?<IDSERV>\\s*${idServ}\\s*<\\/IDSERV>`,
    "i",
  );
  const anchorMatch = normalized.match(anchorRegex);
  if (!anchorMatch || anchorMatch.index == null) return null;

  const anchorIndex = anchorMatch.index;
  const before = normalized.slice(0, anchorIndex);
  const after = normalized.slice(anchorIndex);
  const start = before.lastIndexOf("<Contrato>");
  const endRelative = after.indexOf("</Contrato>");
  if (start === -1 || endRelative === -1) return null;
  return normalized.slice(start, anchorIndex + endRelative + "</Contrato>".length);
}

function findAgreementIdCandidates(context: string): string[] {
  const candidates = new Set<string>();
  const explicitTags = [
    "IDBOLETO",
    "IdBoleto",
    "idBoleto",
    "idboleto",
    "IDParcela",
    "IdParcela",
    "idParcela",
    "idparcela",
  ];

  for (const tag of explicitTags) {
    const regex = new RegExp(`<(?:\\w+:)?${tag}[^>]*>([\\s\\S]*?)<\\/(?:\\w+:)?${tag}>`, "gi");
    for (const match of context.matchAll(regex)) {
      const value = (match[1] ?? "").trim();
      if (/^\d+$/.test(value)) candidates.add(value);
    }
  }

  for (const match of context.matchAll(/<([A-Za-z0-9_:-]*(?:Parcela|Boleto)[A-Za-z0-9_:-]*)[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const value = (match[2] ?? "").trim();
    if (/^\d+$/.test(value)) candidates.add(value);
  }

  return [...candidates];
}

function getAgreementEmissionDebug(xml: string, idCon: string, idServ: string): {
  contractFound: boolean;
  acordoFound: boolean;
  candidates: string[];
} {
  const globalCandidates = findAgreementIdCandidates(normalizeGetDadosDividaXml(xml));
  const contractBlock = extractContractBlockByIdentifiers(xml, idCon, idServ);

  if (!contractBlock) {
    return { contractFound: false, acordoFound: false, candidates: globalCandidates };
  }

  const acordoMatch = contractBlock.match(/<Acordo[^>]*>([\s\S]*?)<\/Acordo>/i);
  const acordoBlock = acordoMatch?.[1] ?? "";
  const candidates = [
    ...findAgreementIdCandidates(acordoBlock),
    ...findAgreementIdCandidates(contractBlock),
  ];

  return {
    contractFound: true,
    acordoFound: Boolean(acordoMatch),
    candidates: Array.from(new Set(candidates)),
  };
}

function parseAgreementParcelId(xml: string, idCon: string, idServ: string): string | null {
  const globalFirst = findAgreementIdCandidates(normalizeGetDadosDividaXml(xml))[0] ?? null;
  const contractBlock = extractContractBlockByIdentifiers(xml, idCon, idServ);

  if (!contractBlock) return globalFirst;

  const acordoBlock = contractBlock.match(/<Acordo[^>]*>([\s\S]*?)<\/Acordo>/i)?.[1] ?? contractBlock;
  const directCandidates = findAgreementIdCandidates(acordoBlock);
  if (directCandidates.length === 1) {
    return directCandidates[0];
  }

  const parcelas = [
    ...Array.from(acordoBlock.matchAll(/<ParcelaAcordo[^>]*>([\s\S]*?)<\/ParcelaAcordo>/gi)).map((match) => match[1]),
    ...Array.from(acordoBlock.matchAll(/<AcordoParcela[^>]*>([\s\S]*?)<\/AcordoParcela>/gi)).map((match) => match[1]),
    ...Array.from(acordoBlock.matchAll(/<Parcela[^>]*>([\s\S]*?)<\/Parcela>/gi)).map((match) => match[1]),
    ...Array.from(acordoBlock.matchAll(/<Boleto[^>]*>([\s\S]*?)<\/Boleto>/gi)).map((match) => match[1]),
  ];

  if (parcelas.length === 0) {
    return directCandidates[0] ??
      findAgreementIdCandidates(contractBlock)[0] ??
      null;
  }

  const firstParcelaId = parcelas
    .map((block) =>
      findTagValue(block, [
        "IDBOLETO",
        "IdBoleto",
        "idBoleto",
        "idboleto",
        "IDParcela",
        "IdParcela",
        "idParcela",
        "idparcela",
      ]) ?? "",
    )
    .find((value) => Boolean(value));

  return firstParcelaId ??
    directCandidates[0] ??
    findAgreementIdCandidates(contractBlock)[0] ??
    globalFirst;
}

function getCurrentTimestampBr(): string {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(now);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("day")}/${get("month")}/${get("year")} ${get("hour")}:${get("minute")}`;
}

function getTodayIsoLocal(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function getIsoDatePart(value: string): string {
  return (value ?? "").slice(0, 10);
}

function toBrDateFromIso(isoDate: string): string {
  const dateOnly = getIsoDatePart(isoDate);
  const [yyyy, mm, dd] = dateOnly.split("-");
  if (!yyyy || !mm || !dd) return "";
  return `${dd}/${mm}/${yyyy}`;
}


function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function emitTituloBoletos(
  contract: NectarContract,
  token: string,
  tipoenvio: "1" | "2" | "3" | "6",
  operatorIdPes: string,
  emitAllOpenTitles: boolean,
  selectedTitleIds?: string[],
  celularEnvio?: string | null,
  emailEnvio?: string | null,
): Promise<SuccessfulCloseItem["boleto"]> {
  if (tipoenvio === "1") {
    return null;
  }

  const baseTitlesToEmit = getTitlesToEmit(contract, emitAllOpenTitles);
  const titlesToEmit = selectedTitleIds?.length
    ? baseTitlesToEmit.filter((title) => selectedTitleIds.includes(title.idTra))
    : baseTitlesToEmit;
  if (titlesToEmit.length === 0) {
    return null;
  }

  let lastBoleto: SuccessfulCloseItem["boleto"] = null;
  for (const title of titlesToEmit) {
    const boleto = await getBoletoAcordo({
      tipo: "TITULO",
      idboleto: title.idTra,
      idcon: contract.idCon,
      idserv: contract.idServ,
      dtvencimento: toBrDateFromIso(title.dataVencimento),
      tipoenvio,
      gerarPdf: "1",
      geraPix: "1",
      idPesReal: operatorIdPes,
      celularEnvio: celularEnvio ?? "",
      emailEnvio: emailEnvio ?? "",
      codigoToken: token,
      origemReal: "Ativo",
    });
    ensureSoapSuccess("GetBoletoAcordo", boleto.codigoRetorno, boleto.mensagemRetorno);
    lastBoleto = {
      codigoRetorno: boleto.codigoRetorno,
      mensagemRetorno: boleto.mensagemRetorno,
      linhaDigitavel: boleto.linhaDigitavel,
      pixCopiaCola: boleto.pixCopiaCola,
      boletoUrl: boleto.boletoUrl,
    };
  }

  return lastBoleto;
}

async function emitAgreementBoleto(
  contract: NectarContract,
  agreementParcelId: string,
  token: string,
  tipoenvio: "1" | "2" | "3" | "6",
  operatorIdPes: string,
  celularEnvio?: string | null,
  emailEnvio?: string | null,
): Promise<Awaited<ReturnType<typeof getBoletoAcordo>> | null> {
  if (tipoenvio === "1") {
    return null;
  }

  const isEmprestimo = contract.produto.toLowerCase().includes("emprestimo");
  const requestTipoenvio = tipoenvio;
  const requestIdPesReal = isEmprestimo ? "" : operatorIdPes;
  const requestCelular = requestTipoenvio === "3" || requestTipoenvio === "6" ? (celularEnvio ?? "") : "";
  const requestEmail = requestTipoenvio === "2" ? (emailEnvio ?? "") : "";
  const maxAttempts = isEmprestimo ? 5 : 3;
  const retryDelayMs = isEmprestimo ? 1500 : 700;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const boletoResponse = await getBoletoAcordo({
        tipo: "ACORDO",
        idboleto: agreementParcelId,
        idcon: contract.idCon,
        idserv: contract.idServ,
        tipoenvio: requestTipoenvio,
        gerarPdf: "1",
        geraPix: "1",
        especiePagamento: "114",
        tipoPixEspecie: "2",
        valorBoleto: "",
        boletoQuitacao: "",
        codigoToken: token,
        idPesReal: requestIdPesReal,
        celularEnvio: requestCelular,
        emailEnvio: requestEmail,
        origemReal: "Ativo",
      });
      ensureSoapSuccess("GetBoletoAcordo", boletoResponse.codigoRetorno, boletoResponse.mensagemRetorno);
      return boletoResponse;
    } catch (error) {
      if (attempt === maxAttempts - 1) {
        const message = error instanceof Error ? error.message : "Falha inesperada.";
        throw new Error(
          `${message} [produto=${contract.produto}; idcon=${contract.idCon}; idboleto=${agreementParcelId}; tipoenvio=${requestTipoenvio}]`,
        );
      }
      await wait(retryDelayMs);
    }
  }

  return null;
}

async function registerAndamento(
  idCon: string,
  numeroContrato: string,
  idServ: string,
  cpf: string,
  telefone: string | undefined,
  token: string,
  code: string,
  operatorIdPes: string,
  amount?: number,
  paymentDate?: string,
): Promise<SuccessfulCloseItem["andamento"]> {
  const andamento = await insereAndamento({
    idCon,
    idServ,
    cpf: cpf.replace(/\D/g, ""),
    codigoToken: token,
    codigoandamento: code,
    dataandamento: getCurrentTimestampBr(),
    valor: amount,
    idPesReal: operatorIdPes,
    subOcorrencia: "",
    dataAgendamento: "",
    dataPagamento: paymentDate ?? "",
    telefone: (telefone ?? "").replace(/\s+/g, ""),
    complemento: numeroContrato,
  });
  ensureSoapSuccess("InsereAndamento", andamento.codigoRetorno, andamento.mensagemRetorno);
  return {
    codigoRetorno: andamento.codigoRetorno,
    mensagemRetorno: andamento.mensagemRetorno,
  };
}

export async function POST(req: NextRequest) {
  try {
    const payload = (await req.json()) as ClosePayload;
    const operatorIdPes = (payload.operatorIdPes ?? "").trim();
    const requestedTipoenvio = payload.tipoenvio ?? "1";
    const cpf = (payload.cnpjcpf ?? "").trim();

    if (!payload.items?.length || !payload.vencPrimParcela) {
      return NextResponse.json({ error: "Informe os contratos e a data da negociacao." }, { status: 400 });
    }

    if (isDemoRequest(cpf) || payload.items.some((item) => item.contract.idCon.startsWith("DEMO"))) {
      return NextResponse.json({
        ...buildDemoCloseResponse(payload),
        demo: true,
      });
    }

    if (!cpf) {
      return NextResponse.json({ error: "CPF/CNPJ ausente para registrar o andamento." }, { status: 400 });
    }
    if (!operatorIdPes) {
      return NextResponse.json({ error: "Selecione o operador responsavel pelo fechamento." }, { status: 400 });
    }

    const hasSelectedItems = payload.items.length > 0;
    const dayDiff = diffInDaysFromToday(payload.vencPrimParcela);
    if (hasSelectedItems && (dayDiff === null || dayDiff < 0)) {
      return NextResponse.json(
        { error: "A data de fechamento nao pode ser anterior a hoje." },
        { status: 400 },
      );
    }
    const negotiationKind = hasSelectedItems && dayDiff !== null && dayDiff > TODAY_TOMORROW_MAX_DAYS ? "promessa" : "acordo";
    const tiponegociacao = negotiationKind === "promessa" ? "2" : "3";
    const tipoenvio = negotiationKind === "promessa" ? "1" : requestedTipoenvio;

    const agreementCode = getAndamentoCode("negociacao");
    const boletoCode = getAndamentoCode("titulo");

    const token = await getToken();
    let preferredPhone: string | null = (payload.preferredPhone ?? "").trim() || null;
    let preferredEmail: string | null = (payload.preferredEmail ?? "").trim() || null;
    if (tipoenvio === "2" || tipoenvio === "3" || tipoenvio === "6") {
      const needsEmail = tipoenvio === "2" && !preferredEmail;
      const needsPhone = (tipoenvio === "3" || tipoenvio === "6") && !preferredPhone;
      if (needsEmail || needsPhone) {
        const debtor = await getDadosDevedor({ cpf, codigoToken: token });
        preferredPhone = debtor.preferredPhone;
        preferredEmail = debtor.preferredEmail;
      }
      if (tipoenvio === "2" && !preferredEmail) {
        return NextResponse.json(
          { error: "Nao foi possivel localizar email do cliente para envio." },
          { status: 400 },
        );
      }
      if ((tipoenvio === "3" || tipoenvio === "6") && !preferredPhone) {
        return NextResponse.json(
          {
            error:
              tipoenvio === "6"
                ? "Nao foi possivel localizar telefone celular ativo para envio por WhatsApp."
                : "Nao foi possivel localizar telefone celular ativo para envio por SMS.",
          },
          { status: 400 },
        );
      }
    }

    const results: Array<SuccessfulCloseItem | ErrorCloseItem> = [];
    const pendingAgreements: PendingAgreementClose[] = [];
    const titleItems = payload.items.filter((item) => (item.processingMode ?? "negociacao") === "titulo");
    const negotiationItems = payload.items.filter((item) => (item.processingMode ?? "negociacao") !== "titulo");

    for (const { contract, selectedOption: incomingSelectedOption, selectedTitleIds } of titleItems) {
      const mode = "titulo";
      try {
        let boleto: SuccessfulCloseItem["boleto"] = null;
        try {
          boleto = await emitTituloBoletos(
            contract,
            token,
            requestedTipoenvio,
            operatorIdPes,
            Boolean(payload.emitAllOpenTitles),
            selectedTitleIds,
            preferredPhone,
            preferredEmail,
          );
        } catch (error) {
          withStep("Emissao de boleto do titulo", error);
        }

        let andamento: SuccessfulCloseItem["andamento"] = null;
        try {
          andamento = await registerAndamento(
            contract.idCon,
            contract.numeroContrato,
            contract.idServ,
            cpf,
            preferredPhone ?? "",
            token,
            boletoCode,
            operatorIdPes,
            incomingSelectedOption?.valorNegociar,
            payload.vencPrimParcela,
          );
        } catch (error) {
          withStep("Registro de andamento do titulo", error);
        }
        results.push({
          status: "success",
          mode,
          contract,
          selectedOption: incomingSelectedOption ?? null,
          gravacao: null,
          boleto,
          andamento,
        });
      } catch (error) {
        results.push({
          status: "error",
          mode,
          contract,
          error: error instanceof Error ? error.message : "Falha ao processar fechamento.",
        });
      }
    }
    const negotiationStageResults = await mapWithConcurrencyLimit(
      negotiationItems,
      CLOSE_CONCURRENCY_LIMIT,
      async ({ contract, processingMode, selectedOption: incomingSelectedOption }) => {
        const mode = processingMode === "titulo" ? "titulo" : "negociacao";
        try {
          const selected = incomingSelectedOption ?? null;
          if (!selected) {
            throw new Error(`Nenhuma opcao de ${negotiationKind} foi enviada para o contrato.`);
          }

          const vencimentoPrimeira = payload.vencPrimParcela;
          let gravado;
          try {
            gravado = await gravarNegociacao({
              idCon: contract.idCon,
              idServ: contract.idServ,
              titulos: "",
              plano: selected.plano,
              codigoFaixa: selected.codigoFaixa,
              descricaoFaixa: selected.descricaoFaixa,
              parcelasNum: selected.parcelasNum,
              valordesconto: selected.valorDesconto,
              vencimentoprimeira: vencimentoPrimeira,
              valorprimeira: selected.valorPrimeira,
              valororiginal: selected.valorOriginal,
              valorcorrigido: selected.valorCorrigido || selected.valorNegociar,
              valornegociar: selected.valorNegociar,
              valordemais: selected.valorDemais,
              prazomaximo: "",
              tiponegociacao,
              boletodisponivel: negotiationKind === "promessa" ? "0" : "1",
              tpDesconto: "0",
              percDescAplicNoPrincipal: "",
              percDescAplicNaCorrecao: "",
              percDescAplicNosHonorarios: "",
              percDescAplicNaPontualidade: "",
              percDescAplicNaMulta: "",
              percDescAplicNoJuros: "",
              valorAplicNoJuros: "",
              valorEntradaSugerido: "",
              valorTotalSugerido: "",
              codigoNegociacao: "",
              infoNegociacao: "",
              especiePagamento: "",
              codigoToken: token,
              dtSegundaParcela: "",
              idPesReal: operatorIdPes,
              origemReal: "Ativo",
              percDescAplicNaAntecipacao: "",
              formaEnvioBoleto: negotiationKind === "promessa" ? undefined : "1",
              valorDespesas: "",
            });
          } catch (error) {
            withStep("GravarNegociacao", error);
          }
          ensureSoapSuccess("GravarNegociacao", gravado.codigoRetorno, gravado.mensagemRetorno);

          const parcelaIdRetorno: string | null = gravado.idParcela;
          if (negotiationKind === "acordo") {
            return {
              kind: "pending_agreement" as const,
              contract,
              selected,
              gravado: {
                codigoRetorno: gravado.codigoRetorno,
                mensagemRetorno: gravado.mensagemRetorno,
                idParcela: parcelaIdRetorno,
              },
              vencimentoPrimeira,
            };
          }

          let andamento: SuccessfulCloseItem["andamento"] = null;
          try {
            andamento = await registerAndamento(
              contract.idCon,
              contract.numeroContrato,
              contract.idServ,
              cpf,
              preferredPhone ?? "",
              token,
              agreementCode,
              operatorIdPes,
              selected.valorNegociar,
              vencimentoPrimeira,
            );
          } catch (error) {
            withStep("Registro de andamento do contrato", error);
          }
          return {
            kind: "result" as const,
            value: {
              status: "success",
              mode,
              contract,
              selectedOption: selected,
              gravacao: {
                codigoRetorno: gravado.codigoRetorno,
                mensagemRetorno: gravado.mensagemRetorno,
                idParcela: parcelaIdRetorno,
              },
              boleto: null,
              andamento,
            } satisfies SuccessfulCloseItem,
          };
        } catch (error) {
          return {
            kind: "result" as const,
            value: {
              status: "error",
              mode,
              contract,
              error: error instanceof Error ? error.message : "Falha ao processar fechamento.",
            } satisfies ErrorCloseItem,
          };
        }
      },
    );

    for (const item of negotiationStageResults) {
      if (item.kind === "pending_agreement") {
        pendingAgreements.push(item);
      } else {
        results.push(item.value);
      }
    }

    if (pendingAgreements.length > 0) {
      let refreshedDadosDividaXml = "";
      for (let attempt = 0; attempt < 3 && !refreshedDadosDividaXml; attempt += 1) {
        try {
          const dadosDivida = await getDadosDivida({
            cnpjcpf: cpf,
            agrupamento: "BEMOL",
            atualizarDivida: "1",
            codigoToken: token,
          });
          refreshedDadosDividaXml = dadosDivida.xml;
        } catch (error) {
          if (attempt === 2) {
            withStep("GetDadosDivida apos gravacao", error);
          }
        }
        if (!refreshedDadosDividaXml && attempt < 2) {
          await wait(700);
        }
      }

      const agreementResults = await mapWithConcurrencyLimit(
        pendingAgreements,
        CLOSE_CONCURRENCY_LIMIT,
        async (pending) => {
          try {
            const agreementDebug = getAgreementEmissionDebug(
              refreshedDadosDividaXml,
              pending.contract.idCon,
              pending.contract.idServ,
            );
            const agreementParcelId =
              parseAgreementParcelId(refreshedDadosDividaXml, pending.contract.idCon, pending.contract.idServ) ||
              pending.gravado.idParcela;

            if (!agreementParcelId) {
              const details = [
                `gravado.idParcela=${pending.gravado.idParcela ?? "vazio"}`,
                `contratoEncontrado=${agreementDebug.contractFound ? "sim" : "nao"}`,
                `acordoEncontrado=${agreementDebug.acordoFound ? "sim" : "nao"}`,
                `candidatos=${agreementDebug.candidates.length ? agreementDebug.candidates.join(",") : "nenhum"}`,
              ].join(" | ");
              throw new Error(
                `A negociacao foi gravada, mas nao foi possivel localizar a parcela do acordo para emissao. ${details}`,
              );
            }

            const boletoResponse = await emitAgreementBoleto(
              pending.contract,
              agreementParcelId,
              token,
              tipoenvio,
              operatorIdPes,
              preferredPhone ?? "",
              preferredEmail ?? "",
            );

            const andamento = await registerAndamento(
              pending.contract.idCon,
              pending.contract.numeroContrato,
              pending.contract.idServ,
              cpf,
              preferredPhone ?? "",
              token,
              agreementCode,
              operatorIdPes,
              pending.selected.valorNegociar,
              pending.vencimentoPrimeira,
            );

            return {
              status: "success",
              mode: "negociacao",
              contract: pending.contract,
              selectedOption: pending.selected,
              gravacao: {
                codigoRetorno: pending.gravado.codigoRetorno,
                mensagemRetorno: pending.gravado.mensagemRetorno,
                idParcela: agreementParcelId,
              },
              boleto: boletoResponse
                ? {
                  codigoRetorno: boletoResponse.codigoRetorno,
                  mensagemRetorno: boletoResponse.mensagemRetorno,
                  linhaDigitavel: boletoResponse.linhaDigitavel,
                  pixCopiaCola: boletoResponse.pixCopiaCola,
                  boletoUrl: boletoResponse.boletoUrl,
                }
                : null,
              andamento,
            } satisfies SuccessfulCloseItem;
          } catch (error) {
            return {
              status: "error",
              mode: "negociacao",
              contract: pending.contract,
              error: error instanceof Error ? error.message : "Falha ao processar fechamento.",
            } satisfies ErrorCloseItem;
          }
        },
      );

      results.push(...agreementResults);
    }

    clearNegotiationCache(
      results
        .filter((item) => item.status === "success")
        .map((item) => ({ idCon: item.contract.idCon, idServ: item.contract.idServ })),
    );

    const successCount = results.filter((item) => item.status === "success").length;
    const boletoGenerated = results.filter(
      (item) => item.status === "success" && (item.boleto?.linhaDigitavel || item.boleto?.pixCopiaCola || item.boleto?.boletoUrl),
    ).length;

    return NextResponse.json({
      negotiationKind,
      operatorIdPes,
      operatorNome: payload.operatorNome ?? "",
      tipoenvio,
      summary: {
        processed: results.length,
        success: successCount,
        failed: results.length - successCount,
        boletoGenerated,
      },
      items: results,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Falha ao fechar a negociacao." },
      { status: 500 },
    );
  }
}












