// bg-files.js — Upload/download files to/from Supabase Storage (note images, msg files)

// ===== Upload note image to Supabase Storage =====
async function uploadNoteImage(base64Data, fileName, contentType) {
  try {
    // Convert base64 to binary
    const binaryStr = atob(base64Data);
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) {
      bytes[i] = binaryStr.charCodeAt(i);
    }

    const resp = await fetch(AUTH_SUPA_URL + "/storage/v1/object/note-images/" + fileName, {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + AUTH_SERVICE_KEY,
        "Content-Type": contentType || "image/png",
        "x-upsert": "true",
      },
      body: bytes.buffer,
    });

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error("Upload failed: " + resp.status + " " + err);
    }

    // Return public URL
    const publicUrl = AUTH_SUPA_URL + "/storage/v1/object/public/note-images/" + fileName;
    return { ok: true, url: publicUrl };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ===== Upload msg file to Supabase Storage =====
async function uploadMsgFile(base64Data, fileName, contentType) {
  try {
    const binaryStr = atob(base64Data);
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) {
      bytes[i] = binaryStr.charCodeAt(i);
    }

    const resp = await fetch(AUTH_SUPA_URL + "/storage/v1/object/msg-files/" + fileName, {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + AUTH_SERVICE_KEY,
        "Content-Type": contentType || "application/octet-stream",
        "x-upsert": "true",
      },
      body: bytes.buffer,
    });

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error("Upload failed: " + resp.status + " " + err);
    }

    const publicUrl = AUTH_SUPA_URL + "/storage/v1/object/public/msg-files/" + fileName;
    return { ok: true, url: publicUrl };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ===== Download msg file from Supabase (returns base64) =====
async function downloadMsgFile(url) {
  try {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error("Download failed: " + resp.status);
    const blob = await resp.blob();
    const buffer = await blob.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return { ok: true, base64: btoa(binary), mimeType: blob.type };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
