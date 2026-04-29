import { existsSync, readFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";
import next from "next";

const currentFile = fileURLToPath(import.meta.url);
const projectRoot = path.dirname(currentFile);

function loadEnvFile(fileName) {
  const envPath = path.join(projectRoot, fileName);
  if (!existsSync(envPath)) return;

  const content = readFileSync(envPath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const separatorIndex = line.indexOf("=");
    if (separatorIndex < 0) continue;

    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim().replace(/^(['"])(.*)\1$/, "$2");

    if (!key || process.env[key] !== undefined) continue;
    process.env[key] = value;
  }
}

loadEnvFile(".env");
loadEnvFile(".env.local");

const hostname = process.env.SERVER_HOST ?? "0.0.0.0";
const allowedHostname = (process.env.ALLOWED_HOSTNAME ?? "").trim().toLowerCase();
const hasTlsConfig = Boolean(
  process.env.TLS_PFX_PATH || process.env.TLS_KEY_PATH || process.env.TLS_CERT_PATH,
);
const dev = process.env.NODE_ENV === "development";
const port = Number.parseInt(process.env.PORT ?? (hasTlsConfig || allowedHostname ? "443" : "3000"), 10);

function getDisplayHost() {
  if (allowedHostname) return allowedHostname;
  if (hostname === "0.0.0.0" || hostname === "::") return "localhost";
  return hostname;
}

function resolveProjectPath(targetPath) {
  if (!targetPath) return "";
  return path.isAbsolute(targetPath) ? targetPath : path.join(projectRoot, targetPath);
}

function normalizeHostHeader(hostHeader) {
  const raw = (hostHeader ?? "").trim().toLowerCase();
  if (!raw) return "";

  if (raw.startsWith("[")) {
    const closing = raw.indexOf("]");
    return closing >= 0 ? raw.slice(1, closing) : raw;
  }

  return raw.split(":")[0];
}

function isAllowedHost(hostHeader) {
  if (!allowedHostname || dev) return true;
  return normalizeHostHeader(hostHeader) === allowedHostname;
}

function loadHttpsOptions() {
  const pfxPath = resolveProjectPath(process.env.TLS_PFX_PATH ?? "");
  const pfxPassphrase = process.env.TLS_PFX_PASSPHRASE ?? "";
  const keyPath = resolveProjectPath(process.env.TLS_KEY_PATH ?? "");
  const certPath = resolveProjectPath(process.env.TLS_CERT_PATH ?? "");
  const caPath = resolveProjectPath(process.env.TLS_CA_PATH ?? "");

  if (pfxPath) {
    if (!existsSync(pfxPath)) {
      throw new Error(`Arquivo PFX nao encontrado em: ${pfxPath}`);
    }

    const options = {
      pfx: readFileSync(pfxPath),
    };

    if (pfxPassphrase) {
      options.passphrase = pfxPassphrase;
    }

    return options;
  }

  if (!keyPath && !certPath) {
    return null;
  }

  if (!keyPath) {
    throw new Error("TLS_KEY_PATH nao foi configurado.");
  }

  if (!certPath) {
    throw new Error("TLS_CERT_PATH nao foi configurado.");
  }

  if (!existsSync(keyPath)) {
    throw new Error(`Arquivo de chave nao encontrado em: ${keyPath}`);
  }

  if (!existsSync(certPath)) {
    throw new Error(`Arquivo de certificado nao encontrado em: ${certPath}`);
  }

  const options = {
    key: readFileSync(keyPath),
    cert: readFileSync(certPath),
  };

  if (caPath && existsSync(caPath)) {
    options.ca = readFileSync(caPath);
  }

  return options;
}

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

function createRequestHandler() {
  return (req, res) => {
    if (!isAllowedHost(req.headers.host)) {
      res.statusCode = 421;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Host nao permitido.");
      return;
    }

    handle(req, res);
  };
}

app
  .prepare()
  .then(() => {
    const httpsOptions = loadHttpsOptions();
    if (!httpsOptions && allowedHostname) {
      throw new Error(
        "HTTPS nao foi configurado. Defina TLS_PFX_PATH ou TLS_KEY_PATH/TLS_CERT_PATH para usar ALLOWED_HOSTNAME.",
      );
    }

    const requestHandler = createRequestHandler();
    const server = httpsOptions
      ? createHttpsServer(httpsOptions, requestHandler)
      : createHttpServer(requestHandler);
    const protocol = httpsOptions ? "https" : "http";

    server.listen(port, hostname, () => {
      console.log(`${protocol.toUpperCase()} ativo em ${protocol}://${getDisplayHost()}:${port}`);
    });
  })
  .catch((error) => {
    console.error("Falha ao iniciar servidor:", error);
    process.exit(1);
  });
