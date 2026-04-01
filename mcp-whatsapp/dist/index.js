#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import pkg from "whatsapp-web.js";
const { Client, LocalAuth, MessageMedia } = pkg;
import * as qrcode from "qrcode-terminal";
import * as path from "path";
// ============================================================
// WhatsApp Client Setup
// ============================================================
const SESSION_DIR = path.join(process.env.APPDATA || process.env.HOME || ".", ".mcp-whatsapp-sessions");
let qrCodeData = null;
let clientReady = false;
let clientStatus = "initializing";
let whatsapp;
let initError = null;
function createClient() {
    return new Client({
        authStrategy: new LocalAuth({ dataPath: SESSION_DIR }),
        webVersionCache: {
            type: "remote",
            remotePath: "https://raw.githubusercontent.com/nicollaso/nicollaso.github.io/master/nicollaso/nicollaso/",
        },
        puppeteer: {
            headless: false,
            args: [
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--disable-dev-shm-usage",
                "--disable-gpu",
            ],
        },
    });
}
function setupClientEvents(client) {
    client.on("qr", (qr) => {
        qrCodeData = qr;
        clientStatus = "waiting_for_qr_scan";
        qrcode.generate(qr, { small: true }, (code) => {
            console.error("\n===== SCAN THIS QR CODE WITH WHATSAPP =====");
            console.error(code);
            console.error("============================================\n");
        });
    });
    client.on("ready", () => {
        clientReady = true;
        clientStatus = "connected";
        qrCodeData = null;
        initError = null;
        console.error("[WhatsApp] Client is ready!");
    });
    client.on("authenticated", () => {
        clientStatus = "authenticated";
        console.error("[WhatsApp] Authenticated successfully");
    });
    client.on("auth_failure", (msg) => {
        clientStatus = "auth_failed";
        console.error("[WhatsApp] Auth failure:", msg);
    });
    client.on("disconnected", (reason) => {
        clientReady = false;
        clientStatus = "disconnected";
        console.error("[WhatsApp] Disconnected:", reason);
    });
}
async function initializeWhatsApp() {
    clientStatus = "initializing";
    initError = null;
    try {
        whatsapp = createClient();
        setupClientEvents(whatsapp);
        await whatsapp.initialize();
        console.error("[WhatsApp] Initialize completed");
    }
    catch (err) {
        clientStatus = "error";
        initError = err.message || String(err);
        console.error("[WhatsApp] Init error:", initError);
    }
}
// Start initialization
initializeWhatsApp();
// ============================================================
// Helper Functions
// ============================================================
function ensureReady() {
    if (!whatsapp) {
        throw new Error("WhatsApp client not initialized. Use whatsapp_reconnect to start.");
    }
    if (!clientReady) {
        throw new Error(`WhatsApp not ready yet. Status: ${clientStatus}. ` +
            (clientStatus === "authenticated"
                ? "Authenticated but still loading chats. Wait a moment and try again."
                : qrCodeData
                    ? "Use whatsapp_get_qr tool to get the QR code."
                    : "Please wait for initialization."));
    }
}
function formatPhone(phone) {
    const cleaned = phone.replace(/\D/g, "");
    if (!cleaned.includes("@")) {
        return `${cleaned}@c.us`;
    }
    return cleaned;
}
// ============================================================
// MCP Server
// ============================================================
const server = new McpServer({
    name: "mcp-whatsapp",
    version: "1.0.0",
});
// ------ STATUS & AUTH ------
server.tool("whatsapp_get_status", "Get WhatsApp connection status", {}, async () => {
    return {
        content: [
            {
                type: "text",
                text: JSON.stringify({
                    status: clientStatus,
                    ready: clientReady,
                    hasQR: !!qrCodeData,
                    error: initError,
                }, null, 2),
            },
        ],
    };
});
server.tool("whatsapp_reconnect", "Reconnect WhatsApp client. Use force=true to force reconnection even if status shows connected.", {
    force: z.boolean().optional().default(false).describe("Force reconnection even if already connected"),
}, async ({ force }) => {
    if (clientReady && !force) {
        return {
            content: [{ type: "text", text: "Already connected! Use force=true to force reconnection." }],
        };
    }
    // Destroy existing client
    clientReady = false;
    clientStatus = "initializing";
    try {
        if (whatsapp) {
            await whatsapp.destroy().catch(() => { });
        }
    }
    catch { }
    // Wait for browser cleanup
    await new Promise((r) => setTimeout(r, 3000));
    await initializeWhatsApp();
    // Wait longer for auth + ready
    for (let i = 0; i < 12; i++) {
        if (clientReady)
            break;
        await new Promise((r) => setTimeout(r, 5000));
    }
    return {
        content: [
            {
                type: "text",
                text: JSON.stringify({
                    status: clientStatus,
                    ready: clientReady,
                    hasQR: !!qrCodeData,
                    error: initError,
                    message: clientReady
                        ? "Reconnected successfully!"
                        : qrCodeData
                            ? "QR code generated! Check server terminal to scan."
                            : "Initializing... try whatsapp_get_status in a few seconds.",
                }, null, 2),
            },
        ],
    };
});
server.tool("whatsapp_get_qr", "Get QR code string for WhatsApp Web authentication. The QR code is also printed in the server terminal.", {}, async () => {
    if (clientReady) {
        return {
            content: [
                { type: "text", text: "Already connected! No QR code needed." },
            ],
        };
    }
    if (!qrCodeData) {
        return {
            content: [
                {
                    type: "text",
                    text: "No QR code available yet. Wait a moment and try again.",
                },
            ],
        };
    }
    return {
        content: [
            {
                type: "text",
                text: `QR Code data: ${qrCodeData}\n\nScan this QR code with WhatsApp on your phone:\nWhatsApp > Settings > Linked Devices > Link a Device`,
            },
        ],
    };
});
// ------ MESSAGES ------
server.tool("whatsapp_send_message", "Send a text message to a WhatsApp contact or group", {
    to: z
        .string()
        .describe("Phone number with country code (e.g. 5511999999999) or group ID"),
    message: z.string().describe("Message text to send"),
}, async ({ to, message }) => {
    ensureReady();
    const chatId = to.includes("@") ? to : formatPhone(to);
    const msg = await whatsapp.sendMessage(chatId, message);
    return {
        content: [
            {
                type: "text",
                text: `Message sent successfully!\nTo: ${chatId}\nMessage ID: ${msg.id.id}\nTimestamp: ${new Date(msg.timestamp * 1000).toISOString()}`,
            },
        ],
    };
});
server.tool("whatsapp_send_image", "Send an image with optional caption to a WhatsApp contact or group", {
    to: z.string().describe("Phone number with country code or group ID"),
    imagePath: z.string().describe("Absolute path to the image file"),
    caption: z.string().optional().describe("Optional caption for the image"),
}, async ({ to, imagePath, caption }) => {
    ensureReady();
    const chatId = to.includes("@") ? to : formatPhone(to);
    const media = MessageMedia.fromFilePath(imagePath);
    const msg = await whatsapp.sendMessage(chatId, media, {
        caption: caption || "",
    });
    return {
        content: [
            {
                type: "text",
                text: `Image sent successfully!\nTo: ${chatId}\nMessage ID: ${msg.id.id}`,
            },
        ],
    };
});
server.tool("whatsapp_read_messages", "Read recent messages from a specific chat", {
    chatId: z
        .string()
        .describe("Phone number with country code (e.g. 5511999999999) or group ID (e.g. 120363xxxxx@g.us)"),
    limit: z
        .number()
        .optional()
        .default(20)
        .describe("Number of messages to fetch (default 20, max 100)"),
}, async ({ chatId, limit }) => {
    ensureReady();
    const id = chatId.includes("@") ? chatId : formatPhone(chatId);
    const chat = await whatsapp.getChatById(id);
    const messages = await chat.fetchMessages({ limit: Math.min(limit, 100) });
    const formatted = messages.map((msg) => ({
        id: msg.id.id,
        from: msg.from,
        fromName: msg.author || msg._data?.notifyName || "Unknown",
        body: msg.body,
        timestamp: new Date(msg.timestamp * 1000).toISOString(),
        type: msg.type,
        hasMedia: msg.hasMedia,
        isForwarded: msg.isForwarded,
    }));
    return {
        content: [
            {
                type: "text",
                text: JSON.stringify({
                    chat: chat.name,
                    messageCount: formatted.length,
                    messages: formatted,
                }, null, 2),
            },
        ],
    };
});
server.tool("whatsapp_search_messages", "Search messages across all chats or in a specific chat", {
    query: z.string().describe("Search term"),
    chatId: z
        .string()
        .optional()
        .describe("Optional: search only in this chat"),
    limit: z.number().optional().default(20).describe("Max results"),
}, async ({ query, chatId, limit }) => {
    ensureReady();
    let messages;
    if (chatId) {
        const id = chatId.includes("@") ? chatId : formatPhone(chatId);
        const chat = await whatsapp.getChatById(id);
        messages = await chat.fetchMessages({ limit: 500 });
        messages = messages.filter((m) => m.body && m.body.toLowerCase().includes(query.toLowerCase()));
    }
    else {
        messages = await whatsapp.searchMessages(query, { limit });
    }
    const formatted = messages.slice(0, limit).map((msg) => ({
        id: msg.id.id,
        chatName: msg._data?.notifyName || msg.from,
        from: msg.from,
        body: msg.body,
        timestamp: new Date(msg.timestamp * 1000).toISOString(),
    }));
    return {
        content: [
            {
                type: "text",
                text: JSON.stringify({ query, resultCount: formatted.length, results: formatted }, null, 2),
            },
        ],
    };
});
server.tool("whatsapp_get_chats", "List all WhatsApp chats (conversations)", {
    limit: z.number().optional().default(50).describe("Max chats to return"),
    unreadOnly: z
        .boolean()
        .optional()
        .default(false)
        .describe("Only show chats with unread messages"),
}, async ({ limit, unreadOnly }) => {
    ensureReady();
    let chats = await whatsapp.getChats();
    if (unreadOnly) {
        chats = chats.filter((c) => c.unreadCount > 0);
    }
    const formatted = chats.slice(0, limit).map((chat) => ({
        id: chat.id._serialized,
        name: chat.name,
        isGroup: chat.isGroup,
        unreadCount: chat.unreadCount,
        lastMessage: chat.lastMessage?.body?.substring(0, 100) || "",
        timestamp: chat.timestamp
            ? new Date(chat.timestamp * 1000).toISOString()
            : null,
        pinned: chat.pinned,
        archived: chat.archived,
        muted: chat.isMuted,
    }));
    return {
        content: [
            {
                type: "text",
                text: JSON.stringify({ totalChats: chats.length, chats: formatted }, null, 2),
            },
        ],
    };
});
// ------ CONTACTS ------
server.tool("whatsapp_get_contacts", "List all WhatsApp contacts", {
    limit: z.number().optional().default(100).describe("Max contacts"),
    search: z
        .string()
        .optional()
        .describe("Filter contacts by name or number"),
}, async ({ limit, search }) => {
    ensureReady();
    let contacts = await whatsapp.getContacts();
    // Filter out non-user contacts
    contacts = contacts.filter((c) => c.isUser && c.id._serialized !== "status@broadcast");
    if (search) {
        const q = search.toLowerCase();
        contacts = contacts.filter((c) => (c.name && c.name.toLowerCase().includes(q)) ||
            (c.pushname && c.pushname.toLowerCase().includes(q)) ||
            c.id._serialized.includes(q));
    }
    const formatted = contacts.slice(0, limit).map((c) => ({
        id: c.id._serialized,
        name: c.name || null,
        pushname: c.pushname || null,
        number: c.number,
        isMyContact: c.isMyContact,
        isBusiness: c.isBusiness,
    }));
    return {
        content: [
            {
                type: "text",
                text: JSON.stringify({ totalContacts: contacts.length, contacts: formatted }, null, 2),
            },
        ],
    };
});
server.tool("whatsapp_get_contact_info", "Get detailed info about a specific contact", {
    contactId: z.string().describe("Phone number or contact ID"),
}, async ({ contactId }) => {
    ensureReady();
    const id = contactId.includes("@") ? contactId : formatPhone(contactId);
    const contact = await whatsapp.getContactById(id);
    const info = {
        id: contact.id._serialized,
        name: contact.name,
        pushname: contact.pushname,
        number: contact.number,
        isMyContact: contact.isMyContact,
        isBusiness: contact.isBusiness,
        isBlocked: contact.isBlocked,
    };
    // Try to get profile pic
    try {
        info.profilePicUrl = await contact.getProfilePicUrl();
    }
    catch {
        info.profilePicUrl = null;
    }
    // Try to get about/status
    try {
        info.about = await contact.getAbout();
    }
    catch {
        info.about = null;
    }
    return {
        content: [{ type: "text", text: JSON.stringify(info, null, 2) }],
    };
});
// ------ GROUPS ------
server.tool("whatsapp_get_groups", "List all WhatsApp groups", {
    limit: z.number().optional().default(50).describe("Max groups to return"),
}, async ({ limit }) => {
    ensureReady();
    const chats = await whatsapp.getChats();
    const groups = chats.filter((c) => c.isGroup);
    const formatted = groups.slice(0, limit).map((g) => ({
        id: g.id._serialized,
        name: g.name,
        participantCount: g.groupMetadata?.participants?.length || 0,
        unreadCount: g.unreadCount,
        description: g.groupMetadata?.desc || "",
    }));
    return {
        content: [
            {
                type: "text",
                text: JSON.stringify({ totalGroups: groups.length, groups: formatted }, null, 2),
            },
        ],
    };
});
server.tool("whatsapp_get_group_info", "Get detailed information about a WhatsApp group", {
    groupId: z
        .string()
        .describe("Group ID (e.g. 120363xxxxx@g.us)"),
}, async ({ groupId }) => {
    ensureReady();
    const chat = await whatsapp.getChatById(groupId);
    if (!chat.isGroup) {
        throw new Error("This is not a group chat");
    }
    const groupChat = chat;
    const participants = groupChat.groupMetadata?.participants || [];
    const info = {
        id: groupChat.id._serialized,
        name: groupChat.name,
        description: groupChat.groupMetadata?.desc || "",
        createdAt: groupChat.groupMetadata?.creation
            ? new Date(groupChat.groupMetadata.creation * 1000).toISOString()
            : null,
        owner: groupChat.groupMetadata?.owner?._serialized || null,
        participantCount: participants.length,
        participants: participants.map((p) => ({
            id: p.id._serialized,
            isAdmin: p.isAdmin,
            isSuperAdmin: p.isSuperAdmin,
        })),
    };
    return {
        content: [{ type: "text", text: JSON.stringify(info, null, 2) }],
    };
});
server.tool("whatsapp_set_group_subject", "Change the name/subject of a WhatsApp group (requires admin)", {
    groupId: z.string().describe("Group ID"),
    subject: z.string().describe("New group name/subject"),
}, async ({ groupId, subject }) => {
    ensureReady();
    const chat = await whatsapp.getChatById(groupId);
    if (!chat.isGroup)
        throw new Error("Not a group chat");
    await chat.setSubject(subject);
    return {
        content: [
            {
                type: "text",
                text: `Group subject changed to: "${subject}"`,
            },
        ],
    };
});
server.tool("whatsapp_set_group_description", "Change the description of a WhatsApp group (requires admin)", {
    groupId: z.string().describe("Group ID"),
    description: z.string().describe("New group description"),
}, async ({ groupId, description }) => {
    ensureReady();
    const chat = await whatsapp.getChatById(groupId);
    if (!chat.isGroup)
        throw new Error("Not a group chat");
    await chat.setDescription(description);
    return {
        content: [
            {
                type: "text",
                text: `Group description updated successfully.`,
            },
        ],
    };
});
// ------ LABELS (WhatsApp Business) ------
server.tool("whatsapp_get_labels", "List all WhatsApp labels/tags (WhatsApp Business feature)", {}, async () => {
    ensureReady();
    try {
        const labels = await whatsapp.getLabels();
        const formatted = labels.map((l) => ({
            id: l.id,
            name: l.name,
            color: l.hexColor,
            count: l.count || 0,
        }));
        return {
            content: [
                { type: "text", text: JSON.stringify({ labels: formatted }, null, 2) },
            ],
        };
    }
    catch {
        return {
            content: [
                {
                    type: "text",
                    text: "Labels are only available on WhatsApp Business accounts. Your account may not support this feature.",
                },
            ],
        };
    }
});
server.tool("whatsapp_add_label_to_chat", "Add a label to a chat (WhatsApp Business feature)", {
    chatId: z.string().describe("Chat ID or phone number"),
    labelId: z.string().describe("Label ID (use whatsapp_get_labels to see available labels)"),
}, async ({ chatId, labelId }) => {
    ensureReady();
    try {
        const id = chatId.includes("@") ? chatId : formatPhone(chatId);
        const chat = await whatsapp.getChatById(id);
        await chat.addLabel(labelId);
        return {
            content: [
                { type: "text", text: `Label ${labelId} added to chat ${chat.name}` },
            ],
        };
    }
    catch (err) {
        return {
            content: [
                {
                    type: "text",
                    text: `Failed to add label: ${err.message}. Labels are a WhatsApp Business feature.`,
                },
            ],
        };
    }
});
// ------ CHAT ACTIONS ------
server.tool("whatsapp_mark_as_read", "Mark all messages in a chat as read", {
    chatId: z.string().describe("Chat ID or phone number"),
}, async ({ chatId }) => {
    ensureReady();
    const id = chatId.includes("@") ? chatId : formatPhone(chatId);
    const chat = await whatsapp.getChatById(id);
    await chat.sendSeen();
    return {
        content: [
            { type: "text", text: `Chat "${chat.name}" marked as read.` },
        ],
    };
});
server.tool("whatsapp_archive_chat", "Archive or unarchive a chat", {
    chatId: z.string().describe("Chat ID or phone number"),
    archive: z.boolean().default(true).describe("true to archive, false to unarchive"),
}, async ({ chatId, archive }) => {
    ensureReady();
    const id = chatId.includes("@") ? chatId : formatPhone(chatId);
    const chat = await whatsapp.getChatById(id);
    if (archive) {
        await chat.archive();
    }
    else {
        await chat.unarchive();
    }
    return {
        content: [
            {
                type: "text",
                text: `Chat "${chat.name}" ${archive ? "archived" : "unarchived"}.`,
            },
        ],
    };
});
server.tool("whatsapp_pin_chat", "Pin or unpin a chat", {
    chatId: z.string().describe("Chat ID or phone number"),
    pin: z.boolean().default(true).describe("true to pin, false to unpin"),
}, async ({ chatId, pin }) => {
    ensureReady();
    const id = chatId.includes("@") ? chatId : formatPhone(chatId);
    const chat = await whatsapp.getChatById(id);
    if (pin) {
        await chat.pin();
    }
    else {
        await chat.unpin();
    }
    return {
        content: [
            {
                type: "text",
                text: `Chat "${chat.name}" ${pin ? "pinned" : "unpinned"}.`,
            },
        ],
    };
});
server.tool("whatsapp_mute_chat", "Mute or unmute a chat", {
    chatId: z.string().describe("Chat ID or phone number"),
    mute: z.boolean().default(true).describe("true to mute, false to unmute"),
    duration: z
        .number()
        .optional()
        .describe("Mute duration in seconds (default: 8 hours)"),
}, async ({ chatId, mute, duration }) => {
    ensureReady();
    const id = chatId.includes("@") ? chatId : formatPhone(chatId);
    const chat = await whatsapp.getChatById(id);
    if (mute) {
        const unmuteDate = new Date(Date.now() + (duration || 28800) * 1000);
        await chat.mute(unmuteDate);
    }
    else {
        await chat.unmute();
    }
    return {
        content: [
            {
                type: "text",
                text: `Chat "${chat.name}" ${mute ? "muted" : "unmuted"}.`,
            },
        ],
    };
});
// ============================================================
// Start Server
// ============================================================
async function main() {
    console.error("[MCP WhatsApp] Starting server...");
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("[MCP WhatsApp] Server connected via stdio");
}
main().catch((err) => {
    console.error("[MCP WhatsApp] Fatal error:", err);
    process.exit(1);
});
//# sourceMappingURL=index.js.map