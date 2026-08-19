-- =====================================================================
-- GInova — Migração 005 — Estoque e fornecedores (Fase 3 do roadmap, seção 85)
--
-- Escopo desta migração: fornecedores, produtos (que já carregam o
-- estoque atual/mínimo — seção 20 do manual não separa "produto" de
-- "estoque", trata como os mesmos campos de um único cadastro) e o
-- histórico de movimentações (seção 21).
--
-- Deixado para depois, de propósito (mesma filosofia da seção 47 — não
-- fazer tudo de uma vez): ordens de serviço formais com numeração e
-- itens próprios (hoje cobertas pelos agendamentos do MVP1) e o log de
-- cobranças enviadas via WhatsApp.
-- =====================================================================

create table fornecedores (
  id            uuid primary key default gen_random_uuid(),
  empresa_id    uuid not null references empresas(id),
  nome          text not null,
  telefone      text,
  whatsapp      text,
  email         text,
  observacoes   text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  created_by    uuid,
  updated_by    uuid
);
create index ix_fornecedores_empresa on fornecedores (empresa_id) where deleted_at is null;
create trigger trg_fornecedores_updated_at before update on fornecedores
  for each row execute function set_updated_at();

create table produtos (
  id              uuid primary key default gen_random_uuid(),
  empresa_id      uuid not null references empresas(id),
  fornecedor_id   uuid references fornecedores(id),
  codigo          text,
  nome            text not null,
  categoria       text,
  unidade         text not null default 'un',   -- un, m, kg, l...
  estoque_atual   integer not null default 0,
  estoque_minimo  integer not null default 0,
  custo           numeric(12,2) not null default 0,
  preco           numeric(12,2) not null default 0,
  ativo           boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz,
  created_by      uuid,
  updated_by      uuid
);
create index ix_produtos_empresa on produtos (empresa_id) where deleted_at is null;
create unique index uq_produtos_codigo on produtos (empresa_id, codigo) where deleted_at is null and codigo is not null;
create trigger trg_produtos_updated_at before update on produtos
  for each row execute function set_updated_at();

create table estoque_movimentos (
  id            uuid primary key default gen_random_uuid(),
  empresa_id    uuid not null references empresas(id),
  produto_id    uuid not null references produtos(id),
  tipo          text not null check (tipo in ('entrada','saida','ajuste')),
  quantidade    integer not null check (quantidade > 0),
  estoque_apos  integer not null,               -- snapshot do saldo logo após o movimento (auditoria)
  motivo        text,                             -- ex: "venda", "compra", "ajuste manual", "orçamento #125"
  referencia_id uuid,                             -- id livre pra apontar pra outra tabela (orçamento, compra...) sem FK rígida
  created_at    timestamptz not null default now(),
  created_by    uuid
);
create index ix_estoque_movimentos_produto on estoque_movimentos (produto_id, created_at);

alter table fornecedores      enable row level security;
alter table produtos          enable row level security;
alter table estoque_movimentos enable row level security;

create policy tenant_isolation_fornecedores on fornecedores
  using (empresa_id = nullif(current_setting('app.empresa_id', true), '')::uuid);
create policy tenant_isolation_produtos on produtos
  using (empresa_id = nullif(current_setting('app.empresa_id', true), '')::uuid);
create policy tenant_isolation_estoque_movimentos on estoque_movimentos
  using (empresa_id = nullif(current_setting('app.empresa_id', true), '')::uuid);

grant select, insert, update, delete on fornecedores, produtos, estoque_movimentos to ginova_app;
