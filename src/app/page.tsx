"use client";

import Image from "next/image";
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";

type Contract = {
  idCon: string;
  idServ: string;
  numeroContrato: string;
  produto: string;
  diasAtraso: number;
  valorCorrigido: number;
  hasOpenAgreement?: boolean;
  hasOpenPromise?: boolean;
  hasPossibleActiveAgreement?: boolean;
  titulos?: Array<{
    idTra: string;
    dataVencimento: string;
    diasAtraso: number;
    descricao: string;
    valorOriginal: number;
    valorAtualizado: number;
  }>;
};

type Option = {
  parcelasNum: number;
  valorNegociar: number;
  valorPrimeira: number;
  valorDemais: number;
  valorDesconto: number;
  valorOriginal: number;
  valorCorrigido: number;
  vencimentoPrimeira: string;
  plano: string;
  codigoFaixa: string;
  descricaoFaixa: string;
};

type SimulationItem = {
  contract: Contract;
  rawOptions: Option[];
  processingMode?: "negociacao" | "titulo";
  pendingTitlesSummary?: string;
  pendingTitlesCount?: number;
  pendingTitlesUnitValue?: number;
  pendingTitlesTotal?: number;
  overdueTitlesCount?: number;
  selectedTitleIds?: string[];
};

type ScenarioSelection = {
  key: string;
  option: Option;
};

type SimulationResponse = {
  items: SimulationItem[];
};

type ClosingResponse = {
  negotiationKind: "acordo" | "promessa";
  operatorIdPes: string;
  operatorNome: string;
  summary: {
    processed: number;
    success: number;
    failed: number;
    boletoGenerated: number;
  };
  items: Array<
    | {
        status: "success";
        mode: "negociacao" | "titulo";
        contract: Contract;
        selectedOption: Option | null;
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
      }
    | {
        status: "error";
        mode: "negociacao" | "titulo";
        contract: Contract;
        error: string;
      }
  >;
};

const DELIVERY_CHANNELS = [
  { value: "1", label: "N\u00e3o enviar" },
  { value: "2", label: "Enviar por email" },
  { value: "3", label: "Enviar por SMS" },
  { value: "6", label: "Enviar por WhatsApp" },
] as const;

type OperatorOption = {
  idPes: string;
  nome: string;
  login: string;
};

type PreviewItem = {
  label: string;
  value: number;
  sortKey: string;
};

function currency(value: number): string {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(value ?? 0);
}

