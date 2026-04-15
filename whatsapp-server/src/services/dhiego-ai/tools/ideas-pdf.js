// ===== DHIEGO.AI — Ideas PDF report =====
// Generates a one-page-ish PDF of the user's ideas backlog using pdfkit.
// Returns a Buffer that dhiego-ai.js then sends via sock.sendMessage as
// a document attachment.

const PDFDocument = require("pdfkit");
const { supaRest } = require("../../supabase");

async function buildIdeasPdfBuffer({ userId, status = "all" }) {
  const statusFilter = status && status !== "all" ? "&status=eq." + encodeURIComponent(status) : "";
  const rows = await supaRest(
    "/rest/v1/dhiego_ideas?user_id=eq." + encodeURIComponent(userId) +
    statusFilter +
    "&order=status.asc,id.desc&limit=500" +
    "&select=id,text,status,source,created_at,completed_at"
  ).catch(() => []);

  return await new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 48 });
    const chunks = [];
    doc.on("data", chunk => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    // Header
    doc.fontSize(22).fillColor("#1a2030").text("DHIEGO.AI — Backlog de ideias", { align: "left" });
    doc.moveDown(0.3);
    doc.fontSize(11).fillColor("#666666").text(
      "Gerado em " + new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }),
      { align: "left" }
    );
    doc.moveDown(0.3);

    const open = rows.filter(r => r.status === "open").length;
    const done = rows.filter(r => r.status === "done").length;
    const cancelled = rows.filter(r => r.status === "cancelled").length;
    doc.fontSize(11).fillColor("#333333").text(
      "Abertas: " + open + "  |  Concluídas: " + done + "  |  Canceladas: " + cancelled + "  |  Total: " + rows.length
    );
    doc.moveDown(1);

    if (!rows.length) {
      doc.fontSize(13).fillColor("#888").text("(nenhuma ideia registrada ainda)", { align: "center" });
    } else {
      const drawSection = (title, color, items) => {
        if (!items.length) return;
        doc.moveDown(0.5);
        doc.fontSize(14).fillColor(color).text(title);
        doc.moveDown(0.3);
        doc.fontSize(11).fillColor("#222");
        items.forEach(r => {
          const date = r.created_at ? new Date(r.created_at).toLocaleDateString("pt-BR") : "";
          doc.font("Helvetica-Bold").text("#" + r.id + "  ", { continued: true });
          doc.font("Helvetica").text(r.text, { continued: false });
          if (date) {
            doc.fontSize(9).fillColor("#888").text("    " + date + (r.source ? "  ·  " + r.source : ""));
            doc.fontSize(11).fillColor("#222");
          }
          doc.moveDown(0.3);
        });
      };

      drawSection("⏳ Abertas", "#6366f1", rows.filter(r => r.status === "open"));
      drawSection("✅ Concluídas", "#22c55e", rows.filter(r => r.status === "done"));
      drawSection("❌ Canceladas", "#ef4444", rows.filter(r => r.status === "cancelled"));
    }

    doc.end();
  });
}

async function generateIdeasPdf({ userId, status }) {
  const buffer = await buildIdeasPdfBuffer({ userId, status });
  const filename = "backlog_ideias_" + new Date().toISOString().slice(0, 10) + ".pdf";
  return { buffer, filename };
}

module.exports = { generateIdeasPdf };
