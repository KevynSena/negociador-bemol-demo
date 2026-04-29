# Negociador Bemol

Aplicacao web em Next.js para consulta, simulacao e fechamento de negociacoes. O projeto foi preparado para portfolio com um modo demonstrativo, sem necessidade de acesso ao dominio interno, banco SQL Server ou API real.

## Demo local

1. Instale as dependencias:

```powershell
npm.cmd install
```

2. Crie um arquivo `.env.local` com:

```env
DEMO_MODE=true
DEMO_CPF=00000000000
```

3. Inicie o projeto:

```powershell
npm.cmd run dev
```

4. Acesse `http://localhost:3000` e consulte o CPF demo:

```text
00000000000
```

## O que o modo demo permite testar

- Consulta de contratos ficticios por CPF/CNPJ.
- Simulacao de negociacao com contratos e titulos.
- Selecao de vencimento, parcelas, contratos e titulos.
- Consulta de operador demonstrativo.
- Fechamento demonstrativo com acordo, boleto/PIX ficticio e registro de andamento.

## Stack

- Next.js
- React
- TypeScript
- Node.js
- SQL Server via `mssql` no modo interno
- Integracao SOAP/XML no modo interno
- Tailwind CSS

## Variaveis internas

As variaveis abaixo devem ser usadas apenas em ambiente privado. Nao publique `.env.local`, certificados, logs, XMLs de retorno ou credenciais.

```env
NECTAR_CNPJ=
NECTAR_CODIGO_PARCEIRO=
NECTAR_USUARIO=
NECTAR_SENHA=
SQLSERVER_HOST=
SQLSERVER_DATABASE=
SQLSERVER_USER=
SQLSERVER_PASSWORD=
```

## Observacao de seguranca

Este repositorio deve conter apenas dados ficticios. Qualquer arquivo `.env`, `.log`, XML temporario, certificado ou retorno real de API deve ficar fora do GitHub.