function getTodayIsoLocal(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function toBrDate(isoDate: string): string {
  const [year, month, day] = isoDate.split("-");
  return `${day}/${month}/${year}`;
}


function diffDaysFromTodayIso(isoDate: string): number | null {
  const match = (isoDate ?? "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const target = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((target.getTime() - today.getTime()) / 86_400_000);
}

function parseIsoDate(value: string): Date | null {
  const match = (value ?? "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  const parsed = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function buildInstallmentPreview(option: Option | null): PreviewItem[] {
  if (!option || option.parcelasNum <= 0) return [];
  const firstDate = parseIsoDate(option.vencimentoPrimeira);
  return Array.from({ length: option.parcelasNum }, (_, index) => {
    const current = firstDate
      ? new Date(firstDate.getFullYear(), firstDate.getMonth() + index, firstDate.getDate())
      : null;
    const label = current
      ? new Intl.DateTimeFormat("pt-BR", { month: "short", year: "2-digit" }).format(current).replace('.', '')
      : `${index + 1} parcela`;
    return {
      label,
      value: index === 0 ? (option.valorPrimeira ?? 0) : (option.valorDemais ?? 0),
      sortKey: current ? current.toISOString().slice(0, 10) : "9999-12-31",
    };
  });
}

function buildTitlePreview(titulos: Contract["titulos"] | undefined): PreviewItem[] {
  return [...(titulos ?? [])]
    .sort((left, right) => (left.dataVencimento ?? "").localeCompare(right.dataVencimento ?? ""))
    .map((titulo, index) => {
      const parsed = parseIsoDate(titulo.dataVencimento);
      const label = parsed
        ? new Intl.DateTimeFormat("pt-BR", { month: "short", year: "2-digit" }).format(parsed).replace('.', '')
        : `${index + 1} titulo`;
      return {
        label,
        value: titulo.valorAtualizado || titulo.valorOriginal || 0,
        sortKey: parsed ? parsed.toISOString().slice(0, 10) : "9999-12-31",
      };
    });
}

function pickOption(options: Option[], parcelasPreferidas: number): Option | null {
  if (!options.length) return null;
  const exact = options.find((item) => item.parcelasNum === parcelasPreferidas);
  if (exact) return exact;
  const sorted = [...options].sort((a, b) => a.parcelasNum - b.parcelasNum);
  const nextHigher = sorted.find((item) => item.parcelasNum > parcelasPreferidas);
  if (nextHigher) return nextHigher;
  return sorted[sorted.length - 1];
}

function parseDecimalInput(value: string): number {
  const normalized = (value ?? "").replace(",", ".").trim();
  const parsed = Number(normalized);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function getSelectableTitleIds(contract: Contract, dateIso: string, emitAllOpenTitles: boolean): string[] {
  return (contract.titulos ?? [])
    .filter((title) => {
      const dueIso = (title.dataVencimento ?? "").slice(0, 10);
      if (!dueIso) return false;
      return emitAllOpenTitles ? true : dueIso < dateIso;
    })
    .map((title) => title.idTra);
}

function openNativeDatePicker(input: HTMLInputElement | null): void {
  if (!input) return;
  const pickerInput = input as HTMLInputElement & { showPicker?: () => void };
  pickerInput.showPicker?.();
  input.focus();
}

function isSameOption(left: Option, right: Option): boolean {
  return left.parcelasNum === right.parcelasNum
    && left.valorNegociar === right.valorNegociar
    && left.valorPrimeira === right.valorPrimeira
    && left.valorDemais === right.valorDemais
    && left.codigoFaixa === right.codigoFaixa
    && left.plano === right.plano;
}

export default function Home() {
  const [cnpjcpf, setCnpjcpf] = useState("");
  const [operatorQuery, setOperatorQuery] = useState("");
  const [operators, setOperators] = useState<OperatorOption[]>([]);
  const [loadingOperators, setLoadingOperators] = useState(false);
  const [selectedOperator, setSelectedOperator] = useState<OperatorOption | null>(null);
  const [highlightedOperatorIndex, setHighlightedOperatorIndex] = useState(0);
  const [closePanelOpen, setClosePanelOpen] = useState(false);
  const [deliveryChannel, setDeliveryChannel] = useState<(typeof DELIVERY_CHANNELS)[number]["value"]>("2");
  const [preferredPhone, setPreferredPhone] = useState<string | null>(null);
  const [preferredEmail, setPreferredEmail] = useState<string | null>(null);
  const [loadingPreferredPhone, setLoadingPreferredPhone] = useState(false);
  const requestedPhoneRef = useRef<string>("");
  const topDateInputRef = useRef<HTMLInputElement | null>(null);
  const closeDateInputRef = useRef<HTMLInputElement | null>(null);
  const [closingNegotiation, setClosingNegotiation] = useState(false);
  const [closeResult, setCloseResult] = useState<ClosingResponse | null>(null);
  const [dueDate, setDueDate] = useState(getTodayIsoLocal());
  const [dueDateInput, setDueDateInput] = useState(toBrDate(getTodayIsoLocal()));
  const [parcelasPreferidas, setParcelasPreferidas] = useState(1);
  const [desiredEntry, setDesiredEntry] = useState("");
  const deferredDesiredEntry = useDeferredValue(desiredEntry);
  const [emitAllOpenTitles, setEmitAllOpenTitles] = useState(false);
  const [quantidadeSelecionada, setQuantidadeSelecionada] = useState(0);
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [scenarioSelections, setScenarioSelections] = useState<Record<string, Option>>({});
  const [titleSelections, setTitleSelections] = useState<Record<string, string[]>>({});
  const [simulation, setSimulation] = useState<SimulationResponse | null>(null);
  const [loadingContracts, setLoadingContracts] = useState(false);
  const [loadingSimulation, setLoadingSimulation] = useState(false);
  const [error, setError] = useState("");

  const filteredOperators = useMemo(() => {
    if (selectedOperator) return [];
    const search = operatorQuery.trim().toLowerCase();
    if (!search) return [];
    return operators
      .filter((item) => item.nome.toLowerCase().includes(search) || item.login.toLowerCase().includes(search))
      .slice(0, 8);
  }, [operatorQuery, operators, selectedOperator]);

  const agreementAllowed = useMemo(() => {
    const diff = diffDaysFromTodayIso(dueDate);
    return diff !== null && diff >= 0 && diff <= 1;
  }, [dueDate]);

  const displayedItems = useMemo(() => {
    if (!simulation) return [];
    const keyset = new Set(selectedKeys);
    return simulation.items
      .filter((item) => keyset.has(`${item.contract.idCon}:${item.contract.idServ}`))
      .map((item) => {
        const contractKey = `${item.contract.idCon}:${item.contract.idServ}`;
        const scenarioSelected = scenarioSelections[contractKey];
        const selected = scenarioSelected
          ? item.rawOptions.find((option) => isSameOption(option, scenarioSelected)) ?? pickOption(item.rawOptions, parcelasPreferidas)
          : pickOption(item.rawOptions, parcelasPreferidas);
        const aVista = item.rawOptions.find((option) => option.parcelasNum === 1) ?? selected;
        const defaultTitleIds = item.selectedTitleIds ?? getSelectableTitleIds(item.contract, dueDate, emitAllOpenTitles);
        return {
          ...item,
          selectedOption: selected,
          aVistaOption: aVista,
          selectedTitleIds: item.processingMode === "titulo"
            ? (titleSelections[contractKey] ?? defaultTitleIds)
            : item.selectedTitleIds,
        };
      })
      .sort((a, b) => {
        const ap = a.processingMode === "titulo" ? 0 : 1;
        const bp = b.processingMode === "titulo" ? 0 : 1;
        if (ap !== bp) return ap - bp;
        return b.contract.diasAtraso - a.contract.diasAtraso;
      });
  }, [simulation, parcelasPreferidas, scenarioSelections, selectedKeys, titleSelections, dueDate, emitAllOpenTitles]);

  const summary = useMemo(() => {
    const totalAvista = displayedItems.reduce((acc, item) => acc + (item.aVistaOption?.valorNegociar ?? 0), 0);
    const totalEntrada = displayedItems.reduce((acc, item) => acc + (item.selectedOption?.valorPrimeira ?? 0), 0);
    const totalMensal = displayedItems.reduce(
      (acc, item) =>
        acc +
        (item.processingMode === "titulo"
          ? (item.pendingTitlesCount && item.pendingTitlesCount > 0 ? (item.pendingTitlesUnitValue ?? 0) : 0)
          : ((item.selectedOption?.parcelasNum ?? 1) > 1
              ? (item.selectedOption?.valorDemais || item.selectedOption?.valorPrimeira || 0)
              : 0)),
      0,
    );
    const totalNegociado = displayedItems.reduce((acc, item) => {
      const entrada = item.selectedOption?.valorPrimeira ?? 0;
      const parcelas = Math.max(1, item.selectedOption?.parcelasNum ?? 1);
      const demais = item.selectedOption?.valorDemais ?? 0;
      return acc + entrada + demais * Math.max(0, parcelas - 1);
    }, 0);
    return {
      contratos: displayedItems.length,
      totalAvista,
      totalEntrada,
      totalMensal,
      totalNegociado,
    };
  }, [displayedItems]);

  const closingCandidates = useMemo(() => displayedItems, [displayedItems]);
  const eligibleClosingCandidates = useMemo(
    () => closingCandidates.filter((item) => item.processingMode === "titulo" || item.selectedOption),
    [closingCandidates],
  );
  const hasClosingSelection = eligibleClosingCandidates.length > 0;
  const closingKind = hasClosingSelection && !agreementAllowed ? "promessa" : "acordo";
  const agreementCandidates = useMemo(
    () => eligibleClosingCandidates.filter((item) => item.processingMode !== "titulo"),
    [eligibleClosingCandidates],
  );
  const titleCandidates = useMemo(
    () => eligibleClosingCandidates.filter((item) => item.processingMode === "titulo"),
    [eligibleClosingCandidates],
  );

  const titleOnlyCount = useMemo(
    () => eligibleClosingCandidates.filter((item) => item.processingMode === "titulo").length,
    [eligibleClosingCandidates],
  );
  const agreementCount = useMemo(
    () => eligibleClosingCandidates.filter((item) => item.processingMode !== "titulo").length,
    [eligibleClosingCandidates],
  );
  const invalidNegotiationCount = useMemo(
    () => displayedItems.filter((item) => item.processingMode !== "titulo" && !item.contract.hasPossibleActiveAgreement && !item.selectedOption && !item.aVistaOption).length,
    [displayedItems],
  );
  const consolidatedPreview = useMemo(() => {
    const totals = new Map<string, PreviewItem>();

    for (const item of displayedItems) {
      const previews = item.processingMode === "titulo"
        ? buildTitlePreview(item.contract.titulos)
        : buildInstallmentPreview(item.selectedOption);

      for (const preview of previews) {
        const existing = totals.get(preview.sortKey);
        if (existing) {
          existing.value += preview.value;
        } else {
          totals.set(preview.sortKey, { ...preview });
        }
      }
    }

    return Array.from(totals.values()).sort((left, right) => left.sortKey.localeCompare(right.sortKey));
  }, [displayedItems]);
  const entryScenarios = useMemo(() => {
    const budget = Math.round(parseDecimalInput(deferredDesiredEntry) * 100);
    if (!simulation || budget <= 0) {
      return [] as Array<{
        contractCount: number;
        totalEntry: number;
        keys: string[];
        labels: string[];
        selections: ScenarioSelection[];
      }>;
    }

    const choices = simulation.items
      .filter((item) => !item.contract.hasPossibleActiveAgreement)
      .map((item) => {
        const options = item.processingMode === "titulo" ? item.rawOptions.slice(0, 1) : item.rawOptions;
        const uniqueByEntry = new Map<number, Option>();
        for (const option of options) {
          const entry = Math.round((option.valorPrimeira ?? 0) * 100);
          if (entry > 0 && entry <= budget && !uniqueByEntry.has(entry)) {
            uniqueByEntry.set(entry, option);
          }
        }
        return {
          key: `${item.contract.idCon}:${item.contract.idServ}`,
          contract: item.contract,
          options: Array.from(uniqueByEntry.entries())
            .sort((a, b) => a[0] - b[0])
            .map(([entry, option]) => ({ entry, option })),
        };
      })
      .filter((item) => item.options.length > 0);

    type State = {
      total: number;
      picks: Array<{ key: string; label: string; option: Option }>;
    };

    const statesByCount: Array<Map<number, State>> = Array.from({ length: choices.length + 1 }, () => new Map());
    statesByCount[0].set(0, { total: 0, picks: [] });

    for (const choice of choices) {
      for (let count = choices.length - 1; count >= 0; count -= 1) {
        const sourceStates = Array.from(statesByCount[count].values());
        for (const state of sourceStates) {
          for (const option of choice.options) {
            const nextTotal = state.total + option.entry;
            if (nextTotal > budget) continue;
            if (state.picks.some((pick) => pick.key === choice.key)) continue;
            const nextCount = count + 1;
            if (!statesByCount[nextCount].has(nextTotal)) {
              statesByCount[nextCount].set(nextTotal, {
                total: nextTotal,
                picks: [
                  ...state.picks,
                  {
                    key: choice.key,
                    label: `${choice.contract.numeroContrato} (${option.option.parcelasNum}x, entrada ${currency(option.option.valorPrimeira)})`,
                    option: option.option,
                  },
                ],
              });
            }
          }
        }
      }
    }

    const scenarios: Array<{ contractCount: number; totalEntry: number; keys: string[]; labels: string[]; selections: ScenarioSelection[] }> = [];
    for (let count = 1; count < statesByCount.length; count += 1) {
      const totals = Array.from(statesByCount[count].keys());
      if (!totals.length) continue;
      const bestTotal = Math.max(...totals);
      const best = statesByCount[count].get(bestTotal);
      if (!best) continue;
      scenarios.push({
        contractCount: count,
        totalEntry: best.total / 100,
        keys: best.picks.map((pick) => pick.key),
        labels: best.picks.map((pick) => pick.label),
        selections: best.picks.map((pick) => ({ key: pick.key, option: pick.option })),
      });
    }

    return scenarios;
  }, [deferredDesiredEntry, simulation]);

  const loadOperators = useCallback(async () => {
    if (operators.length > 0 || loadingOperators) return;
    setLoadingOperators(true);
    try {
      const response = await fetch("/api/operators");
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error ?? "Erro ao consultar operadores.");
      }
      setOperators((data.items ?? []) as OperatorOption[]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao consultar operadores.");
    } finally {
      setLoadingOperators(false);
    }
  }, [loadingOperators, operators.length]);

  const loadPreferredPhone = useCallback(async () => {
    if (!cnpjcpf || requestedPhoneRef.current === cnpjcpf) return;
    requestedPhoneRef.current = cnpjcpf;
    setLoadingPreferredPhone(true);
    try {
      const response = await fetch("/api/nectar/debtor", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cnpjcpf }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error ?? "Erro ao consultar telefone do cliente.");
      }
      setPreferredPhone((data.preferredPhone ?? null) as string | null);
      setPreferredEmail((data.preferredEmail ?? null) as string | null);
    } catch (err) {
      setPreferredPhone(null);
      setPreferredEmail(null);
      setError(err instanceof Error ? err.message : "Erro ao consultar telefone do cliente.");
    } finally {
      setLoadingPreferredPhone(false);
    }
  }, [cnpjcpf]);

  async function handleLoadContracts() {
    setError("");
    setSimulation(null);
    setCloseResult(null);
    setClosePanelOpen(false);
    setSelectedOperator(null);
    setOperatorQuery("");
    setPreferredPhone(null);
    setPreferredEmail(null);
    requestedPhoneRef.current = "";
    setLoadingContracts(true);
    try {
      const response = await fetch("/api/nectar/contracts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cnpjcpf }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error ?? "Erro ao consultar contratos.");
      }
      const loaded = (data.contracts ?? []) as Contract[];
      const sanitized = loaded.map((item) => ({
        ...item,
        numeroContrato: sanitizeContractForDisplay(item.numeroContrato),
      }));
      setContracts(sanitized);
      setScenarioSelections({});
      setTitleSelections({});
      setSelectedKeys(sanitized.map((item) => `${item.idCon}:${item.idServ}`));
      setQuantidadeSelecionada(loaded.length);
      await simulateContracts(sanitized, dueDate);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro inesperado.");
    } finally {
      setLoadingContracts(false);
    }
  }

  const simulateContracts = useCallback(async (
    contractsToRun: Contract[],
    dateIso: string,
    titleSelectionsOverride?: Record<string, string[]>,
  ) => {
    setError("");
    setCloseResult(null);
    if (!contractsToRun.length) return;
    setLoadingSimulation(true);
    setScenarioSelections({});
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 90000);
    try {
      const response = await fetch("/api/nectar/simulate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          cnpjcpf,
          contracts: contractsToRun,
          vencPrimParcela: toBrDate(dateIso),
          parcelasPreferidas,
          emitAllOpenTitles,
          selectedTitleIdsByContract: titleSelectionsOverride ?? titleSelections,
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error ?? "Erro ao simular.");
      }
      const simulatedItems = (data.items ?? []) as SimulationItem[];
      setSimulation({
        items: simulatedItems,
      });
      setTitleSelections((current) => {
        const source = titleSelectionsOverride ?? current;
        const nextEntries = simulatedItems
          .filter((item) => item.processingMode === "titulo")
          .map((item) => {
            const contractKey = `${item.contract.idCon}:${item.contract.idServ}`;
            const validIds = getSelectableTitleIds(item.contract, dateIso, emitAllOpenTitles);
            const previousIds = (source[contractKey] ?? []).filter((id) => validIds.includes(id));
            const selectedIds = previousIds.length > 0
              ? previousIds
              : ((item.selectedTitleIds ?? []).filter((id) => validIds.includes(id)).length > 0
                  ? (item.selectedTitleIds ?? []).filter((id) => validIds.includes(id))
                  : validIds);
            return [contractKey, selectedIds] as const;
          });
        return Object.fromEntries(nextEntries);
      });
      if (simulatedItems.some((item) => item.contract.hasPossibleActiveAgreement)) {
        const negotiableKeys = simulatedItems
          .filter((item) => item.processingMode !== "titulo" && !item.contract.hasPossibleActiveAgreement && item.rawOptions.length > 0)
          .map((item) => `${item.contract.idCon}:${item.contract.idServ}`);
        if (negotiableKeys.length > 0) {
          setSelectedKeys(negotiableKeys);
          setQuantidadeSelecionada(negotiableKeys.length);
        }
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        setError("A simula\u00e7\u00e3o demorou al\u00e9m do limite. Tente novamente.");
      } else {
        setError(err instanceof Error ? err.message : "Erro inesperado.");
      }
    } finally {
      clearTimeout(timeout);
      setLoadingSimulation(false);
    }
  }, [cnpjcpf, emitAllOpenTitles, parcelasPreferidas, titleSelections]);

  async function handleSimulate() {
    await simulateContracts(contracts, dueDate);
  }

  async function handleConfirmClose(): Promise<void> {
    if (!selectedOperator) {
      setError("Selecione o operador respons\u00e1vel pelo fechamento.");
      return;
    }
    if (eligibleClosingCandidates.length === 0) {
      setError("Selecione ao menos um contrato parcel\u00e1vel para fechar.");
      return;
    }
    if (closingKind === "acordo" && (deliveryChannel === "3" || deliveryChannel === "6")) {
      if (loadingPreferredPhone) {
        setError("Aguarde a consulta do telefone do cliente antes de enviar por SMS ou WhatsApp.");
        return;
      }
      if (!preferredPhone) {
        setError("N\u00e3o foi poss\u00edvel localizar telefone celular ativo para envio por SMS ou WhatsApp.");
        return;
      }
    }
    if (closingKind === "acordo" && deliveryChannel === "2" && !preferredEmail) {
      setError("N\u00e3o foi poss\u00edvel localizar e-mail do cliente para envio.");
      return;
    }
    setError("");
    setClosingNegotiation(true);
    try {
      const response = await fetch("/api/nectar/close", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cnpjcpf,
          operatorIdPes: selectedOperator.idPes,
          operatorNome: selectedOperator.nome,
          preferredPhone,
          preferredEmail,
          vencPrimParcela: toBrDate(dueDate),
          parcelasPreferidas,
          tipoenvio: deliveryChannel,
          emitAllOpenTitles,
          items: eligibleClosingCandidates.map((item) => ({
            contract: item.contract,
            processingMode: item.processingMode,
            selectedOption: item.selectedOption,
            selectedTitleIds: item.processingMode === "titulo" ? item.selectedTitleIds : undefined,
          })),
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error ?? "Falha ao fechar negocia\u00e7\u00e3o.");
      }
      setCloseResult(data as ClosingResponse);
      const closedKeys = new Set(
        (data.items ?? [])
          .filter((item: ClosingResponse["items"][number]) => item.status === "success" && item.mode === "negociacao")
          .map((item: ClosingResponse["items"][number]) => `${item.contract.idCon}:${item.contract.idServ}`),
      );
      setContracts((prev) => prev.map((contract) => {
        const contractKey = `${contract.idCon}:${contract.idServ}`;
        if (!closedKeys.has(contractKey)) return contract;
        return {
          ...contract,
          hasOpenAgreement: closingKind === "acordo" ? true : contract.hasOpenAgreement,
          hasOpenPromise: closingKind === "promessa" ? true : contract.hasOpenPromise,
          hasPossibleActiveAgreement: true,
        };
      }));
      setSimulation((prev) => prev ? {
        items: prev.items.map((item) => {
          const contractKey = `${item.contract.idCon}:${item.contract.idServ}`;
          if (!closedKeys.has(contractKey)) return item;
          return {
            ...item,
            contract: {
              ...item.contract,
              hasOpenAgreement: closingKind === "acordo" ? true : item.contract.hasOpenAgreement,
              hasOpenPromise: closingKind === "promessa" ? true : item.contract.hasOpenPromise,
              hasPossibleActiveAgreement: true,
            },
          };
        }),
      } : prev);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao fechar negocia\u00e7\u00e3o.");
    } finally {
      setClosingNegotiation(false);
    }
  }

  function handleSelectAll(): void {
    const all = contracts.map((item) => `${item.idCon}:${item.idServ}`);
    setScenarioSelections({});
    setSelectedKeys(all);
    setQuantidadeSelecionada(all.length);
  }

  function handleToggleTitleSelection(contractKey: string, titleId: string, checked: boolean): void {
    const contract = contracts.find((item) => `${item.idCon}:${item.idServ}` === contractKey);
    if (!contract) return;

    const validIds = getSelectableTitleIds(contract, dueDate, emitAllOpenTitles);
    const currentIds = titleSelections[contractKey] ?? validIds;
    let nextIds = checked
      ? Array.from(new Set([...currentIds, titleId]))
      : currentIds.filter((id) => id !== titleId);

    if (nextIds.length === 0) {
      nextIds = [titleId];
    }

    const nextSelections = {
      ...titleSelections,
      [contractKey]: nextIds,
    };

    setTitleSelections(nextSelections);
    void simulateContracts(contracts, dueDate, nextSelections);
  }

  function handlePreferredInstallmentsChange(value: string): void {
    const parsed = Number(value || 1);
    const nextValue = Number.isFinite(parsed) ? Math.max(1, parsed) : 1;
    setParcelasPreferidas(nextValue);
    setScenarioSelections({});
  }

  function handleApplyEntryScenario(selections: ScenarioSelection[]): void {
    const keys = selections.map((item) => item.key);
    if (!keys.length) return;
    setScenarioSelections(Object.fromEntries(selections.map((item) => [item.key, item.option])));
    setSelectedKeys(keys);
    setQuantidadeSelecionada(keys.length);
  }

  function handleClearSelection(): void {
    setScenarioSelections({});
    setSelectedKeys([]);
    setQuantidadeSelecionada(0);
  }

  function handleSelectNFirst(): void {
    const safeCount = Math.max(0, Math.min(quantidadeSelecionada, contracts.length));
    const next = contracts.slice(0, safeCount).map((item) => `${item.idCon}:${item.idServ}`);
    setScenarioSelections({});
    setSelectedKeys(next);
  }

  useEffect(() => {
    if (!closePanelOpen || !cnpjcpf) return;
    void loadPreferredPhone();
  }, [closePanelOpen, cnpjcpf, loadPreferredPhone]);

  useEffect(() => {
    if (!closePanelOpen || closingKind !== "acordo") return;
    if (preferredEmail) {
      setDeliveryChannel("2");
      return;
    }
    if (preferredPhone) {
      setDeliveryChannel((current) => current === "3" || current === "6" ? current : "6");
      return;
    }
    setDeliveryChannel("1");
  }, [closePanelOpen, closingKind, preferredEmail, preferredPhone]);

  return (
    <main className="app-shell mx-auto flex min-h-screen w-full max-w-7xl flex-col gap-6 px-4 py-8 md:px-8">
      <section className="glass-panel hero-panel animate-rise rounded-[2rem] p-6 md:p-10">
        <div className="mb-4 flex items-center gap-5 overflow-visible">
          <Image
            src="/syscob-logo.png"
            alt="Logo Syscob"
            width={180}
            height={80}
            className="h-auto w-[148px] max-w-none shrink-0 object-contain md:w-[180px]"
            priority
          />
          <div>
            <p className="section-kicker mb-2">SYSCOB</p>
            <h1 className="app-title text-3xl font-bold text-slate-800 md:text-5xl">{"Simulador de Negocia\u00e7\u00e3o"}</h1>
          </div>
        </div>
        <p className="max-w-3xl text-base leading-8 text-slate-700">{"Consulte as d\u00edvidas da Bemol pelo CPF e simule as melhores condi\u00e7\u00f5es para o cliente."}</p>
      </section>

      <section className="glass-panel toolbar-panel animate-rise rounded-[1.8rem] p-6" style={{ animationDelay: "80ms" }}>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="section-kicker mb-2">Consulta</p>
            <h2 className="app-title text-2xl font-bold text-slate-800">Localizar cliente e iniciar negociação</h2>
          </div>
        </div>
        <div className="grid gap-4 md:grid-cols-[1.45fr_1fr_auto] md:items-end">
          <label className="flex h-full flex-col gap-2">
            <span className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-600">Documento do cliente</span>
            <input
              className="input-surface min-h-[52px] rounded-xl px-4 py-3"
              placeholder="CPF/CNPJ"
              value={cnpjcpf}
              onChange={(event) => setCnpjcpf(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !loadingContracts && cnpjcpf) {
                  void handleLoadContracts();
                }
              }}
            />
          </label>
          <label className="flex h-full flex-col gap-2">
            <span className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-600">Data de vencimento</span>
            <div className="flex min-h-[52px] items-center gap-2 rounded-xl border border-slate-200 bg-white/80 px-3 py-2 shadow-sm">
              <input
                ref={topDateInputRef}
                className="input-surface flex-1 rounded-lg px-3 py-2"
                type="date"
                value={dueDate}
                onChange={(event) => {
                  const nextDate = event.target.value || getTodayIsoLocal();
                  setDueDate(nextDate);
                  setDueDateInput(toBrDate(nextDate));
                }}
              />
              <button
                type="button"
                className="calendar-btn action-btn"
                onClick={() => openNativeDatePicker(topDateInputRef.current)}
                aria-label="Abrir calend?rio"
                title="Abrir calend?rio"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4">
                  <path d="M8 2v4M16 2v4M3 9h18" strokeLinecap="round" />
                  <rect x="3" y="4" width="18" height="17" rx="3" />
                </svg>
              </button>
            </div>
            <span className="mt-1 text-xs text-slate-500">Data selecionada: {dueDateInput}</span>
          </label>
          <button
            className="action-btn min-h-[52px] rounded-xl bg-[var(--primary)] px-6 py-3 font-semibold text-white disabled:opacity-60"
            onClick={handleLoadContracts}
            disabled={loadingContracts || !cnpjcpf}
          >
            {loadingContracts ? "Consultando..." : "Consultar dívida"}
          </button>
        </div>
      </section>

      {contracts.length > 0 && (
        <section className="glass-panel animate-rise rounded-[1.8rem] p-6" style={{ animationDelay: "120ms" }}>
          <div className="mb-4 grid gap-3 md:grid-cols-4 md:items-end">
            <div className="metric-card rounded-2xl px-4 py-5 text-center">
              <p className="mb-1 text-xs font-semibold uppercase text-slate-600">Total de contratos</p>
              <p className="text-2xl font-bold text-slate-800">{contracts.length}</p>
            </div>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-semibold uppercase text-slate-600">Qtd. a selecionar</span>
              <input
                type="number"
                min={0}
                max={contracts.length}
                className="input-surface rounded-xl px-3 py-2"
                value={quantidadeSelecionada}
                onChange={(event) => setQuantidadeSelecionada(Number(event.target.value || 0))}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-semibold uppercase text-slate-600">Parcelas para mostrar</span>
              <input
                type="number"
                min={1}
                className="input-surface rounded-xl px-3 py-2"
                value={parcelasPreferidas}
                onChange={(event) => handlePreferredInstallmentsChange(event.target.value)}
              />
            </label>
            <button
              className="action-btn rounded-xl bg-[var(--primary-2)] px-4 py-2 font-semibold text-white disabled:opacity-60"
              onClick={handleSimulate}
              disabled={loadingSimulation || contracts.length === 0}
            >
              {loadingSimulation
                ? "Simulando..."
                : `Recalcular todos os contratos (${contracts.length})`}
            </button>
          </div>

          <div className="summary-strip mb-4 grid gap-3 rounded-2xl p-4 md:grid-cols-2 md:items-end">
            <label className="flex flex-col gap-1">
              <span className="text-xs font-semibold uppercase text-slate-600">Entrada sugerida do cliente</span>
              <input
                type="number"
                min={0}
                step="0.01"
                className="input-surface rounded-xl px-3 py-2"
                value={desiredEntry}
                onChange={(event) => setDesiredEntry(event.target.value)}
              />
            </label>
            <label className="flex items-center gap-3 rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700">
              <input
                type="checkbox"
                checked={emitAllOpenTitles}
                onChange={(event) => setEmitAllOpenTitles(event.target.checked)}
              />
              Emitir todas as parcelas em aberto
            </label>
          </div>

          <div className="mb-4 flex flex-wrap gap-2">
            <button
              className="action-btn rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700"
              onClick={handleClearSelection}
              type="button"
            >
              {"Limpar sele\u00e7\u00e3o"}
            </button>
            <button
              className="action-btn rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700"
              onClick={handleSelectAll}
              type="button"
            >
              Selecionar todos
            </button>
            <button
              className="action-btn rounded-xl border border-cyan-400 bg-cyan-50 px-3 py-2 text-sm font-semibold text-cyan-800"
              onClick={handleSelectNFirst}
              type="button"
            >
              Aplicar quantidade informada
            </button>
          </div>

          <div className="table-shell overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-slate-300">
                  <th className="p-2">Sel.</th>
                  <th className="p-2">Contrato</th>
                  <th className="p-2">Identificador</th>
                  <th className="p-2">Produto</th>
                  <th className="p-2">Dias de atraso</th>
                  <th className="p-2">Valor base</th>
                </tr>
              </thead>
              <tbody>
                {contracts.map((contract) => {
                  const contractKey = `${contract.idCon}:${contract.idServ}`;
                  const checked = selectedKeys.includes(contractKey);
                  return (
                    <tr
                      key={contractKey}
                      className={`cursor-pointer border-b border-slate-200 transition-colors ${checked ? "bg-cyan-50/80" : ""}`}
                      onClick={() => {
                        setSelectedKeys((prev) => {
                          const next = prev.includes(contractKey)
                            ? prev.filter((item) => item !== contractKey)
                            : Array.from(new Set([...prev, contractKey]));
                          setScenarioSelections({});
                          setQuantidadeSelecionada(next.length);
                          return next;
                        });
                      }}
                    >
                      <td className="p-2">
                        <input
                          type="checkbox"
                          checked={checked}
                          className="accent-cyan-700"
                          onClick={(event) => event.stopPropagation()}
                          onChange={(event) => {
                            setSelectedKeys((prev) => {
                              const next = event.target.checked
                                ? Array.from(new Set([...prev, contractKey]))
                                : prev.filter((item) => item !== contractKey);
                              setScenarioSelections({});
                              setQuantidadeSelecionada(next.length);
                              return next;
                            });
                          }}
                        />
                      </td>
                      <td className="p-2">{contract.numeroContrato}</td>
                      <td className="p-2">{contract.idCon}</td>
                      <td className="p-2">{contract.produto}</td>
                      <td className="p-2">{contract.diasAtraso}</td>
                      <td className="p-2">{currency(contract.valorCorrigido)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {simulation && (
        <section className="grid gap-4 md:grid-cols-5">
          <article className="glass-panel metric-card animate-rise rounded-3xl p-6" style={{ animationDelay: "180ms" }}>
            <p className="text-sm font-semibold text-slate-700">{"Total \u00e0 vista"}</p>
            <strong className="app-title text-3xl text-emerald-800">{currency(summary.totalAvista)}</strong>
          </article>
          <article className="glass-panel metric-card animate-rise rounded-3xl p-6" style={{ animationDelay: "220ms" }}>
            <p className="text-sm font-semibold text-slate-700">Entrada total</p>
            <strong className="app-title text-3xl text-blue-800">{currency(summary.totalEntrada)}</strong>
          </article>
          <article className="glass-panel metric-card animate-rise rounded-3xl p-6" style={{ animationDelay: "260ms" }}>
            <p className="text-sm font-semibold text-slate-700">Total mensal</p>
            <strong className="app-title text-3xl text-cyan-800">{currency(summary.totalMensal)}</strong>
          </article>
          <article className="glass-panel metric-card animate-rise rounded-3xl p-6" style={{ animationDelay: "300ms" }}>
            <p className="text-sm font-semibold text-slate-700">Total negociado</p>
            <strong className="app-title text-3xl text-indigo-800">{currency(summary.totalNegociado)}</strong>
          </article>
          <article className="glass-panel metric-card animate-rise rounded-3xl p-6" style={{ animationDelay: "340ms" }}>
            <p className="text-sm font-semibold text-slate-700">Contratos simulados</p>
            <strong className="app-title text-3xl text-slate-800">{summary.contratos}</strong>
          </article>
        </section>
      )}

      {simulation && (
        <section className="glass-panel metric-card animate-rise rounded-3xl p-6" style={{ animationDelay: "300ms" }}>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <h3 className="app-title text-2xl font-bold text-slate-800">Resultado por contrato</h3>
            <button
              type="button"
              className="action-btn rounded-xl bg-slate-900 px-4 py-2 font-semibold text-white disabled:opacity-60"
              onClick={() => {
                setClosePanelOpen(true);
                void loadOperators();
              }}
              disabled={eligibleClosingCandidates.length === 0}
            >
              {"Fechar negocia\u00e7\u00e3o"}
            </button>
          </div>
          {titleOnlyCount > 0 && (
            <p className="mb-4 text-sm text-slate-600">
              {titleOnlyCount} contrato(s) {"ser\u00e3o tratados somente com emiss\u00e3o de boleto"}{emitAllOpenTitles ? ", incluindo todas as parcelas em aberto." : "."}
            </p>
          )}
          {desiredEntry && (
            <div className="mb-4 rounded-2xl border border-emerald-200 bg-emerald-50/90 p-4 text-sm text-emerald-900 shadow-sm">
              <p className="mb-3 font-semibold">{"Cenários para a entrada informada"}</p>
              {entryScenarios.length > 0 ? (
                <div className="grid gap-3 md:grid-cols-2">
                  {entryScenarios.map((scenario) => (
                    <div key={scenario.contractCount} className="rounded-2xl border border-emerald-200 bg-white p-4 shadow-sm">
                      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-emerald-100 pb-3">
                        <div>
                          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-emerald-700">Cenário sugerido</p>
                          <p className="mt-1 text-base font-semibold text-slate-900">{scenario.contractCount} contrato(s) com entrada total de {currency(scenario.totalEntry)}</p>
                        </div>
                        <button
                          type="button"
                          className="rounded-lg border border-emerald-300 px-3 py-2 text-xs font-semibold text-emerald-800"
                          onClick={() => handleApplyEntryScenario(scenario.selections)}
                        >
                          {"Usar este cenário"}
                        </button>
                      </div>
                      <div className="mt-3 space-y-2">
                        {scenario.labels.map((label) => (
                          <div key={label} className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700">
                            {label}
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p>{"Nenhum cenário encontrado para essa entrada."}</p>
              )}
            </div>
          )}
          {invalidNegotiationCount > 0 && (
            <p className="mb-4 text-sm text-amber-700">
              {invalidNegotiationCount} contrato(s) {"ficaram fora da negocia\u00e7\u00e3o porque n\u00e3o atendem ao valor m\u00ednimo de parcela de R$ 50,00 nos parcelamentos."}
            </p>
          )}
          {consolidatedPreview.length > 0 && (
            <div className="summary-strip mb-4 rounded-2xl p-4">
              <p className="mb-1 text-sm font-semibold text-slate-800">Total mensal consolidado da seleção</p>
              <p className="mb-3 text-xs text-slate-600">Aqui somamos o que o cliente pagará em cada mês considerando todos os contratos selecionados.</p>
              <div className="flex flex-wrap gap-2">
                {consolidatedPreview.map((preview) => (
                  <span
                    key={preview.sortKey}
                    className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-700"
                  >
                    {preview.label}: {currency(preview.value)}
                  </span>
                ))}
              </div>
            </div>
          )}
          <div className="table-shell overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-slate-300">
                  <th className="p-2">Contrato</th>
                  <th className="p-2">Tipo</th>
                  <th className="p-2">Produto</th>
                  <th className="p-2">{"\u00c0 vista"}</th>
                  <th className="p-2">{"1\u00aa parcela"}</th>
                  <th className="p-2">Demais</th>
                  <th className="p-2">Parcelas</th>
                  <th className="p-2">A vencer</th>
                </tr>
              </thead>
              <tbody>
                {displayedItems.map((item) => {
                  const contractKey = `${item.contract.idCon}:${item.contract.idServ}`;

                  return (
                    <tr key={contractKey} className="border-b border-slate-200">
                      <td className="p-2">{item.contract.numeroContrato}</td>
                      <td className="p-2">
                        {item.contract.hasPossibleActiveAgreement ? (
                          <span className="rounded-full bg-sky-100 px-2 py-1 text-xs font-semibold text-sky-800">
                            Acordo ativo
                          </span>
                        ) : item.processingMode !== "titulo" && !item.selectedOption ? (
                          <span className="rounded-full bg-rose-100 px-2 py-1 text-xs font-semibold text-rose-700">
                            {"Fora do critério"}
                          </span>
                        ) : item.processingMode === "titulo" ? (
                          <span className="rounded-full bg-amber-100 px-2 py-1 text-xs font-semibold text-amber-800">
                            Somente boleto
                          </span>
                        ) : (
                          <span className="rounded-full bg-emerald-100 px-2 py-1 text-xs font-semibold text-emerald-800">
                            {"Parcelável"}
                          </span>
                        )}
                      </td>
                      <td className="p-2">{item.contract.produto}</td>
                      <td className="p-2">{currency(item.aVistaOption?.valorNegociar ?? 0)}</td>
                      <td className="p-2">{currency(item.selectedOption?.valorPrimeira ?? 0)}</td>
                      <td className="p-2">
                        {currency(
                          item.processingMode === "titulo"
                            ? (item.pendingTitlesCount && item.pendingTitlesCount > 0 ? (item.pendingTitlesUnitValue ?? 0) : 0)
                            : (item.selectedOption?.valorDemais ?? 0),
                        )}
                      </td>
                      <td className="p-2">{item.selectedOption?.parcelasNum ?? "-"}</td>
                      <td className="p-2">
                        {item.processingMode === "titulo" ? (
                          <div className="space-y-2">
                            {(item.contract.titulos ?? [])
                              .filter((title) => {
                                const dueIso = (title.dataVencimento ?? "").slice(0, 10);
                                if (!dueIso) return false;
                                return emitAllOpenTitles ? true : dueIso < dueDate;
                              })
                              .map((title) => {
                                const selectedTitleIds = item.selectedTitleIds ?? [];
                                const checked = selectedTitleIds.includes(title.idTra);
                                const dueDateIso = (title.dataVencimento ?? "").slice(0, 10);
                                const dueDateLabel = dueDateIso
                                  ? toBrDate(dueDateIso)
                                  : title.idTra;
                                return (
                                  <label key={title.idTra} className="flex items-center gap-2 text-xs text-slate-700">
                                    <input
                                      type="checkbox"
                                      checked={checked}
                                      onChange={(event) => handleToggleTitleSelection(contractKey, title.idTra, event.target.checked)}
                                    />
                                    <span>{dueDateLabel} - {currency(title.valorAtualizado || title.valorOriginal || 0)}</span>
                                  </label>
                                );
                              })}
                            <div>{item.pendingTitlesSummary ?? "-"}</div>
                          </div>
                        ) : (
                          item.pendingTitlesSummary ?? "-"
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {error && (
        <section className="rounded-2xl border border-red-200 bg-red-50/95 p-4 text-[var(--danger)] shadow-sm">
          <strong>Erro:</strong> {error}
        </section>
      )}

      {closePanelOpen && (
        <section className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-slate-950/50 px-4 py-8 animate-rise">
          <div className="glass-panel w-full max-w-5xl rounded-[2rem] p-6 shadow-2xl md:p-8">
            <div className="mb-6 flex items-start justify-between gap-4 border-b border-slate-200/70 pb-5">
              <div>
                <p className="mb-1 text-sm font-semibold uppercase tracking-[0.2em] text-[var(--primary)]">
                  Fechamento
                </p>
                <h2 className="app-title text-3xl font-bold text-slate-800">{"Confirmar negocia\u00e7\u00e3o"}</h2>
              </div>
              <button
                type="button"
                className="action-btn rounded-full border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700"
                onClick={() => setClosePanelOpen(false)}
              >
                Fechar
              </button>
            </div>

            <div className="summary-strip mb-6 grid gap-4 rounded-3xl p-5 md:grid-cols-3">
              <label className="flex flex-col gap-2">
                <span className="text-xs font-semibold uppercase text-slate-600">Data do fechamento</span>
                <div className="flex flex-col gap-1">
                  <div className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 shadow-sm">
                    <input
                      ref={closeDateInputRef}
                      className="input-surface flex-1 rounded-xl px-3 py-2"
                      type="date"
                      value={dueDate}
                      onChange={(event) => {
                        const nextDate = event.target.value || getTodayIsoLocal();
                        setDueDate(nextDate);
                        setDueDateInput(toBrDate(nextDate));
                      }}
                    />
                    <button
                      type="button"
                      className="calendar-btn action-btn"
                      onClick={() => openNativeDatePicker(closeDateInputRef.current)}
                      aria-label="Abrir calend?rio"
                      title="Abrir calend?rio"
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4">
                        <path d="M8 2v4M16 2v4M3 9h18" strokeLinecap="round" />
                        <rect x="3" y="4" width="18" height="17" rx="3" />
                      </svg>
                    </button>
                  </div>
                  <span className="text-xs text-slate-500">Data selecionada: {dueDateInput}</span>
                </div>
                {hasClosingSelection && !agreementAllowed && (
                  <span className="text-xs text-amber-700">
                    {"Para datas acima de amanh\u00e3, o fechamento ser\u00e1 gravado como promessa."}
                  </span>
                )}
              </label>

              {closingKind === "acordo" ? (
                <label className="flex flex-col gap-2">
                  <span className="text-xs font-semibold uppercase text-slate-600">Canal do boleto</span>
                  <select
                    className="input-surface rounded-2xl px-4 py-3"
                    value={deliveryChannel}
                    onChange={(event) => setDeliveryChannel(event.target.value as (typeof DELIVERY_CHANNELS)[number]["value"])}
                  >
                    {DELIVERY_CHANNELS.filter((channel) => channel.value !== "2" || preferredEmail).map((channel) => (
                      <option
                        key={channel.value}
                        value={channel.value}
                        disabled={!preferredPhone && (channel.value === "3" || channel.value === "6")}
                      >
                        {channel.label}
                      </option>
                    ))}
                  </select>
                  <span className="text-xs text-slate-500">
                    {loadingPreferredPhone
                      ? "Consultando telefone preferencial..."
                      : preferredPhone
                        ? `Telefone preferencial: ${preferredPhone}`
                        : "Sem telefone celular ativo, os canais SMS e WhatsApp ficam bloqueados."}
                  </span>
                </label>
              ) : (
                <div className="rounded-2xl border border-slate-200 bg-white/80 px-4 py-3 text-sm text-slate-700 shadow-sm">
                  <p className="font-semibold text-slate-800">Promessa de pagamento</p>
                  <p>Em negociacoes de promessa o envio e feito um dia antes do pagamento.</p>
                </div>
              )}

              <div className="rounded-2xl border border-slate-200 bg-white/80 px-4 py-3 text-sm text-slate-700 shadow-sm">
                <p><strong>{agreementCount}</strong> contrato(s) com {closingKind}</p>
                <p><strong>{titleOnlyCount}</strong> contrato(s) somente boleto</p>
                {closingKind === "acordo" && (
                  <p className="mt-1 text-slate-600">
                    Ao confirmar, o sistema grava o acordo, emite o boleto e envia pelo canal selecionado.
                  </p>
                )}
              </div>
            </div>

            <div className="mb-6 relative max-w-xl rounded-3xl border border-slate-200 bg-white/70 p-5 shadow-sm">
              <label className="mb-2 block text-xs font-semibold uppercase text-slate-600">
                {"Operador respons\u00e1vel"}
              </label>
              {selectedOperator ? (
                <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-emerald-900">{selectedOperator.nome}</p>
                      <p className="text-xs uppercase tracking-[0.16em] text-emerald-700">{selectedOperator.login}</p>
                    </div>
                    <button
                      type="button"
                    className="rounded-lg border border-emerald-300 px-3 py-2 text-xs font-semibold text-emerald-800"
                      onClick={() => {
                        setSelectedOperator(null);
                        setOperatorQuery("");
                        setHighlightedOperatorIndex(0);
                      }}
                    >
                      Alterar
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <input
                    className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2"
                    placeholder="Digite o nome ou login do operador"
                    value={operatorQuery}
                    onFocus={loadOperators}
                    onKeyDown={(event) => {
                      if (!filteredOperators.length) return;
                      if (event.key === "ArrowDown") {
                        event.preventDefault();
                        setHighlightedOperatorIndex((current) => (current + 1) % filteredOperators.length);
                        return;
                      }
                      if (event.key === "ArrowUp") {
                        event.preventDefault();
                        setHighlightedOperatorIndex((current) => (current - 1 + filteredOperators.length) % filteredOperators.length);
                        return;
                      }
                      if (event.key === "Enter") {
                        event.preventDefault();
                        const operator = filteredOperators[Math.max(0, Math.min(highlightedOperatorIndex, filteredOperators.length - 1))];
                        if (operator) {
                          setSelectedOperator(operator);
                          setOperatorQuery("");
                          setHighlightedOperatorIndex(0);
                        }
                      }
                    }}
                    onChange={(event) => {
                      if (operators.length === 0) {
                        void loadOperators();
                      }
                      setOperatorQuery(event.target.value);
                      setHighlightedOperatorIndex(0);
                    }}
                  />
                  {operatorQuery && (
                <div className="absolute z-20 mt-2 max-h-56 w-full overflow-auto rounded-xl border border-slate-200 bg-white shadow-xl">
                  {loadingOperators ? (
                    <div className="px-3 py-2 text-sm text-slate-500">Carregando operadores...</div>
                  ) : filteredOperators.length > 0 ? (
                    filteredOperators.map((item) => (
                      <button
                        key={item.idPes}
                        type="button"
                        className={`flex w-full items-center justify-between px-3 py-2 text-left text-sm ${
                          filteredOperators[highlightedOperatorIndex]?.idPes === item.idPes ? "bg-slate-100" : "hover:bg-slate-50"
                        }`}
                        onClick={() => {
                          setSelectedOperator(item);
                          setOperatorQuery("");
                          setHighlightedOperatorIndex(0);
                        }}
                      >
                        <span className="font-medium text-slate-800">{item.nome}</span>
                        <span className="text-xs text-slate-500">{item.login}</span>
                      </button>
                    ))
                  ) : (
                    <div className="px-3 py-2 text-sm text-slate-500">Nenhum operador encontrado.</div>
                  )}
                </div>
                  )}
                </>
              )}
            </div>

            <div className="mb-6 space-y-4">
              {agreementCandidates.length > 0 && (
                <div className="overflow-x-auto rounded-2xl border border-emerald-200">
                  <div className="border-b border-emerald-200 bg-emerald-50 px-4 py-3">
                    <h3 className="text-sm font-semibold uppercase text-emerald-800">
                      Vai gravar {closingKind} e emitir boleto
                    </h3>
                  </div>
                  <table className="w-full text-left text-sm">
                    <thead className="bg-slate-50">
                      <tr>
                        <th className="p-3">Contrato</th>
                        <th className="p-3">Produto</th>
                        <th className="p-3">{"\u00c0 vista"}</th>
                        <th className="p-3">Entrada</th>
                        <th className="p-3">Demais</th>
                        <th className="p-3">Parcelas</th>
                        <th className="p-3">Total negociado</th>
                      </tr>
                    </thead>
                    <tbody>
                      {agreementCandidates.map((item) => {
                        const selected = item.selectedOption;
                        const totalNegociado = (selected?.valorPrimeira ?? 0) + (selected?.valorDemais ?? 0) * Math.max(0, (selected?.parcelasNum ?? 1) - 1);
                        return (
                          <tr key={`${item.contract.idCon}:${item.contract.idServ}`} className="border-t border-slate-200">
                            <td className="p-3">{item.contract.numeroContrato}</td>
                            <td className="p-3">{item.contract.produto}</td>
                            <td className="p-3">{currency(item.aVistaOption?.valorNegociar ?? 0)}</td>
                            <td className="p-3">{currency(selected?.valorPrimeira ?? 0)}</td>
                            <td className="p-3">{currency(selected?.valorDemais ?? 0)}</td>
                            <td className="p-3">{selected?.parcelasNum ?? "-"}</td>
                            <td className="p-3">{currency(totalNegociado)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}

              {titleCandidates.length > 0 && (
                <div className="overflow-x-auto rounded-2xl border border-amber-200">
                  <div className="border-b border-amber-200 bg-amber-50 px-4 py-3">
                    <h3 className="text-sm font-semibold uppercase text-amber-800">
                      {closingKind === "promessa" ? "Vai gravar promessa de pagamento" : "Vai apenas emitir boleto"}
                    </h3>
                  </div>
                  <table className="w-full text-left text-sm">
                    <thead className="bg-slate-50">
                      <tr>
                        <th className="p-3">Contrato</th>
                        <th className="p-3">Produto</th>
                        <th className="p-3">{"\u00c0 vista"}</th>
                        <th className="p-3">Entrada</th>
                        <th className="p-3">Demais</th>
                        <th className="p-3">Parcelas</th>
                        <th className="p-3">Total negociado</th>
                      </tr>
                    </thead>
                    <tbody>
                      {titleCandidates.map((item) => {
                        const selected = item.selectedOption;
                        const totalNegociado = (selected?.valorPrimeira ?? 0) + (selected?.valorDemais ?? 0) * Math.max(0, (selected?.parcelasNum ?? 1) - 1);
                        return (
                          <tr key={`${item.contract.idCon}:${item.contract.idServ}`} className="border-t border-slate-200">
                            <td className="p-3">{item.contract.numeroContrato}</td>
                            <td className="p-3">{item.contract.produto}</td>
                            <td className="p-3">{currency(item.aVistaOption?.valorNegociar ?? 0)}</td>
                            <td className="p-3">{currency(selected?.valorPrimeira ?? 0)}</td>
                            <td className="p-3">{currency(selected?.valorDemais ?? 0)}</td>
                            <td className="p-3">{selected?.parcelasNum ?? "-"}</td>
                            <td className="p-3">{currency(totalNegociado)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3">
              <button
                type="button"
                className={`action-btn ml-auto rounded-2xl bg-[var(--primary)] px-5 py-3 font-semibold text-white disabled:opacity-60 ${closingNegotiation ? "animate-processing" : ""}`}
                onClick={() => void handleConfirmClose()}
                disabled={
                  closingNegotiation
                }
              >
                {closingNegotiation
                  ? closingKind === "acordo" ? "Fechando acordo..." : "Gravando promessa..."
                  : closingKind === "acordo" ? "Confirmar acordo" : "Confirmar promessa"}
              </button>
            </div>

            {closeResult && (
              <div className="mt-8 rounded-2xl border border-slate-200 p-4">
                <div className="mb-4 flex flex-wrap gap-4 text-sm text-slate-700">
                  <span><strong>Processados:</strong> {closeResult.summary.processed}</span>
                  <span><strong>Sucesso:</strong> {closeResult.summary.success}</span>
                  <span><strong>Falhas:</strong> {closeResult.summary.failed}</span>
                  <span><strong>Com boleto/PIX:</strong> {closeResult.summary.boletoGenerated}</span>
                </div>
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="rounded-2xl border border-slate-200 p-3">
                    <h3 className="mb-3 text-sm font-semibold uppercase text-slate-600">Gravacao e andamento</h3>
                    <div className="space-y-3">
                      {closeResult.items.map((item) => (
                        <div key={`grav-${item.contract.idCon}:${item.contract.idServ}`} className="rounded-xl border border-slate-100 p-3 text-sm">
                          <div className="mb-1 flex items-center justify-between gap-2">
                            <strong className="text-slate-800">{item.contract.numeroContrato}</strong>
                            <span className={`rounded-full px-2 py-1 text-xs font-semibold ${item.status === "success" ? "bg-emerald-100 text-emerald-800" : "bg-red-100 text-red-700"}`}>
                              {item.status === "success" ? (item.mode === "titulo" ? "Emitido" : "Gravado") : "Falha"}
                            </span>
                          </div>
                          <p className="text-slate-600">
                            {item.status === "success"
                              ? item.gravacao?.mensagemRetorno || item.andamento?.mensagemRetorno || "Processado com sucesso."
                              : item.error}
                          </p>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div className="rounded-2xl border border-slate-200 p-3">
                    <h3 className="mb-3 text-sm font-semibold uppercase text-slate-600">Boleto e PIX</h3>
                    <div className="space-y-3">
                      {closeResult.items.map((item) => (
                        <div key={`bol-${item.contract.idCon}:${item.contract.idServ}`} className="rounded-xl border border-slate-100 p-3 text-sm">
                          <div className="mb-1 flex items-center justify-between gap-2">
                            <strong className="text-slate-800">{item.contract.numeroContrato}</strong>
                            <span className={`rounded-full px-2 py-1 text-xs font-semibold ${item.status === "success" && (item.boleto?.linhaDigitavel || item.boleto?.pixCopiaCola || item.boleto?.boletoUrl) ? "bg-cyan-100 text-cyan-800" : "bg-slate-100 text-slate-600"}`}>
                              {item.status === "success" && (item.boleto?.linhaDigitavel || item.boleto?.pixCopiaCola || item.boleto?.boletoUrl) ? "Emitido" : "Sem emiss\u00e3o"}
                            </span>
                          </div>
                          <p className="break-all text-slate-600"><strong>Linha:</strong> {item.status === "success" ? item.boleto?.linhaDigitavel ?? "-" : "-"}</p>
                          <p className="break-all text-slate-600"><strong>PIX:</strong> {item.status === "success" ? item.boleto?.pixCopiaCola ?? "-" : "-"}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </section>
      )}
    </main>
  );
}

function sanitizeContractForDisplay(value: string): string {
  if (!value) return "";
  const alphaNumMatch = value.match(/[A-Za-z]{2,}\d{5,}/);
  if (alphaNumMatch?.[0]) return alphaNumMatch[0];
  const numberMatch = value.match(/\d{8,}/);
  if (numberMatch?.[0]) return numberMatch[0];
  return value.replace(/[^\w-]/g, "");
}















