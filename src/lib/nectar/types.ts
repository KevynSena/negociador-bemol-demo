export type NectarConfig = {
  cnpj: string;
  codigoParceiro: string;
  usuario: string;
  senha: string;
};

export type NectarContract = {
  idCon: string;
  idServ: string;
  numeroContrato: string;
  produto: string;
  diasAtraso: number;
  valorCorrigido: number;
  tiponegociacao?: string;
  boletodisponivel?: string;
  tpDesconto?: string;
  percDescAplicNoPrincipal?: string;
  percDescAplicNaCorrecao?: string;
  percDescAplicNosHonorarios?: string;
  percDescAplicNaPontualidade?: string;
  percDescAplicNaMulta?: string;
  percDescAplicNoJuros?: string;
  hasOpenAgreement?: boolean;
  hasOpenPromise?: boolean;
  hasPossibleActiveAgreement?: boolean;
  titulos?: NectarDebtTitle[];
};

export type NectarDebtTitle = {
  idTra: string;
  numeroTitulo?: string;
  dataVencimento: string;
  diasAtraso: number;
  descricao: string;
  valorOriginal: number;
  valorAtualizado: number;
};

export type NectarNegotiationOption = {
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

export type SimulationResult = {
  contract: NectarContract;
  selectedOption: NectarNegotiationOption | null;
  aVistaOption: NectarNegotiationOption | null;
  rawOptions: NectarNegotiationOption[];
};

export type GravarNegociacaoParams = {
  idCon: string;
  idServ: string;
  titulos?: string;
  plano: string;
  codigoFaixa: string;
  descricaoFaixa: string;
  parcelasNum: number;
  valordesconto: number;
  vencimentoprimeira: string;
  valorprimeira: number;
  valordemais: number;
  valororiginal: number;
  valorcorrigido: number;
  valornegociar: number;
  prazomaximo?: string;
  tiponegociacao?: string;
  boletodisponivel?: string;
  tpDesconto?: string;
  percDescAplicNoPrincipal?: string;
  percDescAplicNaCorrecao?: string;
  percDescAplicNosHonorarios?: string;
  percDescAplicNaPontualidade?: string;
  percDescAplicNaMulta?: string;
  percDescAplicNoJuros?: string;
  valorAplicNoJuros?: string;
  valorEntradaSugerido?: string;
  valorTotalSugerido?: string;
  codigoNegociacao?: string;
  infoNegociacao?: string;
  especiePagamento?: string;
  codigoToken: string;
  dtSegundaParcela?: string;
  idPesReal?: string;
  origemReal?: string;
  percDescAplicNaAntecipacao?: string;
  formaEnvioBoleto?: string;
  valorDespesas?: string;
};

export type GravarNegociacaoResult = {
  xml: string;
  codigoRetorno: string | null;
  mensagemRetorno: string | null;
  idParcela: string | null;
};

export type BoletoAcordoParams = {
  idboleto: string;
  idcon: string;
  idserv: string;
  codigoToken: string;
  tipo?: "ACORDO" | "TITULO";
  dtvencimento?: string;
  tipoenvio?: "1" | "2" | "3" | "6";
  origemReal?: string;
  gerarPdf?: "0" | "1";
  geraPix?: "0" | "1";
  especiePagamento?: string;
  tipoPixEspecie?: string;
  valorBoleto?: string;
  boletoQuitacao?: string;
  emailEnvio?: string;
  celularEnvio?: string;
  idPesReal?: string;
};

export type BoletoAcordoResult = {
  xml: string;
  codigoRetorno: string | null;
  mensagemRetorno: string | null;
  linhaDigitavel: string | null;
  pixCopiaCola: string | null;
  boletoUrl: string | null;
};

export type InsereAndamentoParams = {
  idCon?: string;
  idServ?: string;
  cpf: string;
  codigoToken: string;
  codigoandamento: string;
  dataandamento: string;
  valor?: number;
  idPesReal?: string;
  subOcorrencia?: string;
  dataAgendamento?: string;
  dataPagamento?: string;
  telefone?: string;
  complemento?: string;
  referencia?: string;
  protocolo?: string;
  tempoAndamento?: string;
};

export type InsereAndamentoResult = {
  xml: string;
  codigoRetorno: string | null;
  mensagemRetorno: string | null;
};

export type GetDadosDevedorResult = {
  xml: string;
  preferredPhone: string | null;
  preferredEmail: string | null;
};

