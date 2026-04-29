import sql from "mssql";

export type OperatorOption = {
  idPes: string;
  nome: string;
  login: string;
};

type OperatorsCacheEntry = {
  refreshWindowKey: string;
  items: OperatorOption[];
};

const operatorsCache: OperatorsCacheEntry = {
  refreshWindowKey: "",
  items: [],
};

type SqlAuthConfig = {
  server: string;
  port: number;
  database: string;
  options: {
    encrypt: boolean;
    trustServerCertificate: boolean;
    enableArithAbort: boolean;
  };
  pool: {
    max: number;
    min: number;
    idleTimeoutMillis: number;
  };
  user?: string;
  password?: string;
  authentication?: {
    type: "ntlm";
    options: {
      userName: string;
      password: string;
      domain: string;
    };
  };
};

type OperatorRow = {
  idPes?: string | number | null;
  nome?: string | null;
  login?: string | null;
};

type SaoPauloDateParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
};

function getSaoPauloDateParts(date = new Date()): SaoPauloDateParts {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  const parts = formatter.formatToParts(date);
  const pick = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value ?? "0");

  return {
    year: pick("year"),
    month: pick("month"),
    day: pick("day"),
    hour: pick("hour"),
    minute: pick("minute"),
  };
}

function formatWindowKey(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}-0910`;
}

function getRefreshWindowKey(date = new Date()): string {
  const now = getSaoPauloDateParts(date);
  const afterRefreshTime = now.hour > 9 || (now.hour === 9 && now.minute >= 10);
  if (afterRefreshTime) {
    return formatWindowKey(now.year, now.month, now.day);
  }

  const previousDay = new Date(Date.UTC(now.year, now.month - 1, now.day));
  previousDay.setUTCDate(previousDay.getUTCDate() - 1);
  return formatWindowKey(
    previousDay.getUTCFullYear(),
    previousDay.getUTCMonth() + 1,
    previousDay.getUTCDate(),
  );
}

function getSqlConfig(): SqlAuthConfig {
  const server = process.env.SQLSERVER_HOST;
  const database = process.env.SQLSERVER_DATABASE;
  const user = process.env.SQLSERVER_USER;
  const password = process.env.SQLSERVER_PASSWORD;
  const domain = process.env.SQLSERVER_DOMAIN;
  const authMode = (process.env.SQLSERVER_AUTH_MODE || "sql").toLowerCase();
  if (!server || !database || !user || !password) {
    throw new Error("Configuracao do SQL Server incompleta.");
  }
  if (authMode === "ntlm" && !domain) {
    throw new Error("Configuracao do SQL Server incompleta para NTLM.");
  }

  const baseConfig: SqlAuthConfig = {
    server,
    port: Number(process.env.SQLSERVER_PORT || 1433),
    database,
    options: {
      encrypt: false,
      trustServerCertificate: true,
      enableArithAbort: true,
    },
    pool: {
      max: 3,
      min: 0,
      idleTimeoutMillis: 30000,
    },
  };

  if (authMode === "ntlm") {
    const resolvedDomain = domain ?? "";
    return {
      ...baseConfig,
      authentication: {
        type: "ntlm",
        options: {
          userName: user,
          password,
          domain: resolvedDomain,
        },
      },
    };
  }

  return {
    ...baseConfig,
    user,
    password,
  };
}

export async function getOperators(forceRefresh = false): Promise<OperatorOption[]> {
  const refreshWindowKey = getRefreshWindowKey();
  if (!forceRefresh && operatorsCache.refreshWindowKey === refreshWindowKey && operatorsCache.items.length > 0) {
    return operatorsCache.items;
  }

  const pool = new sql.ConnectionPool(getSqlConfig());
  await pool.connect();

  try {
    const result = await pool.request().query(`
      SELECT
        P.IDPES_PES AS idPes,
        P.NOME_PES AS nome,
        P.USUAR_PES AS login
      FROM NECTAR.DBO.TB_PESSOAL P WITH(NOLOCK)
      LEFT JOIN NECTAR.DBO.TB_PESEQUI PEQ WITH(NOLOCK)
        ON PEQ.IDPES_PEQ = P.IDPES_PES
      INNER JOIN NECTAR.DBO.TB_EQUIPE EQ WITH(NOLOCK)
        ON EQ.IDEQU_EQU = PEQ.IDEQU_PEQ
      WHERE EQ.IDEQU_EQU IN (24, 33, 46, 47, 48, 51)
      ORDER BY P.NOME_PES
    `);

    const items = (result.recordset ?? [])
      .map((row: OperatorRow) => ({
        idPes: String(row.idPes ?? "").trim(),
        nome: String(row.nome ?? "").trim(),
        login: String(row.login ?? "").trim(),
      }))
      .filter((item: OperatorOption) => item.idPes && item.nome);

    operatorsCache.refreshWindowKey = refreshWindowKey;
    operatorsCache.items = items;
    return items;
  } finally {
    await pool.close();
  }
}
