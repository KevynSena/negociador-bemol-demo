import { randomUUID } from "crypto";

const SOAP_NAMESPACE = "http://www.w3.org/2003/05/soap-envelope";
const TEMPURI = "http://tempuri.org/";
const ADDRESSING = "http://www.w3.org/2005/08/addressing";
const SERVICE_URL =
  process.env.NECTAR_BASE_URL?.trim() || "https://example.invalid/WSNectar/Servicos/ServicoNectar.svc";

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function buildSoapEnvelope(action: string, methodName: string, methodBody: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="${SOAP_NAMESPACE}" xmlns:tem="${TEMPURI}" xmlns:a="${ADDRESSING}">
  <soap:Header>
    <a:Action>${action}</a:Action>
    <a:To>${SERVICE_URL}</a:To>
    <a:MessageID>urn:uuid:${randomUUID()}</a:MessageID>
    <a:ReplyTo>
      <a:Address>${ADDRESSING}/anonymous</a:Address>
    </a:ReplyTo>
  </soap:Header>
  <soap:Body>
    <tem:${methodName}>
      ${methodBody}
    </tem:${methodName}>
  </soap:Body>
</soap:Envelope>`;
}

export function extractTagValue(xml: string, tagNames: string[]): string | null {
  for (const name of tagNames) {
    const regex = new RegExp(`<(?:\\w+:)?${name}[^>]*>([\\s\\S]*?)<\\/(?:\\w+:)?${name}>`, "i");
    const match = xml.match(regex);
    if (match && match[1]) {
      return decodeXml(match[1].trim());
    }
  }
  return null;
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

export function parseMoney(raw: string | null | undefined): number {
  if (!raw) return 0;
  const cleaned = raw.replace(/[^\d,.-]/g, "").trim();
  if (!cleaned) return 0;

  let normalized = cleaned;
  const hasComma = cleaned.includes(",");
  const hasDot = cleaned.includes(".");
  if (hasComma && hasDot) {
    // ex: 1.234,56 -> 1234.56
    normalized = cleaned.replace(/\./g, "").replace(",", ".");
  } else if (hasComma) {
    // ex: 1234,56 -> 1234.56
    normalized = cleaned.replace(",", ".");
  } else {
    // ex: 1234.56
    normalized = cleaned;
  }

  const numeric = Number(normalized);
  return Number.isFinite(numeric) ? numeric : 0;
}
