-- =====================================================================
-- GInova — Correção das policies de RLS
--
-- BUG ENCONTRADO PELOS TESTES (backend/tests/clientes.test.js):
-- current_setting('app.empresa_id', true)::uuid falhava com
-- "invalid input syntax for type uuid" em vez de simplesmente não
-- retornar linhas, sempre que uma conexão do pool era reaproveitada sem
-- que withTenant() tivesse rodado antes (o Postgres cria a variável de
-- sessão custom na primeira vez que ela é referenciada e a deixa como
-- string vazia '' depois que o escopo LOCAL termina — não como NULL).
--
-- Isso não vazava dados (a query falhava, não retornava linhas de
-- outra empresa), mas quebrava a aplicação de forma feia e imprevisível
-- em vez de simplesmente negar acesso. nullif(..., '') resolve: string
-- vazia vira NULL antes do cast, e a comparação com NULL simplesmente
-- não bate com nenhuma linha.
-- =====================================================================

drop policy if exists tenant_isolation_clientes        on clientes;
drop policy if exists tenant_isolation_servicos         on servicos;
drop policy if exists tenant_isolation_orcamentos       on orcamentos;
drop policy if exists tenant_isolation_orcamento_itens  on orcamento_itens;
drop policy if exists tenant_isolation_agendamentos     on agendamentos;
drop policy if exists tenant_isolation_contas_receber   on contas_receber;
drop policy if exists tenant_isolation_contas_pagar     on contas_pagar;
drop policy if exists tenant_isolation_pagamentos       on pagamentos;

create policy tenant_isolation_clientes on clientes
  using (empresa_id = nullif(current_setting('app.empresa_id', true), '')::uuid);
create policy tenant_isolation_servicos on servicos
  using (empresa_id = nullif(current_setting('app.empresa_id', true), '')::uuid);
create policy tenant_isolation_orcamentos on orcamentos
  using (empresa_id = nullif(current_setting('app.empresa_id', true), '')::uuid);
create policy tenant_isolation_orcamento_itens on orcamento_itens
  using (empresa_id = nullif(current_setting('app.empresa_id', true), '')::uuid);
create policy tenant_isolation_agendamentos on agendamentos
  using (empresa_id = nullif(current_setting('app.empresa_id', true), '')::uuid);
create policy tenant_isolation_contas_receber on contas_receber
  using (empresa_id = nullif(current_setting('app.empresa_id', true), '')::uuid);
create policy tenant_isolation_contas_pagar on contas_pagar
  using (empresa_id = nullif(current_setting('app.empresa_id', true), '')::uuid);
create policy tenant_isolation_pagamentos on pagamentos
  using (empresa_id = nullif(current_setting('app.empresa_id', true), '')::uuid);
