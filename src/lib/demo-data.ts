import type { NectarContract, NectarNegotiationOption } from "@/lib/nectar/types";

export const DEMO_DOCUMENT = process.env.DEMO_CPF?.replace(/\D/g, "") || "00000000000";

export function isDemoMode(): boolean {
  return (process.env.DEMO_MODE || "").toLowerCase() === "true";
}

export function isDemoRequest(document?: string): boolean {
  const digits = (document ?? "").replace(/\D/g, "");
  return isDemoMode() || digits === DEMO_DOCUMENT;
}

export const demoOperators = [
  { idPes: "9001", nome: "Operador Demo", login: "operador.demo" },
  { idPes: "9002", nome: "Supervisora Demo", login: "supervisora.demo" },
];

export const demoDebtor = {
  preferredPhone: "11999990000",
  preferredEmail: "cliente.demo@example.com",
};

export function getDemoContracts(): NectarContract[] {
  return [
    {
      idCon: "DEMO1001",
      idServ: "1",
      numeroContrato: "BEMOL-DEMO-1001",
      produto: "Crediario loja",
      diasAtraso: 124,
      valorCorrigido: 1280.45,
      tiponegociacao: "3",
      tpDesconto: "1",
      hasOpenAgreement: false,
      hasOpenPromise: false,
      hasPossibleActiveAgreement: false,
    },
    {
      idCon: "DEMO1002",
      idServ: "1",
      numeroContrato: "BEMOL-DEMO-1002",
      produto: "Cartao Bemol",
      diasAtraso: 42,
      valorCorrigido: 642.9,
      hasOpenAgreement: false,
      hasOpenPromise: false,
      hasPossibleActiveAgreement: false,
      titulos: [
        {
          idTra: "TIT-DEMO-001",
          numeroTitulo: "001",
          dataVencimento: "2026-03-10",
          diasAtraso: 50,
          descricao: "Parcela vencida 01",
          valorOriginal: 210,
          valorAtualizado: 226.35,
        },
        {
          idTra: "TIT-DEMO-002",
          numeroTitulo: "002",
          dataVencimento: "2026-04-10",
          diasAtraso: 19,
          descricao: "Parcela vencida 02",
          valorOriginal: 210,
          valorAtualizado: 218.72,
        },
        {
          idTra: "TIT-DEMO-003",
          numeroTitulo: "003",
          dataVencimento: "2026-05-10",
          diasAtraso: 0,
          descricao: "Parcela a vencer",
          valorOriginal: 210,
          valorAtualizado: 210,
        },
      ],
    },
    {
      idCon: "DEMO1003",
      idServ: "1",
      numeroContrato: "BEMOL-DEMO-1003",
      produto: "Emprestimo pessoal",
      diasAtraso: 210,
      valorCorrigido: 2180,
      tiponegociacao: "3",
      tpDesconto: "1",
      hasOpenAgreement: false,
      hasOpenPromise: false,
      hasPossibleActiveAgreement: false,
    },
  ];
}

