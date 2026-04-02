// ===== E-ZAP — Script para envio de email com token =====
// Deploy como Web App: Execute as → tools@grupoescalada.com.br | Who has access → Anyone

// URL publica do ZIP no Supabase Storage (atualizado automaticamente via GitHub Action)
var ZIP_DOWNLOAD_URL = "https://xsqpqdjffjqxdcmoytfc.supabase.co/storage/v1/object/public/releases/ezap-latest.zip";

function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);
    var nome = data.nome || "";
    var email = data.email || "";
    var token = data.token || "";

    if (!email || !token) {
      return ContentService.createTextOutput(JSON.stringify({ ok: false, error: "Email e token obrigatorios" }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    var html = buildEmailHtml(nome, token);

    GmailApp.sendEmail(email, "E-ZAP — Seu acesso foi criado!", "", {
      htmlBody: html,
      name: "E-ZAP | Grupo Escalada",
    });

    return ContentService.createTextOutput(JSON.stringify({ ok: true }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function buildEmailHtml(nome, token) {
  var firstName = nome.split(" ")[0] || "Usuario";

  return '<!DOCTYPE html>' +
  '<html><head><meta charset="utf-8"></head>' +
  '<body style="margin:0;padding:0;background:#f0f2f5;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif">' +
  '<div style="max-width:600px;margin:0 auto;padding:24px">' +

    // Header
    '<div style="background:#111b21;border-radius:16px 16px 0 0;padding:32px 24px;text-align:center">' +
      '<div style="width:64px;height:64px;border-radius:50%;background:#25d366;margin:0 auto 16px;display:flex;align-items:center;justify-content:center">' +
        '<span style="font-size:28px;color:#fff">&#9889;</span>' +
      '</div>' +
      '<h1 style="margin:0;font-size:28px;font-weight:700;color:#e9edef;letter-spacing:-0.5px">E-ZAP</h1>' +
      '<p style="margin:6px 0 0;font-size:14px;color:#8696a0">Gestao inteligente para WhatsApp</p>' +
    '</div>' +

    // Body
    '<div style="background:#ffffff;padding:32px 24px;border-left:1px solid #e0e0e0;border-right:1px solid #e0e0e0">' +
      '<h2 style="margin:0 0 8px;font-size:20px;color:#111b21">Ola, ' + firstName + '!</h2>' +
      '<p style="margin:0 0 24px;font-size:15px;color:#3b4a54;line-height:1.6">Seu acesso ao <strong>E-ZAP</strong> foi criado com sucesso. Use o token abaixo para ativar a extensao no seu navegador.</p>' +

      // Token box
      '<div style="background:#111b21;border-radius:12px;padding:20px;text-align:center;margin-bottom:24px">' +
        '<div style="font-size:11px;text-transform:uppercase;letter-spacing:2px;color:#8696a0;margin-bottom:8px;font-weight:600">SEU TOKEN DE ACESSO</div>' +
        '<div style="font-size:24px;font-weight:700;color:#25d366;letter-spacing:2px;font-family:monospace">' + token + '</div>' +
      '</div>' +

      // Divider
      '<div style="height:1px;background:#e0e0e0;margin:24px 0"></div>' +

      // Installation steps
      '<h3 style="margin:0 0 16px;font-size:16px;color:#111b21">Como instalar</h3>' +

      // Step 1 — Download
      '<div style="display:flex;gap:12px;margin-bottom:16px;align-items:flex-start">' +
        '<div style="min-width:28px;width:28px;height:28px;border-radius:50%;background:#25d366;color:#fff;font-size:14px;font-weight:700;text-align:center;line-height:28px">1</div>' +
        '<div>' +
          '<p style="margin:0;font-size:14px;color:#111b21;font-weight:600">Baixe a extensao</p>' +
          '<p style="margin:4px 0 8px;font-size:13px;color:#3b4a54;line-height:1.5">Clique no botao abaixo para baixar o arquivo ZIP. Depois, <strong>extraia o conteudo</strong> (clique com botao direito no arquivo e selecione "Extrair tudo").</p>' +
          '<a href="' + ZIP_DOWNLOAD_URL + '" style="display:inline-block;background:#25d366;color:#fff;text-decoration:none;padding:10px 24px;border-radius:8px;font-size:14px;font-weight:600">Baixar E-ZAP</a>' +
        '</div>' +
      '</div>' +

      // Step 2
      '<div style="display:flex;gap:12px;margin-bottom:16px;align-items:flex-start">' +
        '<div style="min-width:28px;width:28px;height:28px;border-radius:50%;background:#25d366;color:#fff;font-size:14px;font-weight:700;text-align:center;line-height:28px">2</div>' +
        '<div>' +
          '<p style="margin:0;font-size:14px;color:#111b21;font-weight:600">Abra o Chrome</p>' +
          '<p style="margin:4px 0 0;font-size:13px;color:#3b4a54;line-height:1.5">Na barra de endereco, digite <strong style="background:#f0f2f5;padding:2px 8px;border-radius:4px;font-family:monospace">chrome://extensions</strong> e pressione Enter.</p>' +
        '</div>' +
      '</div>' +

      // Step 3
      '<div style="display:flex;gap:12px;margin-bottom:16px;align-items:flex-start">' +
        '<div style="min-width:28px;width:28px;height:28px;border-radius:50%;background:#25d366;color:#fff;font-size:14px;font-weight:700;text-align:center;line-height:28px">3</div>' +
        '<div>' +
          '<p style="margin:0;font-size:14px;color:#111b21;font-weight:600">Ative o Modo do Desenvolvedor</p>' +
          '<p style="margin:4px 0 0;font-size:13px;color:#3b4a54;line-height:1.5">No canto superior direito da pagina, ative o interruptor <strong>"Modo do desenvolvedor"</strong>.</p>' +
        '</div>' +
      '</div>' +

      // Step 4
      '<div style="display:flex;gap:12px;margin-bottom:16px;align-items:flex-start">' +
        '<div style="min-width:28px;width:28px;height:28px;border-radius:50%;background:#25d366;color:#fff;font-size:14px;font-weight:700;text-align:center;line-height:28px">4</div>' +
        '<div>' +
          '<p style="margin:0;font-size:14px;color:#111b21;font-weight:600">Carregue a extensao</p>' +
          '<p style="margin:4px 0 0;font-size:13px;color:#3b4a54;line-height:1.5">Clique em <strong>"Carregar sem compactacao"</strong> e selecione a pasta <strong>chrome-extension</strong> que voce extraiu do ZIP.</p>' +
        '</div>' +
      '</div>' +

      // Step 5
      '<div style="display:flex;gap:12px;margin-bottom:24px;align-items:flex-start">' +
        '<div style="min-width:28px;width:28px;height:28px;border-radius:50%;background:#25d366;color:#fff;font-size:14px;font-weight:700;text-align:center;line-height:28px">5</div>' +
        '<div>' +
          '<p style="margin:0;font-size:14px;color:#111b21;font-weight:600">Ative com seu token</p>' +
          '<p style="margin:4px 0 0;font-size:13px;color:#3b4a54;line-height:1.5">Abra o <strong>WhatsApp Web</strong> (<a href="https://web.whatsapp.com" style="color:#25d366">web.whatsapp.com</a>). A tela do E-ZAP aparecera pedindo o token. Cole o token acima e clique em <strong>Entrar</strong>.</p>' +
        '</div>' +
      '</div>' +

      // Warning box
      '<div style="background:#fff5f5;border:1px solid #ff6b6b40;border-radius:8px;padding:12px 16px;margin-bottom:8px">' +
        '<p style="margin:0;font-size:13px;color:#e03131;line-height:1.5"><strong>Importante:</strong> Seu token e pessoal e intransferivel. Nao compartilhe com outras pessoas. Ele esta vinculado ao seu dispositivo.</p>' +
      '</div>' +
    '</div>' +

    // Footer
    '<div style="background:#202c33;border-radius:0 0 16px 16px;padding:20px 24px;text-align:center">' +
      '<p style="margin:0;font-size:12px;color:#8696a0">Grupo Escalada - 2026 - Todos os direitos reservados</p>' +
      '<p style="margin:6px 0 0;font-size:11px;color:#3b4a54">Este e um email automatico. Em caso de duvidas, procure o administrador da sua equipe.</p>' +
    '</div>' +

  '</div>' +
  '</body></html>';
}

// Teste: enviar email de teste
function testSendEmail() {
  var e = {
    postData: {
      contents: JSON.stringify({
        nome: "Teste Usuario",
        email: "SEU_EMAIL_AQUI@grupoescalada.com.br",
        token: "WCRM-TEST-1234-5678"
      })
    }
  };
  var result = doPost(e);
  Logger.log(result.getContent());
}
