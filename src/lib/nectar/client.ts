import { appendFileSync, mkdirSync } from "node:fs";
import nodePath from "node:path";
import { buildSoapEnvelope, escapeXml, extractTagValue, parseMoney } from "@/lib/nectar/xml";
import type {
  BoletoAcordoParams,
  BoletoAcordoResult,
  GetDadosDevedorResult,
  GravarNegociacaoParams,
  GravarNegociacaoResult,
  InsereAndamentoParams,
  InsereAndamentoResult,
  NectarConfig,
  NectarContract,
  NectarDebtTitle,
  NectarNegotiationOption,
} from "@/lib/nectar/types";

const SERVICE_URL =
  process.env.NECTAR_BASE_URL?.trim() || "https://example.invalid/WSNectar/Servicos/ServicoNectar.svc";
const ACTION_BASE = "http://tempuri.org/IServicoNectar";

type TokenCacheEntry = {
  token: string;
  expiresAt: number;
};

type NegotiationCacheEntry = {
  options: NectarNegotiationOption[];
  xml: string;
  expiresAt: number;
};

const tokenCache = new Map<string, TokenCacheEntry>();
const negotiationCache = new Map<string, NegotiationCacheEntry>();

function getTokenCacheKey(config: NectarConfig): string {
  return `${config.cnpj}:${config.codigoParceiro}:${config.usuario}`;
}

function clearTokenCache(): void {
  tokenCache.clear();
}

function logInvalidToken(event: { method: string; detail: string; recovered?: boolean; xml?: string }): void {
  try {
    const logDir = nodePath.join(process.cwd(), "Saidas");
    mkdirSync(logDir, { recursive: true });
    const logPath = nodePath.join(logDir, "token-invalid.log");
    const preview = (event.xml ?? "").replace(/\s+/g, " ").slice(0, 400);
    const line = `[${new Date().toISOString()}] method=${event.method} recovered=${event.recovered ? "yes" : "no"} detail=${event.detail}${preview ? ` xml=${preview}` : ""}\n`;
    appendFileSync(logPath, line, "utf8");
  } catch {}
}

function isInvalidTokenXml(xml: string): boolean {
  const code = (
    extractTagValue(xml, ['CodigoMensagem']) ??
    extractTagValue(xml, ['codigoMensagem']) ??
    ''
  ).trim();
  const message = (
    extractTagValue(xml, ['Mensagem']) ??
    extractTagValue(xml, ['mensagem']) ??
    ''
  ).toLowerCase();

  return code === '000010' || (message.includes('token') && (message.includes('v?lido') || message.includes('valido') || message.includes('v??lido')));
}

export function clearNegotiationCache(contracts?: Array<{ idCon?: string; idServ?: string }>): void {
  if (!contracts?.length) {
    negotiationCache.clear();
    return;
  }
  for (const key of Array.from(negotiationCache.keys())) {
    if (contracts.some((contract) => contract.idCon && contract.idServ && key.startsWith(`${contract.idCon}|${contract.idServ}|`))) {
      negotiationCache.delete(key);
    }
  }
}

function getConfig(): NectarConfig {
  const cnpj = process.env.NECTAR_CNPJ?.trim() ?? "";
  const codigoParceiro = process.env.NECTAR_CODIGO_PARCEIRO?.trim() ?? "";
  const usuario = process.env.NECTAR_USUARIO?.trim() ?? "";
  const senha = process.env.NECTAR_SENHA?.trim() ?? "";
  if (!cnpj || !codigoParceiro || !usuario || !senha) {
    throw new Error("Credenciais da API WS SGC ausentes. Configure NECTAR_CNPJ, NECTAR_CODIGO_PARCEIRO, NECTAR_USUARIO e NECTAR_SENHA.");
  }
  return { cnpj, codigoParceiro, usuario, senha };
}

