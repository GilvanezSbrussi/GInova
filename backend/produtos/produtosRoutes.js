const express = require('express');
const { z } = require('zod');
const { withTenant } = require('../common/db');
const { ApiError } = require('../common/apiError');
const { requireAuth, requirePermission } = require('../auth/authMiddleware');

const router = express.Router();
router.use(requireAuth);

const produtoSchema = z.object({
  fornecedorId: z.string().uuid().optional(),
  codigo: z.string().optional(),
  nome: z.string().min(2),
  categoria: z.string().optional(),
  unidade: z.string().min(1).default('un'),
  estoqueInicial: z.number().int().nonnegative().default(0),
  estoqueMinimo: z.number().int().nonnegative().default(0),
  custo: z.number().nonnegative().default(0),
  preco: z.number().nonnegative().default(0),
});

// GET /api/v1/produtos — catálogo, já com um campo "estoque_baixo" calculado
router.get('/', requirePermission('estoque.visualizar'), async (req, res, next) => {
  try {
    const data = await withTenant(req.auth.empresaId, async (client) => {
      const { rows } = await client.query(`
        select p.*, f.nome as fornecedor_nome,
               (p.estoque_atual <= p.estoque_minimo) as estoque_baixo
          from produtos p
          left join fornecedores f on f.id = p.fornecedor_id
         where p.deleted_at is null
         order by p.nome asc`);
      return rows;
    });
    return res.json({ success: true, data });
  } catch (err) {
    return next(err);
  }
});

router.get('/:id', requirePermission('estoque.visualizar'), async (req, res, next) => {
  try {
    const data = await withTenant(req.auth.empresaId, async (client) => {
      const produto = await client.query(
        `select * from produtos where id = $1 and deleted_at is null`, [req.params.id]
      );
      if (produto.rowCount === 0) throw new ApiError(404, 'PRODUCT_NOT_FOUND', 'Produto não encontrado.');
      const movimentos = await client.query(
        `select * from estoque_movimentos where produto_id = $1 order by created_at desc limit 30`,
        [req.params.id]
      );
      return { ...produto.rows[0], movimentos: movimentos.rows };
    });
    return res.json({ success: true, data });
  } catch (err) {
    return next(err);
  }
});

// POST /api/v1/produtos
router.post('/', requirePermission('estoque.movimentar'), async (req, res, next) => {
  const parsed = produtoSchema.safeParse(req.body);
  if (!parsed.success) return next(new ApiError(400, 'VALIDATION_ERROR', parsed.error.errors[0].message));
  const p = parsed.data;

  try {
    const data = await withTenant(req.auth.empresaId, async (client) => {
      if (p.fornecedorId) {
        const f = await client.query('select id from fornecedores where id = $1 and deleted_at is null', [p.fornecedorId]);
        if (f.rowCount === 0) throw new ApiError(404, 'SUPPLIER_NOT_FOUND', 'Fornecedor não encontrado.');
      }
      const { rows } = await client.query(
        `insert into produtos (empresa_id, fornecedor_id, codigo, nome, categoria, unidade, estoque_atual, estoque_minimo, custo, preco, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *`,
        [req.auth.empresaId, p.fornecedorId || null, p.codigo || null, p.nome, p.categoria || null,
         p.unidade, p.estoqueInicial, p.estoqueMinimo, p.custo, p.preco, req.auth.usuarioId]
      );

      if (p.estoqueInicial > 0) {
        await client.query(
          `insert into estoque_movimentos (empresa_id, produto_id, tipo, quantidade, estoque_apos, motivo, created_by)
           values ($1,$2,'entrada',$3,$3,'Estoque inicial no cadastro',$4)`,
          [req.auth.empresaId, rows[0].id, p.estoqueInicial, req.auth.usuarioId]
        );
      }
      return rows[0];
    });
    return res.status(201).json({ success: true, data });
  } catch (err) {
    if (err.code === '23505') return next(new ApiError(409, 'CODIGO_EM_USO', 'Já existe um produto com este código.'));
    return next(err);
  }
});

