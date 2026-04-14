// ===== Foto management routes =====
// Simple CRUD for group-avatar images stored in whatsapp-server/public/fotos/.
// Files are served publicly via the /static mount in index.js.
// Upload uses base64 JSON to avoid adding a multipart parser dependency.

const express = require("express");
const router = express.Router();
const fs = require("fs");
const path = require("path");

const FOTOS_DIR = path.resolve(__dirname, "../../public/fotos");
const ALLOWED_EXT = /\.(jpg|jpeg|png|webp|gif)$/i;
const MAX_BYTES = 10 * 1024 * 1024; // 10MB

function safeFilename(name) {
  // Strip path components and anything other than alnum, dot, dash, underscore.
  const base = String(name || "").split(/[\\/]/).pop();
  return base
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 120);
}

function ensureDir() {
  if (!fs.existsSync(FOTOS_DIR)) fs.mkdirSync(FOTOS_DIR, { recursive: true });
}

// GET /api/fotos — list all images in public/fotos
router.get("/", (req, res) => {
  try {
    ensureDir();
    const files = fs.readdirSync(FOTOS_DIR);
    const fotos = files
      .filter(f => ALLOWED_EXT.test(f))
      .map(f => {
        const p = path.join(FOTOS_DIR, f);
        const st = fs.statSync(p);
        return {
          name: f,
          size: st.size,
          modified: st.mtime.toISOString(),
          url: "/static/fotos/" + encodeURIComponent(f),
        };
      })
      .sort((a, b) => b.modified.localeCompare(a.modified));
    res.json({ ok: true, fotos });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/fotos/upload — body: { filename, base64, overwrite? }
router.post("/upload", (req, res) => {
  try {
    const { filename, base64, overwrite } = req.body || {};
    if (!filename || !base64) {
      return res.status(400).json({ error: "filename e base64 obrigatórios" });
    }
    const clean = safeFilename(filename);
    if (!ALLOWED_EXT.test(clean)) {
      return res.status(400).json({ error: "Formato inválido (use jpg, png, webp, gif)" });
    }
    const raw = String(base64).replace(/^data:[^;]+;base64,/, "");
    const buf = Buffer.from(raw, "base64");
    if (buf.length === 0) return res.status(400).json({ error: "Arquivo vazio" });
    if (buf.length > MAX_BYTES) {
      return res.status(400).json({ error: "Máximo 10MB (recebido " + buf.length + " bytes)" });
    }
    ensureDir();
    const dest = path.join(FOTOS_DIR, clean);
    if (fs.existsSync(dest) && !overwrite) {
      return res.status(409).json({ error: "Arquivo já existe", existing: clean });
    }
    fs.writeFileSync(dest, buf);
    res.json({
      ok: true,
      name: clean,
      size: buf.length,
      url: "/static/fotos/" + encodeURIComponent(clean),
    });
  } catch (e) {
    console.error("[FOTOS] upload error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/fotos/:filename
router.delete("/:filename", (req, res) => {
  try {
    const clean = safeFilename(req.params.filename);
    if (!ALLOWED_EXT.test(clean)) {
      return res.status(400).json({ error: "Nome inválido" });
    }
    const dest = path.join(FOTOS_DIR, clean);
    if (!fs.existsSync(dest)) return res.status(404).json({ error: "Foto não encontrada" });
    fs.unlinkSync(dest);
    res.json({ ok: true, deleted: clean });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