async function callSoap(methodName: string, methodBody: string): Promise<string> {
  const action = `${ACTION_BASE}/${methodName}`;
  const xml = buildSoapEnvelope(action, methodName, methodBody);
  const controller = new AbortController();
  const timeoutMs = 35000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(SERVICE_URL, {
      method: "POST",
      headers: {
        "Content-Type": `application/soap+xml; charset=utf-8; action="${action}"`,
        Accept: "application/soap+xml",
        Connection: "close",
      },
      body: xml,
      cache: "no-store",
      signal: controller.signal,
    });

    const responseText = await response.text();
    if (!response.ok) {
      throw new Error(`Erro HTTP SOAP (${response.status}): ${responseText.slice(0, 500)}`);
    }

    return responseText;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Timeout ao chamar ${methodName} na API Nectar (${timeoutMs / 1000}s).`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function getToken(forceRefresh = false): Promise<string> {
  const config = getConfig();
  const cacheKey = getTokenCacheKey(config);
  const cache = tokenCache.get(cacheKey);
  if (!forceRefresh && cache && cache.expiresAt > Date.now()) {
    return cache.token;
  }

  const body = [
    `<tem:cnpj>${escapeXml(config.cnpj)}</tem:cnpj>`,
    `<tem:codigoParceiro>${escapeXml(config.codigoParceiro)}</tem:codigoParceiro>`,
    `<tem:usu>${escapeXml(config.usuario)}</tem:usu>`,
    `<tem:pass>${escapeXml(config.senha)}</tem:pass>`,
  ].join("");

  const xml = await callSoap("GetToken", body);
  const token =
    extractTagValue(xml, ["CodigoToken", "codigoToken", "GetTokenResult"]) ??
    extractTagValue(xml, ["string"]);
  if (!token) {
    throw new Error(`Nao foi possivel extrair CodigoToken da resposta SOAP: ${xml.slice(0, 500)}`);
  }

  tokenCache.set(cacheKey, {
    token,
    // Regra operacional informada: token com validade de ate 1h30
    expiresAt: Date.now() + 60 * 60 * 1000,
  });

  return token;
}

export async function getDadosDivida(params: {
  cnpjcpf: string;
  agrupamento: string;
  atualizarDivida?: "0" | "1";
  codigoToken: string;
  debugIdCon?: string;
}): Promise<{ xml: string; contracts: NectarContract[]; parseDebug?: ContractParseDebugTrace }> {
  const config = getConfig();
  const run = async (codigoToken: string) => {
    const body = [
      `<tem:cnpjcpf>${escapeXml(params.cnpjcpf)}</tem:cnpjcpf>`,
      `<tem:agrupamento>${escapeXml(params.agrupamento)}</tem:agrupamento>`,
      `<tem:atualizarDivida>${params.atualizarDivida ?? "1"}</tem:atualizarDivida>`,
      `<tem:codigoParceiro>${escapeXml(config.codigoParceiro)}</tem:codigoParceiro>`,
      `<tem:codigoToken>${escapeXml(codigoToken)}</tem:codigoToken>`,
    ].join("");

    return callSoap("GetDadosDivida", body);
  };

  let xml = await run(params.codigoToken);
  if (isInvalidTokenXml(xml)) {
    logInvalidToken({ method: "GetDadosDivida", detail: `cnpjcpf=${params.cnpjcpf}`, xml });
    clearTokenCache();
    const refreshedToken = await getToken(true);
    xml = await run(refreshedToken);
    logInvalidToken({ method: "GetDadosDivida", detail: `cnpjcpf=${params.cnpjcpf}`, recovered: !isInvalidTokenXml(xml), xml });
  }

  const parsed = parseContracts(xml, params.debugIdCon);
  return { xml, contracts: parsed.contracts, parseDebug: parsed.parseDebug };
}

export async function getOpcoesNegociacao(params: {
  idCon: string;
  idServ: string;
  vencPrimParcela: string;
  titulos?: string;
  parcelasNum?: string;
  tiponegociacao?: string;
  tpDesconto?: string;
  percDescAplicNoPrincipal?: string;
  percDescAplicNaCorrecao?: string;
  percDescAplicNosHonorarios?: string;
  percDescAplicNaPontualidade?: string;
  percDescAplicNaMulta?: string;
  percDescAplicNoJuros?: string;
  valorAplicNoJuros?: string;
  valorEntradaSugerido?: string;
  valordemais?: string;
  valorTotalSugerido?: string;
  valorParcelaSugerido?: string;
  dtSegundaParcela?: string;
  percDescAplicNaAntecipacao?: string;
  condicaoEnquadramento?: string;
  idPesReal?: string;
  origemReal?: string;
  tipoNegociacaoDetalhe?: string;
  especiePagamento?: string;
  codigoToken: string;
}): Promise<{ xml: string; options: NectarNegotiationOption[] }> {
  const cacheKey = [
    params.idCon,
    params.idServ,
    params.vencPrimParcela || "null",
    params.tiponegociacao ?? "3",
    params.tpDesconto ?? "1",
  ].join("|");
  const cached = getNegotiationCache(cacheKey);
  if (cached) {
    return cached;
  }

  const config = getConfig();
  const run = async (codigoToken: string) => {
    const body = [
      `<tem:idCon>${escapeXml(params.idCon)}</tem:idCon>`,
      `<tem:idServ>${escapeXml(params.idServ)}</tem:idServ>`,
      `<tem:titulos>${escapeXml(params.titulos ?? "")}</tem:titulos>`,
      `<tem:parcelasNum>${escapeXml(params.parcelasNum ?? "")}</tem:parcelasNum>`,
      `<tem:vencPrimParcela>${escapeXml(params.vencPrimParcela || "null")}</tem:vencPrimParcela>`,
      `<tem:tiponegociacao>${escapeXml(params.tiponegociacao ?? "3")}</tem:tiponegociacao>`,
      `<tem:tpDesconto>${escapeXml(params.tpDesconto ?? "1")}</tem:tpDesconto>`,
      `<tem:percDescAplicNoPrincipal>${escapeXml(params.percDescAplicNoPrincipal ?? "")}</tem:percDescAplicNoPrincipal>`,
      `<tem:percDescAplicNaCorrecao>${escapeXml(params.percDescAplicNaCorrecao ?? "")}</tem:percDescAplicNaCorrecao>`,
      `<tem:percDescAplicNosHonorarios>${escapeXml(params.percDescAplicNosHonorarios ?? "")}</tem:percDescAplicNosHonorarios>`,
      `<tem:percDescAplicNaPontualidade>${escapeXml(params.percDescAplicNaPontualidade ?? "")}</tem:percDescAplicNaPontualidade>`,
      `<tem:percDescAplicNaMulta>${escapeXml(params.percDescAplicNaMulta ?? "")}</tem:percDescAplicNaMulta>`,
      `<tem:percDescAplicNoJuros>${escapeXml(params.percDescAplicNoJuros ?? "")}</tem:percDescAplicNoJuros>`,
      `<tem:valorAplicNoJuros>${escapeXml(params.valorAplicNoJuros ?? "")}</tem:valorAplicNoJuros>`,
      `<tem:valorEntradaSugerido>${escapeXml(params.valorEntradaSugerido ?? "")}</tem:valorEntradaSugerido>`,
      `<tem:valordemais>${escapeXml(params.valordemais ?? "")}</tem:valordemais>`,
      `<tem:valorTotalSugerido>${escapeXml(params.valorTotalSugerido ?? "")}</tem:valorTotalSugerido>`,
      `<tem:valorParcelaSugerido>${escapeXml(params.valorParcelaSugerido ?? "")}</tem:valorParcelaSugerido>`,
      `<tem:codigoParceiro>${escapeXml(config.codigoParceiro)}</tem:codigoParceiro>`,
      `<tem:codigoToken>${escapeXml(codigoToken)}</tem:codigoToken>`,
      `<tem:dtSegundaParcela>${escapeXml(params.dtSegundaParcela ?? "")}</tem:dtSegundaParcela>`,
      `<tem:percDescAplicNaAntecipacao>${escapeXml(params.percDescAplicNaAntecipacao ?? "")}</tem:percDescAplicNaAntecipacao>`,
      `<tem:condicaoEnquadramento>${escapeXml(params.condicaoEnquadramento ?? "")}</tem:condicaoEnquadramento>`,
      `<tem:idPesReal>${escapeXml(params.idPesReal ?? "")}</tem:idPesReal>`,
      `<tem:origemReal>${escapeXml(params.origemReal ?? "Ativo")}</tem:origemReal>`,
      `<tem:tipoNegociacaoDetalhe>${escapeXml(params.tipoNegociacaoDetalhe ?? "")}</tem:tipoNegociacaoDetalhe>`,
      `<tem:especiePagamento>${escapeXml(params.especiePagamento ?? "")}</tem:especiePagamento>`,
    ].join("");

    return callSoap("GetOpcoesNegociacao", body);
  };

  let xml = await run(params.codigoToken);
  if (isInvalidTokenXml(xml)) {
    logInvalidToken({ method: "GetOpcoesNegociacao", detail: `idCon=${params.idCon} idServ=${params.idServ}`, xml });
    clearTokenCache();
    const refreshedToken = await getToken(true);
    xml = await run(refreshedToken);
    logInvalidToken({ method: "GetOpcoesNegociacao", detail: `idCon=${params.idCon} idServ=${params.idServ}`, recovered: !isInvalidTokenXml(xml), xml });
  }
  const parsed = { xml, options: parseNegotiationOptions(xml) };
  setNegotiationCache(cacheKey, parsed);
  return parsed;
}

export async function gravarNegociacao(params: GravarNegociacaoParams): Promise<GravarNegociacaoResult> {
  const config = getConfig();
  const valordemaisValue =
    params.parcelasNum > 1 && Number.isFinite(params.valordemais) && params.valordemais > 0
      ? money(params.valordemais)
      : "";

  const body = [
    `<tem:idCon>${escapeXml(params.idCon)}</tem:idCon>`,
    `<tem:idServ>${escapeXml(params.idServ)}</tem:idServ>`,
    `<tem:titulos>${escapeXml(params.titulos ?? "")}</tem:titulos>`,
    `<tem:plano>${escapeXml(params.plano)}</tem:plano>`,
    `<tem:codigoFaixa>${escapeXml(params.codigoFaixa)}</tem:codigoFaixa>`,
    `<tem:descricaoFaixa>${escapeXml(params.descricaoFaixa)}</tem:descricaoFaixa>`,
    `<tem:parcelasNum>${params.parcelasNum}</tem:parcelasNum>`,
    `<tem:valordesconto>${money(params.valordesconto)}</tem:valordesconto>`,
    `<tem:vencimentoprimeira>${escapeXml(params.vencimentoprimeira)}</tem:vencimentoprimeira>`,
    `<tem:valorprimeira>${money(params.valorprimeira)}</tem:valorprimeira>`,
    `<tem:valororiginal>${money(params.valororiginal)}</tem:valororiginal>`,
    `<tem:valorcorrigido>${money(params.valorcorrigido)}</tem:valorcorrigido>`,
    `<tem:valornegociar>${money(params.valornegociar)}</tem:valornegociar>`,
    `<tem:valordemais>${valordemaisValue}</tem:valordemais>`,
    `<tem:prazomaximo>${escapeXml(params.prazomaximo ?? "")}</tem:prazomaximo>`,
    `<tem:tiponegociacao>${escapeXml(params.tiponegociacao ?? "3")}</tem:tiponegociacao>`,
    `<tem:boletodisponivel>${escapeXml(params.boletodisponivel ?? "1")}</tem:boletodisponivel>`,
    `<tem:tpDesconto>${escapeXml(params.tpDesconto ?? "0")}</tem:tpDesconto>`,
    `<tem:percDescAplicNoPrincipal>${escapeXml(params.percDescAplicNoPrincipal ?? "")}</tem:percDescAplicNoPrincipal>`,
    `<tem:percDescAplicNaCorrecao>${escapeXml(params.percDescAplicNaCorrecao ?? "")}</tem:percDescAplicNaCorrecao>`,
    `<tem:percDescAplicNosHonorarios>${escapeXml(params.percDescAplicNosHonorarios ?? "")}</tem:percDescAplicNosHonorarios>`,
    `<tem:percDescAplicNaPontualidade>${escapeXml(params.percDescAplicNaPontualidade ?? "")}</tem:percDescAplicNaPontualidade>`,
    `<tem:percDescAplicNaMulta>${escapeXml(params.percDescAplicNaMulta ?? "")}</tem:percDescAplicNaMulta>`,
    `<tem:percDescAplicNoJuros>${escapeXml(params.percDescAplicNoJuros ?? "")}</tem:percDescAplicNoJuros>`,
    `<tem:valorAplicNoJuros>${escapeXml(params.valorAplicNoJuros ?? "")}</tem:valorAplicNoJuros>`,
    `<tem:valorEntradaSugerido>${escapeXml(params.valorEntradaSugerido ?? "")}</tem:valorEntradaSugerido>`,
    `<tem:valorTotalSugerido>${escapeXml(params.valorTotalSugerido ?? "")}</tem:valorTotalSugerido>`,
    `<tem:codigoNegociacao>${escapeXml(params.codigoNegociacao ?? "")}</tem:codigoNegociacao>`,
    `<tem:infoNegociacao>${escapeXml(params.infoNegociacao ?? "")}</tem:infoNegociacao>`,
    `<tem:especiePagamento>${escapeXml(params.especiePagamento ?? "")}</tem:especiePagamento>`,
    `<tem:codigoParceiro>${escapeXml(config.codigoParceiro)}</tem:codigoParceiro>`,
    `<tem:codigoToken>${escapeXml(params.codigoToken)}</tem:codigoToken>`,
    `<tem:dtSegundaParcela>${escapeXml(params.dtSegundaParcela ?? "")}</tem:dtSegundaParcela>`,
    `<tem:idPesReal>${escapeXml(params.idPesReal ?? "")}</tem:idPesReal>`,
    `<tem:origemReal>${escapeXml(params.origemReal ?? "")}</tem:origemReal>`,
    `<tem:percDescAplicNaAntecipacao>${escapeXml(params.percDescAplicNaAntecipacao ?? "")}</tem:percDescAplicNaAntecipacao>`,
    `<tem:formaEnvioBoleto>${escapeXml(params.formaEnvioBoleto ?? "")}</tem:formaEnvioBoleto>`,
    `<tem:valorDespesas>${escapeXml(params.valorDespesas ?? "")}</tem:valorDespesas>`,
  ].join("");

  const xml = await callSoap("GravarNegociacao", body);
  return {
    xml,
    codigoRetorno: extractTagValue(xml, ["CodigoRetorno", "codigoRetorno", "codigoretorno", "CodigoMensagem"]),
    mensagemRetorno: extractTagValue(xml, ["MensagemRetorno", "mensagemRetorno", "msgRetorno", "Mensagem"]),
    idParcela: extractTagValue(xml, [
      "IDBOLETO",
      "IdBoleto",
      "idBoleto",
      "idboleto",
      "IDParcela",
      "IdParcela",
      "idParcela",
      "idparcela",
    ]),
  };
}

export async function getBoletoAcordo(params: BoletoAcordoParams): Promise<BoletoAcordoResult> {
  const config = getConfig();
  const tipo = params.tipo ?? "ACORDO";
  const body = [
    `<tem:tipo>${escapeXml(tipo)}</tem:tipo>`,
    `<tem:idboleto>${escapeXml(params.idboleto)}</tem:idboleto>`,
    `<tem:idcon>${escapeXml(params.idcon)}</tem:idcon>`,
    `<tem:plano></tem:plano>`,
    `<tem:idserv>${escapeXml(params.idserv)}</tem:idserv>`,
    `<tem:dtprorrogacao></tem:dtprorrogacao>`,
    `<tem:dtvencimento>${escapeXml(params.dtvencimento ?? "")}</tem:dtvencimento>`,
    `<tem:tipoenvio>${escapeXml(params.tipoenvio ?? "1")}</tem:tipoenvio>`,
    `<tem:complementoenvio></tem:complementoenvio>`,
    `<tem:gerarPdf>${params.gerarPdf ?? "1"}</tem:gerarPdf>`,
    `<tem:imprimirPlanilha>0</tem:imprimirPlanilha>`,
    `<tem:imprimirTermo>0</tem:imprimirTermo>`,
    `<tem:nomeTermo></tem:nomeTermo>`,
    `<tem:codigoBoleto></tem:codigoBoleto>`,
    `<tem:emailEnvio>${escapeXml(params.emailEnvio ?? "")}</tem:emailEnvio>`,
    `<tem:celularEnvio>${escapeXml(params.celularEnvio ?? "")}</tem:celularEnvio>`,
    `<tem:especiePagamento>${escapeXml(params.especiePagamento ?? "")}</tem:especiePagamento>`,
    `<tem:tipoPixEspecie>${escapeXml(params.tipoPixEspecie ?? "")}</tem:tipoPixEspecie>`,
    `<tem:valorBoleto>${escapeXml(params.valorBoleto ?? "")}</tem:valorBoleto>`,
    `<tem:boletoQuitacao>${escapeXml(params.boletoQuitacao ?? "")}</tem:boletoQuitacao>`,
    `<tem:geraPix>${params.geraPix ?? "1"}</tem:geraPix>`,
    `<tem:codigoParceiro>${escapeXml(config.codigoParceiro)}</tem:codigoParceiro>`,
    `<tem:codigoToken>${escapeXml(params.codigoToken)}</tem:codigoToken>`,
    `<tem:idPesReal>${escapeXml(params.idPesReal ?? "")}</tem:idPesReal>`,
    `<tem:origemReal>${escapeXml(params.origemReal ?? "Ativo")}</tem:origemReal>`,
    `<tem:imprimirCertDigital></tem:imprimirCertDigital>`,
    `<tem:geolocalizacao><tem:ip></tem:ip><tem:porta></tem:porta><tem:latitude></tem:latitude><tem:longitude></tem:longitude></tem:geolocalizacao>`,
  ].join("");

  const xml = await callSoap("GetBoletoAcordo", body);
  return {
    xml,
    codigoRetorno: extractTagValue(xml, ["CodigoRetorno", "codigoRetorno", "codigoretorno", "CodigoMensagem"]),
    mensagemRetorno: extractTagValue(xml, ["MensagemRetorno", "mensagemRetorno", "msgRetorno", "Mensagem"]),
    linhaDigitavel: extractTagValue(xml, ["linha_digitavel", "LinhaDigitavel", "linhadigitavel"]),
    pixCopiaCola: extractTagValue(xml, ["pix_copia_cola", "pixCopiaCola", "pixcopiacola"]),
    boletoUrl: extractTagValue(xml, ["urlBoleto", "URLBoleto", "linkBoleto", "BoletoURL"]),
  };
}

export async function getDadosDevedor(params: {
  cpf?: string;
  cnpjcpf?: string;
  codigoToken: string;
}): Promise<GetDadosDevedorResult> {
  const config = getConfig();
  const cpfDigits = (params.cpf ?? params.cnpjcpf ?? "").replace(/\D/g, "");
  const body = [
    `<tem:cnpjcpf>${escapeXml(cpfDigits)}</tem:cnpjcpf>`,
    `<tem:tels>1</tem:tels>`,
    `<tem:ends>0</tem:ends>`,
    `<tem:emails>1</tem:emails>`,
    `<tem:codigoParceiro>${escapeXml(config.codigoParceiro)}</tem:codigoParceiro>`,
    `<tem:codigoToken>${escapeXml(params.codigoToken)}</tem:codigoToken>`,
  ].join("");

  const xml = await callSoap("GetDadosDevedor", body);
  return {
    xml,
    preferredPhone: extractPreferredPhone(xml),
    preferredEmail: extractPreferredEmail(xml),
  };
}

export async function insereAndamento(params: InsereAndamentoParams): Promise<InsereAndamentoResult> {
  const config = getConfig();
  const useContractLookup = Boolean((params.idCon ?? "").trim() && (params.idServ ?? "").trim());
  const body = [
    `<tem:IDCON>${escapeXml(params.idCon ?? "")}</tem:IDCON>`,
    `<tem:IDSERV>${escapeXml(params.idServ ?? "")}</tem:IDSERV>`,
    `<tem:cpf>${escapeXml(useContractLookup ? "" : params.cpf)}</tem:cpf>`,
    `<tem:codigoParceiro>${escapeXml(config.codigoParceiro)}</tem:codigoParceiro>`,
    `<tem:codigoToken>${escapeXml(params.codigoToken)}</tem:codigoToken>`,
    `<tem:codigoandamento>${escapeXml(params.codigoandamento)}</tem:codigoandamento>`,
    `<tem:subOcorrencia>${escapeXml(params.subOcorrencia ?? "")}</tem:subOcorrencia>`,
    `<tem:dataandamento>${escapeXml(params.dataandamento)}</tem:dataandamento>`,
    `<tem:dataAgendamento>${escapeXml(params.dataAgendamento ?? "")}</tem:dataAgendamento>`,
    `<tem:dataPagamento>${escapeXml(params.dataPagamento ?? "")}</tem:dataPagamento>`,
    `<tem:valor>${params.valor != null ? andamentoMoney(params.valor) : ""}</tem:valor>`,
    `<tem:telefone>${escapeXml(params.telefone ?? "")}</tem:telefone>`,
    `<tem:complemento>${escapeXml(params.complemento ?? "")}</tem:complemento>`,
    `<tem:referencia>${escapeXml(params.referencia ?? "")}</tem:referencia>`,
    `<tem:protocolo>${escapeXml(params.protocolo ?? "")}</tem:protocolo>`,
    `<tem:tempoAndamento>${escapeXml(params.tempoAndamento ?? "")}</tem:tempoAndamento>`,
    `<tem:idPesReal>${escapeXml(params.idPesReal ?? "")}</tem:idPesReal>`,
  ].join("");

  const xml = await callSoap("InsereAndamento", body);
  return {
    xml,
    codigoRetorno: extractTagValue(xml, ["CodigoRetorno", "codigoRetorno", "codigoretorno", "CodigoMensagem"]),
    mensagemRetorno: extractTagValue(xml, ["MensagemRetorno", "mensagemRetorno", "msgRetorno", "Mensagem"]),
  };
}

type ContractParseDebugTrace = {
  targetIdCon: string;
  totalContractBlocksFound: number;
  parseValueAfterContractScan: number | null;
  intermediateValueBeforeMapInsert: number | null;
  existingValueBeforeMerge: number | null;
  mergeRuleUsed: "insert" | "replace_max" | "keep_existing" | "not_found";
  mergedValueInMap: number | null;
  finalValueInResponse: number | null;
  matchingKeysSeen: string[];
  pipelineLogs: Array<{ etapa: string; idCon: string; idServ: string; valor: number | string | null }>;
};

function parseContracts(
  xml: string,
  debugIdCon?: string,
): { contracts: NectarContract[]; parseDebug?: ContractParseDebugTrace } {
  const contractsMap = new Map<string, NectarContract>();
  const targetDebugIdCon = (debugIdCon ?? "").trim();
  const parseDebug: ContractParseDebugTrace | undefined = targetDebugIdCon
    ? {
        targetIdCon: targetDebugIdCon,
        totalContractBlocksFound: 0,
        parseValueAfterContractScan: null,
        intermediateValueBeforeMapInsert: null,
        existingValueBeforeMerge: null,
        mergeRuleUsed: "not_found",
        mergedValueInMap: null,
        finalValueInResponse: null,
        matchingKeysSeen: [],
        pipelineLogs: [],
      }
    : undefined;
  const decodedInnerXml = extractTagValue(xml, ["GetDadosDividaResult"]);
  const rawSourceXml = decodedInnerXml && decodedInnerXml.includes("<") ? decodedInnerXml : xml;
  const withoutNsPrefix = rawSourceXml
    .replace(/<[a-zA-Z0-9]+:/g, "<")
    .replace(/<\/[a-zA-Z0-9]+:/g, "</");
  const sourceXml = normalizeContractWrapper(withoutNsPrefix);
  const contractBlocks = extractContractBlocks(sourceXml);
  if (parseDebug) parseDebug.totalContractBlocksFound = contractBlocks.length;

  for (const context of contractBlocks) {
    const idCon = (findInContext(context, ["IDCON", "IdCon", "idCon"]) ?? "").trim();
    if (!idCon) continue;

    const idServ = findInContext(context, ["IDSERV", "IdServ", "idServ", "idserv"]) ?? "0";
    const key = `${idCon}:${idServ}`;
    const rawContract =
      extractContratoFromContractBlock(context) ??
      findInContext(context, ["Contrato", "contrato"]) ??
      idCon;
    const contratoLimpo = sanitizeContractNumber(rawContract, idCon);
    const produto = extractProdutoFromContext(context) ?? "Nao informado";
    const diasAtraso = extractMaxIntFromTags(context, ["DiasAtraso", "diasAtraso"]);
    const valorAtualizadoSomado = sumFromDirectDebtItems(context, ["ValorAtualizado", "valorAtualizado"]);
    const valorOriginalSomado = sumFromDirectDebtItems(context, ["ValorOriginal", "valorOriginal"]);
    const valorFallback = parseMoney(
      findInContext(context, ["ValorAtualizado", "valorAtualizado", "ValorCorrigido", "valorCorrigido"]),
    );
    const titulos = extractDebtTitlesFromContract(context);
    const agreementBlocks = Array.from(context.matchAll(/<Acordo[^>]*>[\s\S]*?<\/Acordo>/gi)).map((match) => match[0]);
    const promiseBlocks = Array.from(context.matchAll(/<Promessa[^>]*>[\s\S]*?<\/Promessa>/gi)).map((match) => match[0]);
    const hasOpenAgreement = agreementBlocks.some((block) => {
      const status = (findInContext(block, ["Status", "status", "Situacao", "situacao", "Ativo", "ativo"]) ?? "").trim().toLowerCase();
      const closeDate = (findInContext(block, ["DataBaixa", "dataBaixa", "DtBaixa", "dtBaixa", "DataCancelamento", "dataCancelamento", "DataEncerramento", "dataEncerramento", "DataQuitacao", "dataQuitacao"]) ?? "").trim();
      if (closeDate) return false;
      if (status && /(^|\b)(^|\b)(false|0|n|nao|n?o|inativo|cancelad[oa]?|baixad[oa]?|encerrad[oa]?|fechad[oa]?|liquidad[oa]?|quitad[oa]?|finalizad[oa]?)(\b|$)(\b|$)/i.test(status)) {
        return false;
      }
      return Boolean(findInContext(block, ["IdAcordo", "IDAcordo", "idAcordo", "IDParcela", "IdParcela", "idParcela"]));
    });
    const hasOpenPromise = promiseBlocks.some((block) => {
      const status = (findInContext(block, ["Status", "status", "Situacao", "situacao", "Ativo", "ativo"]) ?? "").trim().toLowerCase();
      const closeDate = (findInContext(block, ["DataBaixa", "dataBaixa", "DtBaixa", "dtBaixa", "DataCancelamento", "dataCancelamento", "DataEncerramento", "dataEncerramento", "DataQuitacao", "dataQuitacao"]) ?? "").trim();
      if (closeDate) return false;
      if (status && /(^|\b)(^|\b)(false|0|n|nao|n?o|inativo|cancelad[oa]?|baixad[oa]?|encerrad[oa]?|fechad[oa]?|liquidad[oa]?|quitad[oa]?|finalizad[oa]?)(\b|$)(\b|$)/i.test(status)) {
        return false;
      }
      return Boolean(findInContext(block, ["IdPromessa", "IDPromessa", "idPromessa", "IDParcela", "IdParcela", "idParcela"]));
    });
    const hasPossibleActiveAgreement = hasOpenAgreement || hasOpenPromise;
    const valorCorrigido =
      valorAtualizadoSomado > 0
        ? valorAtualizadoSomado
        : valorOriginalSomado > 0
          ? valorOriginalSomado
          : valorFallback;

    if (parseDebug && idCon === parseDebug.targetIdCon) {
      parseDebug.parseValueAfterContractScan = valorCorrigido;
      parseDebug.intermediateValueBeforeMapInsert = valorCorrigido;
      parseDebug.matchingKeysSeen.push(key);
      parseDebug.pipelineLogs.push({ etapa: "A parse", idCon, idServ, valor: valorCorrigido });
      parseDebug.pipelineLogs.push({ etapa: "B beforeInsert", idCon, idServ, valor: valorCorrigido });
    }

    const existing = contractsMap.get(key);
    if (parseDebug && idCon === parseDebug.targetIdCon) {
      parseDebug.existingValueBeforeMerge = existing?.valorCorrigido ?? null;
      parseDebug.pipelineLogs.push({
        etapa: "C merge",
        idCon,
        idServ,
        valor: `existing: ${existing?.valorCorrigido ?? "null"} incoming: ${valorCorrigido}`,
      });
    }
    if (!existing) {
      contractsMap.set(key, {
        idCon,
        idServ,
        numeroContrato: contratoLimpo,
        produto,
        diasAtraso,
        valorCorrigido,
        tiponegociacao: (findInContext(context, ["TipoNegociacao", "tiponegociacao"]) ?? "").trim() || undefined,
        boletodisponivel: (findInContext(context, ["BoletoDisponivel", "boletodisponivel"]) ?? "").trim() || undefined,
        tpDesconto: (findInContext(context, ["TpDesconto", "tpDesconto"]) ?? "").trim() || undefined,
        percDescAplicNoPrincipal: (findInContext(context, ["PercDescAplicNoPrincipal", "percDescAplicNoPrincipal"]) ?? "").trim() || undefined,
        percDescAplicNaCorrecao: (findInContext(context, ["PercDescAplicNaCorrecao", "percDescAplicNaCorrecao"]) ?? "").trim() || undefined,
        percDescAplicNosHonorarios: (findInContext(context, ["PercDescAplicNosHonorarios", "percDescAplicNosHonorarios"]) ?? "").trim() || undefined,
        percDescAplicNaPontualidade: (findInContext(context, ["PercDescAplicNaPontualidade", "percDescAplicNaPontualidade"]) ?? "").trim() || undefined,
        percDescAplicNaMulta: (findInContext(context, ["PercDescAplicNaMulta", "percDescAplicNaMulta"]) ?? "").trim() || undefined,
        percDescAplicNoJuros: (findInContext(context, ["PercDescAplicNoJuros", "percDescAplicNoJuros"]) ?? "").trim() || undefined,
        hasOpenAgreement,
        hasOpenPromise,
        hasPossibleActiveAgreement,
        titulos,
      });
      if (parseDebug && idCon === parseDebug.targetIdCon) {
        parseDebug.mergeRuleUsed = "insert";
        parseDebug.mergedValueInMap = valorCorrigido;
        parseDebug.pipelineLogs.push({ etapa: "D afterMerge", idCon, idServ, valor: valorCorrigido });
      }
      continue;
    }

    // Alguns XMLs repetem o mesmo contrato em blocos diferentes.
    // Para evitar dobrar o valor base, mantemos o maior total encontrado.
    const mergedValue = Math.max(existing.valorCorrigido, valorCorrigido);
    if (parseDebug && idCon === parseDebug.targetIdCon) {
      parseDebug.mergeRuleUsed = mergedValue === valorCorrigido ? "replace_max" : "keep_existing";
      parseDebug.mergedValueInMap = mergedValue;
      parseDebug.pipelineLogs.push({ etapa: "D afterMerge", idCon, idServ, valor: mergedValue });
    }
    existing.valorCorrigido = mergedValue;
    existing.diasAtraso = Math.max(existing.diasAtraso, diasAtraso);
    existing.hasOpenAgreement = existing.hasOpenAgreement || hasOpenAgreement;
    existing.hasOpenPromise = existing.hasOpenPromise || hasOpenPromise;
    existing.hasPossibleActiveAgreement = existing.hasPossibleActiveAgreement || hasPossibleActiveAgreement;
    existing.tiponegociacao ||= (findInContext(context, ["TipoNegociacao", "tiponegociacao"]) ?? "").trim() || undefined;
    existing.boletodisponivel ||= (findInContext(context, ["BoletoDisponivel", "boletodisponivel"]) ?? "").trim() || undefined;
    existing.tpDesconto ||= (findInContext(context, ["TpDesconto", "tpDesconto"]) ?? "").trim() || undefined;
    existing.percDescAplicNoPrincipal ||= (findInContext(context, ["PercDescAplicNoPrincipal", "percDescAplicNoPrincipal"]) ?? "").trim() || undefined;
    existing.percDescAplicNaCorrecao ||= (findInContext(context, ["PercDescAplicNaCorrecao", "percDescAplicNaCorrecao"]) ?? "").trim() || undefined;
    existing.percDescAplicNosHonorarios ||= (findInContext(context, ["PercDescAplicNosHonorarios", "percDescAplicNosHonorarios"]) ?? "").trim() || undefined;
    existing.percDescAplicNaPontualidade ||= (findInContext(context, ["PercDescAplicNaPontualidade", "percDescAplicNaPontualidade"]) ?? "").trim() || undefined;
    existing.percDescAplicNaMulta ||= (findInContext(context, ["PercDescAplicNaMulta", "percDescAplicNaMulta"]) ?? "").trim() || undefined;
    existing.percDescAplicNoJuros ||= (findInContext(context, ["PercDescAplicNoJuros", "percDescAplicNoJuros"]) ?? "").trim() || undefined;
    if (!existing.produto || existing.produto === "Nao informado") existing.produto = produto;
    if (!existing.numeroContrato || existing.numeroContrato === existing.idCon) existing.numeroContrato = contratoLimpo;
    existing.titulos = mergeDebtTitles(existing.titulos ?? [], titulos);
  }

  if (contractsMap.size > 0) {
    const contracts = Array.from(contractsMap.values());
    if (parseDebug) {
      const target = contracts.find((item) => item.idCon === parseDebug.targetIdCon);
      parseDebug.finalValueInResponse = target?.valorCorrigido ?? null;
      parseDebug.pipelineLogs.push({
        etapa: "E response",
        idCon: parseDebug.targetIdCon,
        idServ: target?.idServ ?? "",
        valor: target?.valorCorrigido ?? null,
      });
    }
    return { contracts, parseDebug };
  }

  // fallback quando o XML vier fora do padrao esperado
  const fallbackMatches = Array.from(sourceXml.matchAll(/<(?:\w+:)?idCon[^>]*>([^<]+)<\/(?:\w+:)?idCon>/gi));
  for (const fallback of fallbackMatches) {
    const idCon = fallback[1].trim();
    if (!idCon) continue;
    const key = `${idCon}:0`;
    if (contractsMap.has(key)) continue;
    contractsMap.set(key, {
      idCon,
      idServ: "0",
      numeroContrato: idCon,
      produto: "Nao informado",
      diasAtraso: 0,
      valorCorrigido: 0,
      hasOpenAgreement: false,
      hasOpenPromise: false,
      hasPossibleActiveAgreement: false,
      titulos: [],
    });
  }

  const contracts = Array.from(contractsMap.values());
  if (parseDebug) {
    const target = contracts.find((item) => item.idCon === parseDebug.targetIdCon);
    parseDebug.finalValueInResponse = target?.valorCorrigido ?? null;
    parseDebug.pipelineLogs.push({
      etapa: "E response",
      idCon: parseDebug.targetIdCon,
      idServ: target?.idServ ?? "",
      valor: target?.valorCorrigido ?? null,
    });
  }
  return { contracts, parseDebug };
}

function parseNegotiationOptions(xml: string): NectarNegotiationOption[] {
  const options: NectarNegotiationOption[] = [];
  const decodedInnerXml = extractTagValue(xml, ["GetOpcoesNegociacaoResult"]);
  const sourceXml = decodedInnerXml && decodedInnerXml.includes("<") ? decodedInnerXml : xml;
  const normalizedXml = sourceXml
    .replace(/<[a-zA-Z0-9]+:/g, "<")
    .replace(/<\/[a-zA-Z0-9]+:/g, "</");

  const optionBlocks = Array.from(
    normalizedXml.matchAll(/<OpcoesNegociacao\b[^>]*>[\s\S]*?<\/OpcoesNegociacao>/gi),
  );

  for (const match of optionBlocks) {
    const block = match[0];
    const parcelasNum =
      Number(findInContext(block, ["ParcelasNum", "parcelasNum"])) ||
      Number(findInContext(block, ["Numero", "numero"])) ||
      1;

    const valorPrimeira = parseMoney(
      findInContext(block, ["ValorPrimeira", "valorPrimeira", "ValorEntrada", "valorEntrada"]),
    );
    const valorDemais = parseMoney(
      findInContext(block, ["ValorDemaisParcelas", "valorDemaisParcelas", "ValorDemais", "valordemais"]),
    );
    const valorNegociar = parseMoney(
      findInContext(block, ["ValorNegociar", "valorNegociar", "ValorTotalAcordo", "valorTotalAcordo"]),
    );

    options.push({
      parcelasNum: Number.isFinite(parcelasNum) && parcelasNum > 0 ? parcelasNum : 1,
      valorNegociar,
      valorPrimeira,
      valorDemais,
      valorDesconto: parseMoney(findInContext(block, ["ValorDesconto", "valorDesconto"])),
      valorOriginal: parseMoney(findInContext(block, ["ValorOriginal", "valorOriginal"])),
      valorCorrigido: parseMoney(findInContext(block, ["ValorCorrigido", "valorCorrigido"])),
      vencimentoPrimeira: (findInContext(block, ["VencimentoPrimeira", "vencimentoPrimeira"]) ?? "").trim(),
      plano: (findInContext(block, ["Plano", "plano"]) ?? "").trim(),
      codigoFaixa: (findInContext(block, ["CodigoFaixa", "codigoFaixa"]) ?? "").trim(),
      descricaoFaixa: (findInContext(block, ["DescricaoFaixa", "descricaoFaixa"]) ?? "").trim(),
    });
  }


  if (options.length === 0) {
    const genericBlocks = Array.from(
      normalizedXml.matchAll(/<([^\/?][^>\s]*)\b[^>]*>[\s\S]*?<\/\1>/gi),
    )
      .map((match) => match[0])
      .filter((block) => /<(?:\\w+:)?(?:ParcelasNum|Numero)\\b/i.test(block) && /<(?:\\w+:)?(?:ValorPrimeira|ValorEntrada|ValorNegociar|ValorTotalAcordo)\\b/i.test(block));

    for (const block of genericBlocks) {
      const parcelasNum =
        Number(findInContext(block, ["ParcelasNum", "parcelasNum"])) ||
        Number(findInContext(block, ["Numero", "numero"])) ||
        1;
      const valorPrimeira = parseMoney(
        findInContext(block, ["ValorPrimeira", "valorPrimeira", "ValorEntrada", "valorEntrada"]),
      );
      const valorDemais = parseMoney(
        findInContext(block, ["ValorDemaisParcelas", "valorDemaisParcelas", "ValorDemais", "valordemais"]),
      );
      const valorNegociar = parseMoney(
        findInContext(block, ["ValorNegociar", "valorNegociar", "ValorTotalAcordo", "valorTotalAcordo"]),
      );
      if (!valorPrimeira && !valorNegociar && !valorDemais) continue;

      options.push({
        parcelasNum: Number.isFinite(parcelasNum) && parcelasNum > 0 ? parcelasNum : 1,
        valorNegociar,
        valorPrimeira,
        valorDemais,
        valorDesconto: parseMoney(findInContext(block, ["ValorDesconto", "valorDesconto"])),
        valorOriginal: parseMoney(findInContext(block, ["ValorOriginal", "valorOriginal"])),
        valorCorrigido: parseMoney(findInContext(block, ["ValorCorrigido", "valorCorrigido"])),
        vencimentoPrimeira: (findInContext(block, ["VencimentoPrimeira", "vencimentoPrimeira"]) ?? "").trim(),
        plano: (findInContext(block, ["Plano", "plano"]) ?? "").trim(),
        codigoFaixa: (findInContext(block, ["CodigoFaixa", "codigoFaixa"]) ?? "").trim(),
        descricaoFaixa: (findInContext(block, ["DescricaoFaixa", "descricaoFaixa"]) ?? "Opcao inferida do retorno").trim(),
      });
    }
  }
  if (options.length === 0) {
    const fallback = extractTagValue(xml, ["valornegociar", "valorcorrigido"]);
    if (fallback) {
      options.push({
        parcelasNum: 1,
        valorNegociar: parseMoney(fallback),
        valorPrimeira: parseMoney(fallback),
        valorDemais: 0,
        valorDesconto: 0,
        valorOriginal: 0,
        valorCorrigido: parseMoney(fallback),
        vencimentoPrimeira: "",
        plano: "",
        codigoFaixa: "",
        descricaoFaixa: "Opcao unica inferida do retorno",
      });
    }
  }

  return options;
}

function findInContext(context: string, tagNames: string[]): string | null {
  for (const tagName of tagNames) {
    const regex = new RegExp(`<(?:\\w+:)?${tagName}[^>]*>([\\s\\S]*?)<\\/(?:\\w+:)?${tagName}>`, "i");
    const match = context.match(regex);
    if (match?.[1]) {
      return match[1].trim();
    }
  }
  return null;
}

function money(value: number): string {
  return value.toFixed(2);
}

function andamentoMoney(value: number): string {
  return value.toFixed(2).replace(".", ",");
}

function normalizePhone(raw: string | null | undefined): string {
  return (raw ?? "").replace(/\D/g, "");
}

function extractPreferredPhone(xml: string): string | null {
  const decodedInnerXml = extractTagValue(xml, ["GetDadosDevedorResult"]);
  const sourceXml = decodedInnerXml && decodedInnerXml.includes("<") ? decodedInnerXml : xml;
  const normalized = sourceXml
    .replace(/<[a-zA-Z0-9]+:/g, "<")
    .replace(/<\/[a-zA-Z0-9]+:/g, "</");

  const phoneBlocks = [
    ...Array.from(normalized.matchAll(/<Telefones[^>]*>([\s\S]*?)<\/Telefones>/gi)).map((match) => match[1]),
    ...Array.from(normalized.matchAll(/<Telefone[^>]*>([\s\S]*?)<\/Telefone>/gi)).map((match) => match[1]),
    ...Array.from(normalized.matchAll(/<Contato[^>]*>([\s\S]*?)<\/Contato>/gi)).map((match) => match[1]),
  ];

  const phones = phoneBlocks
    .map((block) => {
      const preferencial = (
        findInContext(block, ["Preferencial", "preferencial", "TelefonePreferencial"]) ?? ""
      ).trim().toLowerCase();
      const possuiWhatsapp = (
        findInContext(block, ["PossuiWhatsApp", "possuiWhatsApp", "Whatsapp", "WhatsApp"]) ?? ""
      ).trim().toLowerCase();
      const ativo = (
        findInContext(block, ["Ativo", "ativo", "Status", "status"]) ?? ""
      ).trim().toLowerCase();
      const tipo = (
        findInContext(block, ["Tipo", "tipo", "TipoTelefone", "tipoTelefone"]) ?? ""
      ).trim().toLowerCase();
      const ddd = normalizePhone(findInContext(block, ["DDD", "Ddd", "ddd"]));
      const numero = normalizePhone(
        findInContext(block, ["Numero", "numero", "Telefone", "telefone", "Celular", "celular"]),
      );
      const completo = normalizePhone(findInContext(block, ["NumeroCompleto", "TelefoneCompleto", "telefoneCompleto"]));
      const value = completo || `${ddd}${numero}`;
      return {
        value,
        preferencial: preferencial === "true" || preferencial === "1" || preferencial === "s",
        ativo: ativo === "" || ativo === "true" || ativo === "1" || ativo === "s" || ativo === "ativo",
        celular: tipo.includes("cel") || tipo.includes("mobi") || value.length >= 11,
        whatsapp: possuiWhatsapp === "true" || possuiWhatsapp === "1" || possuiWhatsapp === "s",
      };
    })
    .filter((item) => item.value);

  const preferred =
    phones.find((item) => item.preferencial && item.ativo && item.celular && item.whatsapp) ??
    phones.find((item) => item.preferencial && item.ativo && item.celular) ??
    phones.find((item) => item.ativo && item.celular && item.whatsapp) ??
    phones.find((item) => item.preferencial && item.ativo) ??
    phones.find((item) => item.ativo && item.celular) ??
    phones.find((item) => item.preferencial) ??
    phones.find((item) => item.ativo) ??
    phones[0];
  if (preferred?.value) return preferred.value;

  const fallback = normalizePhone(
    extractTagValue(normalized, ["TelefonePreferencial", "telefonePreferencial", "Celular", "Telefone"]),
  );
  return fallback || null;
}

function extractPreferredEmail(xml: string): string | null {
  const decodedInnerXml = extractTagValue(xml, ["GetDadosDevedorResult"]);
  const sourceXml = decodedInnerXml && decodedInnerXml.includes("<") ? decodedInnerXml : xml;
  const normalized = sourceXml
    .replace(/<[a-zA-Z0-9]+:/g, "<")
    .replace(/<\/[a-zA-Z0-9]+:/g, "</");

  const emailBlocks = [
    ...Array.from(normalized.matchAll(/<Emails[^>]*>([\s\S]*?)<\/Emails>/gi)).map((match) => match[1]),
    ...Array.from(normalized.matchAll(/<Email[^>]*>([\s\S]*?)<\/Email>/gi)).map((match) => match[1]),
  ];

  const emails = emailBlocks
    .map((block) => {
      const endereco = (
        findInContext(block, ["EnderecoEmail", "Email", "email", "Endereco", "endereco"]) ?? ""
      ).trim();
      const preferencial = (
        findInContext(block, ["Preferencial", "preferencial"]) ?? ""
      ).trim().toLowerCase();
      const status = (
        findInContext(block, ["Status", "status", "Ativo", "ativo"]) ?? ""
      ).trim().toLowerCase();
      return {
        endereco,
        preferencial: preferencial === "true" || preferencial === "1" || preferencial === "s",
        ativo: status === "" || status === "true" || status === "1" || status === "s" || status === "ativo",
      };
    })
    .filter((item) => item.endereco.includes("@"));

  const preferred =
    emails.find((item) => item.preferencial && item.ativo) ??
    emails.find((item) => item.ativo) ??
    emails.find((item) => item.preferencial) ??
    emails[0];

  return preferred?.endereco ?? null;
}

function sumTagValues(context: string, tagNames: string[]): number {
  // Evita dupla contagem quando a mesma tag vem em maiusculas/minusculas
  // e o regex ja esta com flag case-insensitive.
  const normalizedTags = Array.from(new Set(tagNames.map((item) => item.toLowerCase())));
  let sum = 0;
  for (const tagName of normalizedTags) {
    const regex = new RegExp(`<(?:\\w+:)?${tagName}[^>]*>([\\s\\S]*?)<\\/(?:\\w+:)?${tagName}>`, "gi");
    const matches = Array.from(context.matchAll(regex));
    for (const match of matches) {
      sum += parseMoney(match[1]);
    }
  }
  return sum;
}

function sumFromDirectDebtItems(contractBlock: string, tagNames: string[]): number {
  const dividaWrappers = getTopLevelTagBlocks(contractBlock, "Divida");
  if (dividaWrappers.length === 0) {
    return sumTagValues(contractBlock, tagNames);
  }

  const firstWrapper = dividaWrappers[0];
  const wrapperInner = extractTagInner(firstWrapper, "Divida");
  if (!wrapperInner) {
    return sumTagValues(firstWrapper, tagNames);
  }

  const debtItems = getTopLevelTagBlocks(wrapperInner, "Divida");
  if (debtItems.length === 0) {
    return sumTagValues(wrapperInner, tagNames);
  }

  let sum = 0;
  for (const item of debtItems) {
    sum += sumTagValues(item, tagNames);
  }
  return sum;
}


function extractProdutoFromContext(context: string): string | null {
  const byIdTra = context.match(
    /<(?:\w+:)?idtra[^>]*>[\s\S]*?<\/(?:\w+:)?idtra>[\s\S]{0,400}?<(?:\w+:)?Descricao[^>]*>([\s\S]*?)<\/(?:\w+:)?Descricao>/i,
  );
  if (byIdTra?.[1]) return byIdTra[1].trim();
  return findInContext(context, ["Descricao", "descricao", "produto", "nomeProduto", "tipoDivida"]);
}

function sanitizeContractNumber(rawValue: string, fallback: string): string {
  if (!rawValue) return fallback;
  const text = rawValue.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const alphaNumMatch = text.match(/[A-Za-z]{2,}\d{5,}/);
  if (alphaNumMatch?.[0]) {
    return alphaNumMatch[0].split("-")[0].trim();
  }
  const numberMatch = text.match(/\d{8,}/);
  if (numberMatch?.[0]) {
    return numberMatch[0].split("-")[0].trim();
  }
  return fallback;
}

function getNegotiationCache(cacheKey: string): { xml: string; options: NectarNegotiationOption[] } | null {
  const item = negotiationCache.get(cacheKey);
  if (!item) return null;
  if (item.expiresAt <= Date.now()) {
    negotiationCache.delete(cacheKey);
    return null;
  }
  return { xml: item.xml, options: item.options };
}

function setNegotiationCache(
  cacheKey: string,
  data: { xml: string; options: NectarNegotiationOption[] },
): void {
  negotiationCache.set(cacheKey, {
    xml: data.xml,
    options: data.options,
    expiresAt: getEndOfDayTimestamp(),
  });
}

function getEndOfDayTimestamp(): number {
  const now = new Date();
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);
  return end.getTime();
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

function extractContratoFromContractBlock(context: string): string | null {
  const contractAfterAgrupamento = context.match(
    /<(?:Agrupamento|agrupamento)[^>]*>[\s\S]*?<(?:NomeFantasia|nomeFantasia)[^>]*>[\s\S]*?<(?:Contrato|contrato)[^>]*>([\s\S]*?)<\/(?:Contrato|contrato)>/i,
  );
  if (contractAfterAgrupamento?.[1]) {
    return contractAfterAgrupamento[1].trim();
  }
  return null;
}

function extractMaxIntFromTags(context: string, tagNames: string[]): number {
  let max = 0;
  for (const tagName of tagNames) {
    const regex = new RegExp(`<(?:\\w+:)?${tagName}[^>]*>([\\s\\S]*?)<\\/(?:\\w+:)?${tagName}>`, "gi");
    const matches = Array.from(context.matchAll(regex));
    for (const match of matches) {
      const raw = (match[1] ?? "").trim();
      const parsed = Number.parseInt(raw, 10);
      if (Number.isFinite(parsed)) {
        max = Math.max(max, parsed);
      }
    }
  }
  return max;
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

function extractDebtTitlesFromContract(contractBlock: string): NectarDebtTitle[] {
  const wrapper = getTopLevelTagBlocks(contractBlock, "Divida")[0];
  if (!wrapper) return [];
  const wrapperInner = extractTagInner(wrapper, "Divida");
  if (!wrapperInner) return [];

  const debtItems = getTopLevelTagBlocks(wrapperInner, "Divida");
  const result: NectarDebtTitle[] = [];
  for (const item of debtItems) {
    const idTra = (findInContext(item, ["IDTRA", "idtra", "IdTra"]) ?? "").trim();
    if (!idTra) continue;
    result.push({
      idTra,
      numeroTitulo: (findInContext(item, ["NumeroTitulo", "numeroTitulo"]) ?? "").trim(),
      dataVencimento: (findInContext(item, ["DataVencimento", "dataVencimento"]) ?? "").trim(),
      diasAtraso: extractMaxIntFromTags(item, ["DiasAtraso", "diasAtraso"]),
      descricao: (findInContext(item, ["Descricao", "descricao"]) ?? "").trim(),
      valorOriginal: parseMoney(findInContext(item, ["ValorOriginal", "valorOriginal"])),
      valorAtualizado: parseMoney(findInContext(item, ["ValorAtualizado", "valorAtualizado"])),
    });
  }
  return result;
}

function mergeDebtTitles(current: NectarDebtTitle[], incoming: NectarDebtTitle[]): NectarDebtTitle[] {
  const map = new Map<string, NectarDebtTitle>();
  for (const item of current) {
    if (item.idTra) map.set(item.idTra, item);
  }
  for (const item of incoming) {
    if (item.idTra) map.set(item.idTra, item);
  }
  return Array.from(map.values());
}