function toIsoDate(value?: string): string {
  const raw = (value ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;

  const brMatch = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (brMatch) return `${brMatch[3]}-${brMatch[2]}-${brMatch[1]}`;

  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function createOption(
  parcelasNum: number,
  valorNegociar: number,
  vencimentoPrimeira: string,
): NectarNegotiationOption {
  const valorPrimeira =
    parcelasNum === 1 ? valorNegociar : Math.max(80, Math.round(valorNegociar * 0.22 * 100) / 100);
  const valorDemais =
    parcelasNum === 1 ? 0 : Math.round(((valorNegociar - valorPrimeira) / (parcelasNum - 1)) * 100) / 100;

  return {
    parcelasNum,
    valorNegociar,
    valorPrimeira,
    valorDemais,
    valorDesconto: Math.round(valorNegociar * 0.12 * 100) / 100,
    valorOriginal: Math.round(valorNegociar * 1.18 * 100) / 100,
    valorCorrigido: Math.round(valorNegociar * 1.08 * 100) / 100,
    vencimentoPrimeira,
    plano: `DEMO-${parcelasNum}X`,
    codigoFaixa: "DEMO",
    descricaoFaixa: "Opcao demonstrativa",
  };
}

function pickOption(options: NectarNegotiationOption[], parcelasPreferidas: number): NectarNegotiationOption {
  return (
    options.find((option) => option.parcelasNum === parcelasPreferidas) ??
    options.find((option) => option.parcelasNum > parcelasPreferidas) ??
    options[options.length - 1]
  );
}

function getSelectedTitleIds(
  contract: NectarContract,
  dateIso: string,
  emitAllOpenTitles?: boolean,
  selectedIds?: string[],
): string[] {
  const base = (contract.titulos ?? []).filter((title) => {
    const dueIso = (title.dataVencimento ?? "").slice(0, 10);
    return dueIso && (emitAllOpenTitles || dueIso < dateIso);
  });
  const titles = selectedIds?.length ? base.filter((title) => selectedIds.includes(title.idTra)) : base;
  return titles.map((title) => title.idTra);
}

export function buildDemoSimulation(payload: {
  contracts?: NectarContract[];
  vencPrimParcela?: string;
  parcelasPreferidas?: number;
  emitAllOpenTitles?: boolean;
  selectedTitleIdsByContract?: Record<string, string[]>;
}) {
  const vencimentoIso = toIsoDate(payload.vencPrimParcela);
  const contracts = payload.contracts?.length ? payload.contracts : getDemoContracts();
  const parcelasPreferidas = Number(payload.parcelasPreferidas || 3);

  const items = contracts.map((contract) => {
    if (contract.titulos?.length) {
      const contractKey = `${contract.idCon}:${contract.idServ}`;
      const selectedTitleIds = getSelectedTitleIds(
        contract,
        vencimentoIso,
        payload.emitAllOpenTitles,
        payload.selectedTitleIdsByContract?.[contractKey],
      );
      const selectedTitles = contract.titulos.filter((title) => selectedTitleIds.includes(title.idTra));
      const total = selectedTitles.reduce((sum, title) => sum + (title.valorAtualizado || title.valorOriginal || 0), 0);
      const futureTitles = contract.titulos.filter((title) => (title.dataVencimento ?? "").slice(0, 10) >= vencimentoIso);
      const option = createOption(Math.max(1, selectedTitles.length), Math.round(total * 100) / 100, vencimentoIso);

      return {
        contract,
        selectedOption: option,
        aVistaOption: option,
        rawOptions: [option],
        processingMode: "titulo" as const,
        pendingTitlesSummary: futureTitles.length
          ? `${futureTitles.length} parcela(s) a vencer mantida(s) para acompanhamento.`
          : "",
        pendingTitlesCount: futureTitles.length,
        pendingTitlesUnitValue: futureTitles[0]?.valorOriginal ?? 0,
        pendingTitlesTotal: futureTitles.reduce((sum, title) => sum + (title.valorOriginal || 0), 0),
        overdueTitlesCount: selectedTitles.length,
        selectedTitleIds,
      };
    }

    const baseValue = Math.max(150, Math.round((contract.valorCorrigido || 1000) * 0.82 * 100) / 100);
    const rawOptions = [1, 3, 6, 10].map((parcelas) => createOption(parcelas, baseValue, vencimentoIso));

    return {
      contract,
      selectedOption: pickOption(rawOptions, parcelasPreferidas),
      aVistaOption: rawOptions[0],
      rawOptions,
      processingMode: "negociacao" as const,
    };
  });

  return {
    summary: {
      contratos: items.length,
      totalAvista: items.reduce((sum, item) => sum + (item.aVistaOption?.valorNegociar ?? 0), 0),
      totalMensal: items.reduce((sum, item) => sum + (item.selectedOption?.valorDemais || item.selectedOption?.valorPrimeira || 0), 0),
    },
    items,
  };
}

export function buildDemoCloseResponse(payload: {
  vencPrimParcela?: string;
  tipoenvio?: "1" | "2" | "3" | "6";
  operatorIdPes?: string;
  operatorNome?: string;
  items?: Array<{
    contract: NectarContract;
    processingMode?: "negociacao" | "titulo";
    selectedOption?: NectarNegotiationOption | null;
  }>;
}) {
  const items = (payload.items ?? []).map((item, index) => {
    const mode = item.processingMode ?? "negociacao";
    const boleto =
      payload.tipoenvio === "1"
        ? null
        : {
            codigoRetorno: "000000",
            mensagemRetorno: "Boleto demonstrativo gerado.",
            linhaDigitavel: `34191.79001 01043.510047 91020.15000${index} 8 999900000${index + 1}00`,
            pixCopiaCola: `pix-demo-${item.contract.idCon}`,
            boletoUrl: "https://example.com/boleto-demo.pdf",
          };

    return {
      status: "success" as const,
      mode,
      contract: item.contract,
      selectedOption: item.selectedOption ?? null,
      gravacao:
        mode === "titulo"
          ? null
          : {
              codigoRetorno: "000000",
              mensagemRetorno: "Negociacao demo gravada com sucesso.",
              idParcela: `DEMO-PARCELA-${index + 1}`,
            },
      boleto,
      andamento: {
        codigoRetorno: "000000",
        mensagemRetorno: "Andamento demo registrado.",
      },
    };
  });

  return {
    negotiationKind: "acordo",
    operatorIdPes: payload.operatorIdPes ?? demoOperators[0].idPes,
    operatorNome: payload.operatorNome ?? demoOperators[0].nome,
    tipoenvio: payload.tipoenvio ?? "1",
    summary: {
      processed: items.length,
      success: items.length,
      failed: 0,
      boletoGenerated: items.filter((item) => item.boleto).length,
    },
    items,
  };
}
