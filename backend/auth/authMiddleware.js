const jwt = require('jsonwebtoken');
const { ApiError } = require('../common/apiError');

/**
 * Toda rota protegida passa por aqui antes de tocar em qualquer regra de
 * negócio. É o único lugar que decide "quem é você e em qual empresa
 * você está operando agora" — nunca confiar em empresa_id vindo do
 * corpo da requisição ou da URL (seção 33).
 */
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return next(new ApiError(401, 'UNAUTHENTICATED', 'Token de acesso ausente.'));
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_ACCESS_SECRET);
    req.auth = {
      usuarioId: payload.sub,
      empresaId: payload.empresaId,
      perfil: payload.perfil,
      permissoes: payload.permissoes || [],
    };
    return next();
  } catch (err) {
    return next(new ApiError(401, 'INVALID_TOKEN', 'Token de acesso inválido ou expirado.'));
  }
}

/**
 * Checagem de permissão granular (seção 37) — não depender só do perfil.
 * Uso: requirePermission('cliente.criar')
 */
function requirePermission(permission) {
  return (req, res, next) => {
    if (!req.auth?.permissoes?.includes(permission)) {
      return next(new ApiError(403, 'FORBIDDEN', `Você não tem a permissão "${permission}".`));
    }
    return next();
  };
}

module.exports = { requireAuth, requirePermission };
