class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// Middleware final de tratamento de erros — resposta sempre no mesmo formato:
// { success: false, error: { code, message } }
function errorHandler(err, req, res, next) {
  if (err instanceof ApiError) {
    return res.status(err.status).json({
      success: false,
      error: { code: err.code, message: err.message },
    });
  }
  console.error(err); // log técnico completo fica só no servidor
  return res.status(500).json({
    success: false,
    error: { code: 'INTERNAL_ERROR', message: 'Ocorreu um erro inesperado.' },
  });
}

module.exports = { ApiError, errorHandler };
