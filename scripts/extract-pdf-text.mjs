import { stdin, stdout, stderr } from "node:process";

async function readStdin() {
  const chunks = [];
  for await (const chunk of stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  const input = await readStdin();
  const payload = JSON.parse(input || "{}");
  const base64 = String(payload.base64 || "");
  const password = String(payload.password || "");

  if (!base64) {
    stdout.write(JSON.stringify({ ok: false, error: "EMPTY_BASE64" }));
    return;
  }

  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const data = new Uint8Array(Buffer.from(base64.replace(/\s+/g, ""), "base64"));
  const loadingTask = pdfjs.getDocument({
    data,
    password,
    useWorkerFetch: false,
    isEvalSupported: false,
    useSystemFonts: false,
    disableFontFace: true,
    verbosity: 0,
  });

  const doc = await loadingTask.promise;
  let text = "";

  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
    const page = await doc.getPage(pageNumber);
    const content = await page.getTextContent();
    text += `${content.items.map((item) => ("str" in item ? item.str : "")).join(" ")}\n`;
  }

  stdout.write(JSON.stringify({ ok: true, text }));
}

main().catch((error) => {
  stderr.write(String(error?.stack || error?.message || error));
  stdout.write(JSON.stringify({ ok: false, error: String(error?.message || error) }));
});
