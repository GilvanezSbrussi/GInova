# GInova — MVP 1

Início da construção do produto descrito no manual, seguindo exatamente a
ordem que o próprio documento recomenda (seção 86 — "Ordem correta de
desenvolvimento" / seção 112 — "Próxima etapa de desenvolvimento"):

| Etapa concluída agora | Onde está |
|---|---|
| 3. Protótipo das telas | `prototipo/ginova-prototipo.html` (abra no navegador) |
| 4. Banco PostgreSQL | `database/001_mvp1_schema.sql`, `002_app_role.sql`, `003_fix_rls_policies.sql`, `004_whatsapp_ia_tables.sql`, `005_estoque_fornecedores.sql` |
| 5–8. Backend/API + autenticação + clientes | `backend/auth/`, `backend/clientes/` |
| 9. Serviços | `backend/servicos/servicosRoutes.js` |
| 10. Orçamentos (com aprovação automática) | `backend/orcamentos/orcamentosRoutes.js` |
| 11. Agenda | `backend/agenda/agendaRoutes.js` |
| 12. Financeiro | `backend/financeiro/financeiroRoutes.js` |
| 13. Dashboard (resumo + alertas inteligentes) | `backend/dashboard/dashboardRoutes.js` |
| WhatsApp — webhook + idempotência | `backend/whatsapp/webhookRoutes.js`, `database/004_whatsapp_ia_tables.sql` |
| IA — motor de intenção + confirmação humana | `backend/ia/intentEngine.js`, `backend/whatsapp/interacoesRoutes.js` |
| IA_ASSISTENTE (perguntas em linguagem natural) | `backend/assistente/assistenteRoutes.js` |
| Fornecedores | `backend/fornecedores/fornecedoresRoutes.js` |
| Produtos + estoque (com movimentação auditada) | `backend/produtos/produtosRoutes.js`, `database/005_estoque_fornecedores.sql` |
| Testes automatizados (seção 70) | `backend/tests/` — 53 testes de integração, todos passando contra Postgres real |

## Fase 2 do roadmap: WhatsApp + IA — o que foi feito e o que falta

**Feito, e testado de ponta a ponta:**
- Webhook (`POST /api/v1/webhooks/whatsapp`) recebe mensagem, identifica/cria contato e conversa, e é **idempotente** (a mesma mensagem reenviada pelo provedor não duplica nada — seção 67).
- Motor de intenção baseado em regras (`backend/ia/intentEngine.js`) reconhece pedidos de orçamento, registro de pagamento e agendamento a partir do texto — a mesma interface estruturada da seção 64 (`intent`, `confidence`, `dados`, `confirmRequired`).
- **A IA nunca executa nada sozinha** (seção 5): toda sugestão vira uma linha em `ia_interacoes` com status `pendente`, e só se torna um orçamento ou pagamento real quando um usuário humano autenticado confirma em `POST /api/v1/whatsapp/interacoes/:id/confirmar` — com a mesma validação (zod, permissões) de qualquer outro endpoint.
- `IA_ASSISTENTE` de verdade: `POST /api/v1/assistente/perguntar` já responde "quanto tenho para receber", "quem está atrasado", "quanto vendi esse mês" e "qual serviço vende mais" consultando o banco real — não é mock.

**O que falta pra ser "de verdade" em produção** (documentado no próprio código):
- Trocar `intentEngine.js` por uma chamada real de LLM — a interface já está pronta pra isso, é só implementar `detectarIntencao(texto)` chamando uma API de IA em vez das regex.
- Conectar o webhook na API oficial do WhatsApp Business (Meta) — hoje ele aceita um payload simplificado; falta resolver `empresaId` a partir do `phone_number_id` do WhatsApp e validar a assinatura HMAC de verdade (hoje é um token simples).
- Mover a chamada da IA para uma fila de verdade (Redis/BullMQ, seção 65) quando ela deixar de ser instantânea (regras) e passar a ser uma chamada de rede pra uma LLM.

### Bugs que os testes pegaram nesta rodada (Fase 2 — WhatsApp/IA)

1. **`ia_interacoes` sem `updated_by`** — a tabela nova não seguia o padrão de campos da seção 32, e o código quebrava ao tentar confirmar/rejeitar uma sugestão. Corrigido na migração `004`.
2. **IA_ASSISTENTE não achava clientes atrasados** que o dashboard já via — a lógica de "marcar conta como vencida" estava duplicada em cada módulo, e o assistente não tinha essa cópia. Extraído para `backend/common/vencimentos.js`, compartilhado pelos três módulos que precisam disso.

## Fase 3 do roadmap: estoque e fornecedores

**Feito, e testado de ponta a ponta:**
- Cadastro de fornecedores e produtos, com estoque atual/mínimo já embutidos no cadastro do produto (seção 20 — o manual não separa "produto" de "estoque").
- `POST /api/v1/produtos/:id/movimentar` — toda entrada/saída fica auditada em `estoque_movimentos`, e o saldo **nunca fica negativo**: a linha do produto é travada (`SELECT ... FOR UPDATE`) durante a movimentação, então requisições concorrentes (duas vendas do mesmo item ao mesmo tempo) não corrompem o saldo. Testado disparando 20 saídas simultâneas contra um estoque de 15 — exatamente 15 tiveram sucesso, 5 foram rejeitadas, saldo final ficou em 0.
- Alerta de estoque baixo integrado ao dashboard (seção 94: "Seu produto Y está próximo de acabar").

**Deixado pra depois, de propósito** (mesma filosofia da seção 47 — não construir tudo de uma vez):
- Ordens de serviço formais com numeração própria e itens (`ordens_servico`, `ordem_servico_itens`) — hoje o MVP1 usa `agendamentos` pra isso, o que cobre o fluxo principal mas não a numeração/documento formal da seção 16.
- Log de cobranças enviadas via WhatsApp (`cobrancas`) — hoje a régua de cobrança (seção 19) ainda não tem um histórico próprio, só o estado da conta a receber.
- Lista de compras automática (seção 22) a partir de produtos com estoque baixo.

**O MVP1 está com o backend inteiro implementado.** O fluxo completo da
"regra de ouro" (seção 113) roda de ponta a ponta:

```
cliente → orçamento (com itens) → aprovação
        → cria agendamento + conta a receber automaticamente (seção 55)
        → agenda: iniciar → concluir
        → financeiro: registrar pagamento (baixa a conta, gera o registro em "pagamentos")
        → GET /financeiro/resumo alimenta o dashboard (seções 8 e 9)
```

## O que falta (de propósito — seção 47, o MVP1 não inclui isso ainda)

- 13. Dashboard — hoje é só o `GET /financeiro/resumo`; falta compor os
  alertas inteligentes (seção 9) num único endpoint ou no frontend real.
- 14–16. IA, voz e WhatsApp — Fase 2 do roadmap (seção 85), dependem de
  infraestrutura externa (API de LLM, WhatsApp Business) que não dá pra
  simular aqui.
- 17–18. Notificações e automações (motor de regras, seção 43) — Fase 4.
- Testes automatizados (`tests/`) — ainda não escritos; a seção 70 do
  manual pede unitários, integração, E2E e testes de segurança antes de ir
  para beta.

Fora do MVP1 (fases seguintes do roadmap, seção 85):
- WhatsApp, IA, voz → Fase 2/5
- Estoque, fornecedores, ordens de serviço completas → Fase 3
- Automações, relatórios avançados → Fase 4
- Pagamentos, emissão fiscal, assinaturas → Fase 7

## Como rodar o backend localmente

```bash
cd backend
cp .env.example .env        # ajuste DATABASE_URL e os JWT_*_SECRET
npm install

# aplique as migrações NESTA ordem:
psql "$DATABASE_URL_ADMIN" -f ../database/001_mvp1_schema.sql   # roda como um usuário com privilégio de criar role/tabela
psql "$DATABASE_URL_ADMIN" -f ../database/002_app_role.sql      # cria a role ginova_app (sem privilégio de superusuário)
psql "$DATABASE_URL_ADMIN" -f ../database/003_fix_rls_policies.sql
psql "$DATABASE_URL_ADMIN" -f ../database/004_whatsapp_ia_tables.sql
psql "$DATABASE_URL_ADMIN" -f ../database/005_estoque_fornecedores.sql

npm run dev
```

⚠️ **A aplicação (`DATABASE_URL` no `.env`) precisa se conectar como
`ginova_app`, nunca como um superusuário do Postgres** (`postgres`,
por exemplo). Superusuários ignoram Row Level Security por padrão —
os testes de integração pegaram exatamente esse erro (ver seção
"O que os testes já pegaram" abaixo).

## Como rodar os testes

Precisa de um PostgreSQL local com as 3 migrações já aplicadas (ver
acima) num banco chamado `ginova_test`.

```bash
cd backend
npm install
npm test
```

22 testes, todos de integração de verdade (sobem o Express com
`supertest` e batem num Postgres real — nada de mock de banco):

- `tests/auth.test.js` — registro, login, senha curta, e-mail duplicado, token inválido.
- `tests/clientes.test.js` — CRUD e, principalmente, **isolamento multi-tenant**: uma empresa não pode ler, listar nem editar clientes de outra, mesmo sabendo o ID exato.
- `tests/orcamentos.test.js` — o fluxo completo do manual (seção 113): orçamento com itens → aprovação → agendamento + conta a receber criados sozinhos → iniciar/concluir serviço.
- `tests/financeiro.test.js` — contas a pagar, e permissões granulares (seção 37): usuário sem a permissão recebe 403, não erro genérico.
- `tests/dashboard.test.js` — resumo numérico, geração dos alertas inteligentes (cobrança vencida, orçamento sem resposta) e isolamento multi-tenant do próprio dashboard.

`GET /api/v1/dashboard` é o endpoint que a tela "Início" do protótipo vai
consumir de verdade: resumo financeiro + agenda de hoje + a lista de
alertas (seção 9), tudo numa chamada só.

### O que os testes já pegaram (e por que isso importa)

Rodar contra um banco real — em vez de só ler o código — encontrou 2
problemas reais antes de qualquer usuário ver:

1. **RLS não aplicado de verdade**: o exemplo inicial usava a role
   `postgres` (superusuário) na conexão, que ignora Row Level Security
   por padrão no Postgres. As policies existiam e estavam corretas,
   mas nunca eram avaliadas. Corrigido criando a role restrita
   `ginova_app` (migração `002`).
2. **Policy quebrava com erro em vez de simplesmente negar acesso**:
   `current_setting('app.empresa_id', true)::uuid` falhava com "invalid
   input syntax for type uuid" quando uma conexão do pool era
   reaproveitada sem contexto de tenant configurado. Corrigido com
   `nullif(..., '')::uuid` (migração `003`), que faz o Postgres tratar
   esse caso como "nenhuma linha visível" em vez de erro.

Teste rápido do fluxo completo:

```bash
# 1. registra empresa + usuário admin
curl -X POST http://localhost:3000/api/v1/auth/registrar \
  -H "Content-Type: application/json" \
  -d '{"nomeEmpresa":"Elétrica JR","nomeUsuario":"João","email":"joao@exemplo.com","senha":"senha12345"}'
# guarde o accessToken da resposta em $TOKEN

# 2. cria um cliente
curl -X POST http://localhost:3000/api/v1/clientes \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"nome":"Maria Fernandes","whatsapp":"11999990000"}'
# guarde o id retornado em $CLIENTE_ID

# 3. cria um orçamento para esse cliente
curl -X POST http://localhost:3000/api/v1/orcamentos \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"clienteId\":\"$CLIENTE_ID\",\"itens\":[{\"descricao\":\"Manutenção preventiva\",\"valorUnit\":180}]}"
# guarde o id retornado em $ORCAMENTO_ID

# 4. aprova o orçamento — isso já cria o agendamento e a conta a receber
curl -X POST http://localhost:3000/api/v1/orcamentos/$ORCAMENTO_ID/aprovar \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"dataHora":"2026-08-25T14:00:00Z","vencimento":"2026-09-01"}'
# guarde o id do agendamento e o id da conta_receber retornados

# 5. no dia do serviço: inicia e conclui o agendamento
curl -X POST http://localhost:3000/api/v1/agenda/$AGENDAMENTO_ID/iniciar -H "Authorization: Bearer $TOKEN"
curl -X POST http://localhost:3000/api/v1/agenda/$AGENDAMENTO_ID/concluir -H "Authorization: Bearer $TOKEN"

# 6. registra o pagamento da conta a receber
curl -X POST http://localhost:3000/api/v1/financeiro/contas-receber/$CONTA_ID/pagar \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"metodo":"pix"}'

# 7. vê o resumo financeiro (o que alimenta o dashboard)
curl http://localhost:3000/api/v1/financeiro/resumo -H "Authorization: Bearer $TOKEN"
```

## Como ver o protótipo

Basta abrir `prototipo/ginova-prototipo.html` em qualquer navegador — não
precisa de backend rodando, os dados são fictícios (mock).