router.patch('/:id', requirePermission('estoque.movimentar'), async (req, res, next) => {
  // edição de cadastro (nome, preço, custo, mínimo...) — NÃO mexe no saldo de estoque;
  // pra isso existe o endpoint de movimentação abaixo, que sempre fica auditado.
  const editavelSchema = produtoSchema.omit({ estoqueInicial: true }).partial();
  const parsed = editavelSchema.safeParse(req.body);
  if (!parsed.success) return next(new ApiError(400, 'VALIDATION_ERROR', parsed.error.errors[0].message));
  const map = { fornecedorId: 'fornecedor_id', estoqueMinimo: 'estoque_minimo' };
  const entries = Object.entries(parsed.data);
  if (entries.length === 0) return next(new ApiError(400, 'VALIDATION_ERROR', 'Nenhum campo para atualizar.'));

  const setClauses = [];
  const values = [];
  let i = 1;
  for (const [key, value] of entries) {
    setClauses.push(`${map[key] || key} = $${i++}`);
    values.push(value);
  }
  setClauses.push(`updated_by = $${i++}`);
  values.push(req.auth.usuarioId);
  values.push(req.params.id);

  try {
    const data = await withTenant(req.auth.empresaId, async (client) => {
      const { rows } = await client.query(
        `update produtos set ${setClauses.join(', ')} where id = $${i} and deleted_at is null returning *`,
        values
      );
      if (rows.length === 0) throw new ApiError(404, 'PRODUCT_NOT_FOUND', 'Produto não encontrado.');
      return rows[0];
    });
    return res.json({ success: true, data });
  } catch (err) {
    return next(err);
  }
});

// -----------------------------------------------------------------------
// POST /api/v1/produtos/:id/movimentar — o coração do módulo (seção 21)
// -----------------------------------------------------------------------
const movimentarSchema = z.object({
  tipo: z.enum(['entrada', 'saida', 'ajuste']),
  quantidade: z.number().int().positive(),
  motivo: z.string().optional(),
  referenciaId: z.string().uuid().optional(),
});

router.post('/:id/movimentar', requirePermission('estoque.movimentar'), async (req, res, next) => {
  const parsed = movimentarSchema.safeParse(req.body);
  if (!parsed.success) return next(new ApiError(400, 'VALIDATION_ERROR', parsed.error.errors[0].message));
  const { tipo, quantidade, motivo, referenciaId } = parsed.data;

  try {
    const data = await withTenant(req.auth.empresaId, async (client) => {
      // lock da linha do produto pra evitar duas movimentações concorrentes
      // corromperem o saldo (ex: duas vendas simultâneas do mesmo item)
      const produto = await client.query(
        `select * from produtos where id = $1 and deleted_at is null for update`,
        [req.params.id]
      );
      if (produto.rowCount === 0) throw new ApiError(404, 'PRODUCT_NOT_FOUND', 'Produto não encontrado.');

      const delta = tipo === 'saida' ? -quantidade : quantidade;
      const novoSaldo = produto.rows[0].estoque_atual + delta;
      if (novoSaldo < 0) {
        throw new ApiError(
          409, 'ESTOQUE_INSUFICIENTE',
          `Estoque insuficiente: saldo atual é ${produto.rows[0].estoque_atual}, tentando remover ${quantidade}.`
        );
      }

      await client.query(`update produtos set estoque_atual = $1, updated_by = $2 where id = $3`, [
        novoSaldo, req.auth.usuarioId, req.params.id,
      ]);

      const movimento = await client.query(
        `insert into estoque_movimentos (empresa_id, produto_id, tipo, quantidade, estoque_apos, motivo, referencia_id, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
        [req.auth.empresaId, req.params.id, tipo, quantidade, novoSaldo, motivo || null, referenciaId || null, req.auth.usuarioId]
      );

      return {
        produto_id: req.params.id,
        estoque_anterior: produto.rows[0].estoque_atual,
        estoque_atual: novoSaldo,
        estoque_minimo: produto.rows[0].estoque_minimo,
        estoque_baixo: novoSaldo <= produto.rows[0].estoque_minimo,
        movimento: movimento.rows[0],
      };
    });
    return res.json({ success: true, data });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
