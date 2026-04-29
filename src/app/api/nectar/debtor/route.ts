import { NextRequest, NextResponse } from "next/server";
import { demoDebtor, isDemoRequest } from "@/lib/demo-data";
import { getDadosDevedor, getToken } from "@/lib/nectar/client";

export async function POST(req: NextRequest) {
  try {
    const payload = (await req.json()) as { cnpjcpf?: string };
    const cnpjcpf = (payload.cnpjcpf ?? "").trim();

    if (!cnpjcpf) {
      return NextResponse.json({ error: "Informe o CPF/CNPJ do cliente." }, { status: 400 });
    }

    if (isDemoRequest(cnpjcpf)) {
      return NextResponse.json({
        ...demoDebtor,
        demo: true,
      });
    }

    const token = await getToken();
    const debtor = await getDadosDevedor({ cnpjcpf, codigoToken: token });

    return NextResponse.json({
      preferredPhone: debtor.preferredPhone,
      preferredEmail: debtor.preferredEmail,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Falha ao consultar dados do devedor." },
      { status: 500 },
    );
  }
}
