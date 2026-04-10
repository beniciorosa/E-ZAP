// ===== Admin token authentication middleware =====
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Token de autenticação necessário" });
  }
  const token = authHeader.split(" ")[1];
  if (token !== ADMIN_TOKEN) {
    return res.status(403).json({ error: "Token inválido" });
  }
  next();
}

module.exports = { requireAuth };
