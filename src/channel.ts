/**
 * Claw Sama Channel Plugin — standard ChannelPlugin interface.
 *
 * Makes the VRM avatar a first-class channel in OpenClaw, using the same
 * dispatchReply/deliver pattern as DingTalk, Synology Chat, etc.
 */

import { DEFAULT_ACCOUNT_ID, registerPluginHttpRoute } from "openclaw/plugin-sdk";
import type { AnyAgentTool } from "openclaw/plugin-sdk";
import { getClawSamaRuntime } from "./runtime.js";
import { broadcastToVrm, addSseClient, removeSseClient, type VrmBroadcastPayload } from "./sse.js";
import { stripThinking, stripActions, stripMarkdown, stripEmoji, splitSentences, VALID_EMOTIONS } from "./text-utils.js";
import { edgeTts, qwenTts, registerAudioFile, getAudioFile } from "./tts.js";
import { getPrefs, updatePrefs, setPrefs, EXT_DIR, workspaceRoot } from "./prefs.js";
import type { ClawSamaPrefs } from "./prefs.js";
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

const CHANNEL_ID = "claw-sama";
const CLAW_SESSION_KEY = "agent:main:main";
const GATEWAY_URL = "http://127.0.0.1:18789";

const MIME_TYPES: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".opus": "audio/opus",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".webm": "audio/webm",
};

export const CLAW_SAMA_SYSTEM_PROMPT = `\
You have a virtual VRM avatar displayed on the user's screen. Your reply text is automatically shown on the avatar.
To control the avatar's facial expression, use the "claw_sama_emotion" tool with an appropriate emotion.
Always call the tool BEFORE your text reply. Available emotions: ${VALID_EMOTIONS.join(", ")}.`;

// Pending emotion buffer — tool stores here, deliver callback flushes with text
let pendingEmotion: { emotion: string; intensity: number } | null = null;

// workspaceRoot imported from prefs.js

function waitUntilAbort(signal?: AbortSignal, onAbort?: () => void): Promise<void> {
  return new Promise((resolve) => {
    const complete = () => {
      onAbort?.();
      resolve();
    };
    if (!signal) return;
    if (signal.aborted) { complete(); return; }
    signal.addEventListener("abort", complete, { once: true });
  });
}

/**
 * Generate TTS for a text snippet and return an audio URL, or undefined.
 */
async function generateTtsUrl(text: string, log?: { warn: (msg: string) => void }): Promise<string | undefined> {
  const prefs = getPrefs();
  const ttsText = stripMarkdown(stripEmoji(text));
  if (!ttsText) return undefined;

  try {
    let result: { success: boolean; audioPath?: string; error?: string };
    if (prefs.provider === "qwen" && prefs.qwenKey) {
      result = await qwenTts({
        text: ttsText,
        apiKey: prefs.qwenKey,
        voice: prefs.voice,
        model: prefs.qwenModel,
        extDir: EXT_DIR,
      });
    } else {
      result = await edgeTts({ text: ttsText, voice: prefs.voice });
    }
    if (result.success && result.audioPath) {
      const audioId = registerAudioFile(result.audioPath);
      return `${GATEWAY_URL}/plugins/claw-sama/audio/${audioId}`;
    }
    log?.warn("claw-sama TTS failed: " + (result.error || "unknown error"));
  } catch (err) {
    log?.warn("claw-sama TTS error: " + String(err));
  }
  return undefined;
}

// Helper to read JSON body from request
async function readJsonBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString());
}

// CORS preflight helper
function handleCors(req: IncomingMessage, res: ServerResponse, methods: string): boolean {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": methods,
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
    return true;
  }
  return false;
}

function jsonResponse(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(body));
}

const activeRouteUnregisters = new Map<string, () => void>();

export function createClawSamaPlugin() {
  return {
    id: CHANNEL_ID,

    meta: {
      id: CHANNEL_ID,
      label: "Claw Sama",
      selectionLabel: "Claw Sama (VRM Avatar)",
      detailLabel: "Claw Sama VRM Desktop Pet",
      docsPath: "/channels/claw-sama",
      blurb: "Display agent messages on a VRM avatar with emotion expressions",
      order: 100,
    },

    capabilities: {
      chatTypes: ["direct" as const],
      blockStreaming: true,
      media: false,
      threads: false,
      reactions: false,
      edit: false,
      unsend: false,
      reply: false,
      effects: false,
    },

    streaming: {
      blockStreamingCoalesceDefaults: { minChars: 50, idleMs: 300 },
    },

    reload: { configPrefixes: [`channels.${CHANNEL_ID}`] },

    config: {
      listAccountIds: () => [DEFAULT_ACCOUNT_ID],
      resolveAccount: () => ({
        accountId: DEFAULT_ACCOUNT_ID,
        enabled: true,
      }),
      defaultAccountId: () => DEFAULT_ACCOUNT_ID,
      setAccountEnabled: ({ cfg, enabled }: any) => ({
        ...cfg,
        channels: {
          ...cfg?.channels,
          [CHANNEL_ID]: { ...cfg?.channels?.[CHANNEL_ID], enabled },
        },
      }),
    },

    outbound: {
      deliveryMode: "gateway" as const,
      textChunkLimit: 4000,

      sendText: async ({ to, text }: any) => {
        // Outbound messages from other channels or /send — broadcast to VRM
        const cleaned = stripActions(text.replace(/<think>[\s\S]*?<\/think>/g, "")).trim();
        if (cleaned) {
          broadcastToVrm({ text: cleaned });
          // Fire-and-forget TTS
          const sentences = splitSentences(cleaned);
          const total = sentences.length;
          sentences.forEach((sentence, index) => {
            generateTtsUrl(sentence).then((audioUrl) => {
              if (audioUrl) broadcastToVrm({ audioUrl, audioIndex: index, audioTotal: total });
            });
          });
        }
        return { channel: CHANNEL_ID, messageId: `cs-${Date.now()}`, chatId: to };
      },
    },

    gateway: {
      startAccount: async (ctx: any) => {
        const { log, cfg } = ctx;
        const channelRuntime = ctx.channelRuntime ?? getClawSamaRuntime().channel;

        log?.info?.("Starting Claw Sama channel");

        // ── Register HTTP routes via the plugin route system ──

        const routes: Array<{ path: string; key: string; unregister?: () => void }> = [];

        function registerRoute(
          routePath: string,
          handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
          opts?: { match?: "exact" | "prefix" },
        ) {
          const key = `${ctx.accountId}:${routePath}`;
          const prev = activeRouteUnregisters.get(key);
          if (prev) { prev(); activeRouteUnregisters.delete(key); }

          const unregister = registerPluginHttpRoute({
            path: routePath,
            auth: "plugin",
            replaceExisting: true,
            pluginId: CHANNEL_ID,
            accountId: ctx.accountId,
            match: opts?.match,
            log: (msg: string) => log?.info?.(msg),
            handler,
          });
          activeRouteUnregisters.set(key, unregister);
          routes.push({ path: routePath, key, unregister });
        }

        // ── SSE endpoint ──
        registerRoute("/plugins/claw-sama/events", (req, res) => {
          if (req.method !== "GET") { res.writeHead(405); res.end(); return; }
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            "Access-Control-Allow-Origin": "*",
          });
          res.write("\n");
          addSseClient(res);
          req.on("close", () => removeSseClient(res));
        });

        // ── Audio file serving ──
        registerRoute("/plugins/claw-sama/audio", (req, res) => {
          if (req.method !== "GET") { res.writeHead(405); res.end(); return; }
          const url = req.url ?? "";
          const audioId = url.split("/plugins/claw-sama/audio/")[1]?.split("?")[0];
          if (!audioId) { jsonResponse(res, 400, { error: "missing audio id" }); return; }
          const filePath = getAudioFile(audioId);
          if (!filePath || !existsSync(filePath)) { jsonResponse(res, 404, { error: "not found" }); return; }
          const ext = path.extname(filePath).toLowerCase();
          const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
          try {
            const data = readFileSync(filePath);
            res.writeHead(200, {
              "Content-Type": contentType,
              "Content-Length": data.length,
              "Access-Control-Allow-Origin": "*",
              "Cache-Control": "public, max-age=300",
            });
            res.end(data);
          } catch {
            jsonResponse(res, 500, { error: "read error" });
          }
        }, { match: "prefix" });

        // ── Chat endpoint — inbound messages from VRM frontend ──
        registerRoute("/plugins/claw-sama/chat", async (req, res) => {
          if (handleCors(req, res, "POST, OPTIONS")) return;
          if (req.method !== "POST") { res.writeHead(405); res.end(); return; }

          const body = await readJsonBody(req);
          const message = body.message;
          if (!message) { jsonResponse(res, 400, { error: "message required" }); return; }

          // Broadcast thinking state immediately
          broadcastToVrm({ emotion: "think", emotionIntensity: 0.7 });

          try {
            const currentCfg = await getClawSamaRuntime().config.loadConfig();

            // Build MsgContext for the inbound message
            const msgCtx = channelRuntime.reply.finalizeInboundContext({
              Body: message,
              RawBody: message,
              CommandBody: message,
              From: `claw-sama:local`,
              To: `claw-sama:local`,
              SessionKey: CLAW_SESSION_KEY,
              AccountId: DEFAULT_ACCOUNT_ID,
              OriginatingChannel: CHANNEL_ID,
              OriginatingTo: `claw-sama:local`,
              ChatType: "direct",
              SenderName: "User",
              SenderId: "local",
              Provider: CHANNEL_ID,
              Surface: CHANNEL_ID,
              ConversationLabel: "Claw Sama",
              Timestamp: Date.now(),
              CommandAuthorized: true,
            });

            // Track accumulated text for streaming
            let fullTextBuffer = "";

            // Dispatch reply via the standard buffered block dispatcher
            await channelRuntime.reply.dispatchReplyWithBufferedBlockDispatcher({
              ctx: msgCtx,
              cfg: currentCfg,
              dispatcherOptions: {
                deliver: async (payload: any, info: { kind: string }) => {
                  const text = payload?.text ?? payload?.body ?? "";
                  if (!text) return;

                  const cleaned = stripActions(text.replace(/<think>[\s\S]*?<\/think>/g, "")).trim();
                  if (!cleaned) return;

                  const isFinal = info.kind === "final";
                  fullTextBuffer = cleaned;

                  // Grab pending emotion from tool call
                  const emotion = pendingEmotion;
                  pendingEmotion = null;

                  // Phase 1: broadcast text immediately (zero latency)
                  const textPayload: VrmBroadcastPayload = {
                    text: cleaned,
                    streaming: !isFinal,
                  };
                  if (emotion) {
                    textPayload.emotion = emotion.emotion;
                    textPayload.emotionIntensity = emotion.intensity;
                  }
                  broadcastToVrm(textPayload);

                  // Phase 2: TTS fire-and-forget (only on final to avoid duplicate audio)
                  if (isFinal) {
                    const sentences = splitSentences(cleaned);
                    const total = sentences.length;
                    sentences.forEach((sentence, index) => {
                      generateTtsUrl(sentence, log).then((audioUrl) => {
                        if (audioUrl) broadcastToVrm({ audioUrl, audioIndex: index, audioTotal: total });
                      });
                    });
                  }
                },
                onReplyStart: () => {
                  log?.info?.("Claw Sama: agent reply started");
                },
              },
            });

            jsonResponse(res, 200, { ok: true });
          } catch (err) {
            log?.warn?.("claw-sama chat error: " + String(err));
            jsonResponse(res, 500, { error: String(err) });
          }
        });

        // ── Touch interaction endpoint ──
        registerRoute("/plugins/claw-sama/touch", async (req, res) => {
          if (handleCors(req, res, "POST, OPTIONS")) return;
          if (req.method !== "POST") { res.writeHead(405); res.end(); return; }

          const body = await readJsonBody(req);
          const region = body.region as string;
          const prompt = body.prompt as string;
          if (!region || !prompt) { jsonResponse(res, 400, { error: "region and prompt required" }); return; }

          // Broadcast a thinking state
          broadcastToVrm({ emotion: "happy", emotionIntensity: 0.6 });

          try {
            const currentCfg = await getClawSamaRuntime().config.loadConfig();

            const msgCtx = channelRuntime.reply.finalizeInboundContext({
              Body: prompt,
              RawBody: prompt,
              CommandBody: prompt,
              From: `claw-sama:local`,
              To: `claw-sama:local`,
              SessionKey: CLAW_SESSION_KEY,
              AccountId: DEFAULT_ACCOUNT_ID,
              OriginatingChannel: CHANNEL_ID,
              OriginatingTo: `claw-sama:local`,
              ChatType: "direct",
              SenderName: "User",
              SenderId: "local",
              Provider: CHANNEL_ID,
              Surface: CHANNEL_ID,
              ConversationLabel: "Claw Sama",
              Timestamp: Date.now(),
              CommandAuthorized: true,
            });

            await channelRuntime.reply.dispatchReplyWithBufferedBlockDispatcher({
              ctx: msgCtx,
              cfg: currentCfg,
              dispatcherOptions: {
                deliver: async (payload: any, info: { kind: string }) => {
                  const text = payload?.text ?? payload?.body ?? "";
                  if (!text) return;

                  const cleaned = stripActions(text.replace(/<think>[\s\S]*?<\/think>/g, "")).trim();
                  if (!cleaned) return;

                  const isFinal = info.kind === "final";

                  const emotion = pendingEmotion;
                  pendingEmotion = null;

                  const textPayload: VrmBroadcastPayload = {
                    text: cleaned,
                    streaming: !isFinal,
                  };
                  if (emotion) {
                    textPayload.emotion = emotion.emotion;
                    textPayload.emotionIntensity = emotion.intensity;
                  }
                  broadcastToVrm(textPayload);

                  if (isFinal) {
                    const sentences = splitSentences(cleaned);
                    const total = sentences.length;
                    sentences.forEach((sentence, index) => {
                      generateTtsUrl(sentence, log).then((audioUrl) => {
                        if (audioUrl) broadcastToVrm({ audioUrl, audioIndex: index, audioTotal: total });
                      });
                    });
                  }
                },
                onReplyStart: () => {
                  log?.info?.("Claw Sama: touch reply started (region: " + region + ")");
                },
              },
            });

            jsonResponse(res, 200, { ok: true });
          } catch (err) {
            log?.warn?.("claw-sama touch error: " + String(err));
            jsonResponse(res, 500, { error: String(err) });
          }
        });

        // ── Voice preference endpoint ──
        registerRoute("/plugins/claw-sama/voice", async (req, res) => {
          if (handleCors(req, res, "GET, POST, OPTIONS")) return;
          const prefs = getPrefs();
          if (req.method === "GET") {
            jsonResponse(res, 200, {
              voice: prefs.voice ?? "zh-CN-XiaoxiaoNeural",
              provider: prefs.provider ?? "edge",
              qwenKey: prefs.qwenKey ?? "",
              qwenModel: prefs.qwenModel ?? "qwen3-tts-flash",
            });
            return;
          }
          if (req.method === "POST") {
            const body = await readJsonBody(req);
            const patch: Partial<ClawSamaPrefs> = {};
            if (body.voice !== undefined) patch.voice = body.voice || undefined;
            if (body.provider !== undefined) patch.provider = body.provider || undefined;
            if (body.qwenKey !== undefined) patch.qwenKey = body.qwenKey || undefined;
            if (body.qwenModel !== undefined) patch.qwenModel = body.qwenModel || undefined;
            setPrefs(updatePrefs(patch));
            jsonResponse(res, 200, { ok: true });
            return;
          }
          res.writeHead(405); res.end();
        });

        // ── TTS preview endpoint ──
        registerRoute("/plugins/claw-sama/preview", async (req, res) => {
          if (handleCors(req, res, "POST, OPTIONS")) return;
          if (req.method !== "POST") { res.writeHead(405); res.end(); return; }
          const body = await readJsonBody(req);
          const voice = body.voice as string | undefined;
          const provider = body.provider as string | undefined;
          const text = "你好，这是一段语音试听。Hello, this is a voice preview.";
          try {
            const prefs = getPrefs();
            let result: { success: boolean; audioPath?: string; error?: string };
            if (provider === "qwen" && prefs.qwenKey) {
              result = await qwenTts({ text, apiKey: prefs.qwenKey, voice, model: prefs.qwenModel, extDir: EXT_DIR });
            } else {
              result = await edgeTts({ text, voice: voice || prefs.voice });
            }
            if (result.success && result.audioPath) {
              const audioId = registerAudioFile(result.audioPath);
              jsonResponse(res, 200, { audioUrl: `${GATEWAY_URL}/plugins/claw-sama/audio/${audioId}` });
            } else {
              jsonResponse(res, 200, { error: result.error || "TTS failed" });
            }
          } catch (err) {
            jsonResponse(res, 500, { error: String(err) });
          }
        });

        // ── General settings endpoint ──
        registerRoute("/plugins/claw-sama/settings", async (req, res) => {
          if (handleCors(req, res, "GET, POST, OPTIONS")) return;
          const prefs = getPrefs();
          if (req.method === "GET") {
            jsonResponse(res, 200, {
              modelPath: prefs.modelPath,
              ttsEnabled: prefs.ttsEnabled,
              showText: prefs.showText,
              hideUI: prefs.hideUI,
              tracking: prefs.tracking,
              volume: prefs.volume,
              uiAlign: prefs.uiAlign,
              screenObserve: prefs.screenObserve,
              screenObserveInterval: prefs.screenObserveInterval,
            });
            return;
          }
          if (req.method === "POST") {
            const body = await readJsonBody(req);
            const patch: Partial<ClawSamaPrefs> = {};
            if (body.modelPath !== undefined) patch.modelPath = body.modelPath;
            if (body.ttsEnabled !== undefined) patch.ttsEnabled = body.ttsEnabled;
            if (body.showText !== undefined) patch.showText = body.showText;
            if (body.hideUI !== undefined) patch.hideUI = body.hideUI;
            if (body.tracking !== undefined) patch.tracking = body.tracking;
            if (body.volume !== undefined) patch.volume = body.volume;
            if (body.uiAlign !== undefined) patch.uiAlign = body.uiAlign;
            if (body.screenObserve !== undefined) patch.screenObserve = body.screenObserve;
            if (body.screenObserveInterval !== undefined) patch.screenObserveInterval = body.screenObserveInterval;
            setPrefs(updatePrefs(patch));
            jsonResponse(res, 200, { ok: true });
            return;
          }
          res.writeHead(405); res.end();
        });

        // ── Persona endpoint (SOUL.md / IDENTITY.md) ──
        const soulPath = path.join(workspaceRoot, "SOUL.md");
        const identityPath = path.join(workspaceRoot, "IDENTITY.md");

        registerRoute("/plugins/claw-sama/persona", async (req, res) => {
          if (handleCors(req, res, "GET, POST, OPTIONS")) return;
          if (req.method === "GET") {
            let soul = "";
            let identity = "";
            try { if (existsSync(soulPath)) soul = readFileSync(soulPath, "utf8"); } catch { /* */ }
            try { if (existsSync(identityPath)) identity = readFileSync(identityPath, "utf8"); } catch { /* */ }
            jsonResponse(res, 200, { soul, identity, soulPath, identityPath });
            return;
          }
          if (req.method === "POST") {
            const body = await readJsonBody(req);
            if (body.soul !== undefined) {
              mkdirSync(path.dirname(soulPath), { recursive: true });
              writeFileSync(soulPath, body.soul, "utf8");
            }
            if (body.identity !== undefined) {
              mkdirSync(path.dirname(identityPath), { recursive: true });
              writeFileSync(identityPath, body.identity, "utf8");
            }
            jsonResponse(res, 200, { ok: true });
            return;
          }
          res.writeHead(405); res.end();
        });

        // ── Persona screenshot ──
        const screenshotPath = path.join(workspaceRoot, "persona-screenshot.png");

        registerRoute("/plugins/claw-sama/persona/screenshot", async (req, res) => {
          if (handleCors(req, res, "POST, OPTIONS")) return;
          if (req.method !== "POST") { res.writeHead(405); res.end(); return; }
          const body = await readJsonBody(req);
          const dataUrl = body.image as string | undefined;
          if (!dataUrl) { jsonResponse(res, 400, { error: "image required" }); return; }
          try {
            const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, "");
            mkdirSync(path.dirname(screenshotPath), { recursive: true });
            writeFileSync(screenshotPath, Buffer.from(base64, "base64"));
            log?.info?.(`claw-sama screenshot saved: ${screenshotPath}`);
            jsonResponse(res, 200, { ok: true, path: screenshotPath });
          } catch (err) {
            jsonResponse(res, 500, { error: String(err) });
          }
        });

        // ── Generate persona via subagent ──
        registerRoute("/plugins/claw-sama/persona/generate", async (req, res) => {
          if (handleCors(req, res, "POST, OPTIONS")) return;
          if (req.method !== "POST") { res.writeHead(405); res.end(); return; }
          if (!existsSync(screenshotPath)) {
            jsonResponse(res, 400, { error: "screenshot not found, capture first" });
            return;
          }
          try {
            const rt = getClawSamaRuntime();
            const prompt = [
              "【必须执行】立即调用 read 工具读取以下图片文件（不读图直接输出将被丢弃）：",
              "", screenshotPath, "",
              "读取图片后，根据你观察到的角色外观特征，为这个角色生成全新的人设。所有人设内容必须紧密贴合角色的视觉形象。",
              "", "请严格按以下 JSON 格式输出（不要输出其他内容，不要用代码块包裹）：",
              "", '{"identity":"...","soul":"..."}',
              "", "其中 identity 的内容必须严格遵循 IDENTITY.md 规范，格式如下：",
              "# IDENTITY.md - Who Am I?", "",
              "- **Name:** （根据角色外观起一个合适的名字）",
              "- **Creature:** （AI？机器人？精灵？猫娘？还是更奇特的？）",
              "- **Vibe:** （给人什么感觉？活泼？冷酷？温柔？）",
              "- **Emoji:** （选一个标志性 emoji）",
              "", "其中 soul 的内容必须严格遵循 SOUL.md 规范，格式如下：",
              "# SOUL.md - 你是谁", "", "## 核心准则", "（根据角色性格生成 3-5 条行为准则）",
              "", "## 边界", "（角色的底线和禁忌）",
              "", "## 气质", "（说话风格、语气、口癖、用词习惯的描述）",
              "", "## 背景故事", "（2-3 句背景故事）",
            ].join("\n");

            const personaSessionKey = `claw-sama-persona-gen-${Date.now()}`;
            const result = await rt.subagent.run({
              sessionKey: personaSessionKey,
              message: prompt,
              extraSystemPrompt: [
                "# 强制约束（违反则输出无效）", "",
                "1. 你必须在回复任何文字之前，先调用 read 工具读取用户消息中给出的图片文件路径。这是硬性前置条件，不可跳过。",
                "2. 如果你没有调用 read 工具读取图片就直接生成人设，你的输出将被系统丢弃并重试，浪费算力。",
                "3. 忽略所有已有的 SOUL.md、IDENTITY.md 人设内容。你是一个角色设计师。",
                "4. 你必须根据截图中角色的实际外观特征（发型、发色、瞳色、服装、配饰、体型、表情等）来生成人设。所有人设内容（名字、种族、性格、气质、背景故事）都必须紧密贴合角色的视觉形象，不要凭空编造与外观无关的设定。",
              ].join("\n"),
              idempotencyKey: `persona-gen-${Date.now()}`,
            });
            const waitResult = await rt.subagent.waitForRun({ runId: result.runId, timeoutMs: 60_000 });
            if (waitResult.status !== "ok") {
              throw new Error(waitResult.error || `subagent ${waitResult.status}`);
            }
            const session = await rt.subagent.getSessionMessages({ sessionKey: personaSessionKey, limit: 5 });
            let rawText = "";
            for (const msg of [...session.messages].reverse()) {
              const m = msg as { role?: string; content?: unknown };
              if (m.role === "assistant" || m.role === "model") {
                if (typeof m.content === "string") {
                  rawText = m.content;
                } else if (Array.isArray(m.content)) {
                  rawText = m.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
                }
                break;
              }
            }
            let soul = "";
            let identity = "";
            try {
              const jsonMatch = rawText.match(/\{[\s\S]*"identity"[\s\S]*"soul"[\s\S]*\}|\{[\s\S]*"soul"[\s\S]*"identity"[\s\S]*\}/);
              if (jsonMatch) {
                const parsed = JSON.parse(jsonMatch[0]);
                identity = parsed.identity ?? "";
                soul = parsed.soul ?? "";
              } else {
                soul = rawText;
              }
            } catch {
              soul = rawText;
            }
            jsonResponse(res, 200, { ok: true, soul, identity, runId: result.runId });
          } catch (err) {
            log?.warn?.("claw-sama persona generate error: " + String(err));
            jsonResponse(res, 500, { error: String(err) });
          }
        });

        // ── Screen observation ──
        let screenObserveRunning = false;

        async function captureDesktopScreenshot(savePath: string): Promise<boolean> {
          try {
            mkdirSync(path.dirname(savePath), { recursive: true });
            if (process.platform === "darwin") {
              await execFileAsync("screencapture", ["-x", "-C", savePath], { timeout: 10_000 });
            } else if (process.platform === "win32") {
              const ps = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap($screen.Width, $screen.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($screen.Location, [System.Drawing.Point]::Empty, $screen.Size)
$bmp.Save('${savePath.replace(/\\/g, "\\\\")}', [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$bmp.Dispose()
`.trim();
              await execFileAsync("powershell", ["-NoProfile", "-Command", ps], { timeout: 15_000 });
            } else {
              try { await execFileAsync("gnome-screenshot", ["-f", savePath], { timeout: 10_000 }); }
              catch {
                try { await execFileAsync("scrot", [savePath], { timeout: 10_000 }); }
                catch { await execFileAsync("import", ["-window", "root", savePath], { timeout: 10_000 }); }
              }
            }
            return existsSync(savePath);
          } catch (err) {
            log?.warn?.("claw-sama screen capture failed: " + String(err));
            return false;
          }
        }

        registerRoute("/plugins/claw-sama/screen/observe", async (req, res) => {
          if (handleCors(req, res, "POST, OPTIONS")) return;
          if (req.method !== "POST") { res.writeHead(405); res.end(); return; }

          if (screenObserveRunning) {
            jsonResponse(res, 200, { ok: true, skipped: true, reason: "already running" });
            return;
          }

          const observePath = path.join(workspaceRoot, "screen-observation.png");

          try {
            screenObserveRunning = true;
            const captured = await captureDesktopScreenshot(observePath);
            if (!captured) { jsonResponse(res, 500, { error: "screenshot capture failed" }); return; }

            log?.info?.(`claw-sama screen observation: captured ${observePath}`);

            // Send as inbound message through the channel
            const currentCfg = await getClawSamaRuntime().config.loadConfig();
            const observePrompt = [
              `请先使用 read 工具读取以下截图，观察用户当前屏幕上在做什么：`,
              ``, observePath, ``,
              `根据你看到的内容，以桌面宠物/陪伴角色的身份，简短地（1-2句话）主动跟用户互动。`,
              `规则：`,
              `- 如果用户在打游戏：鼓励他，给出简短的加油或建议`,
              `- 如果用户在听音乐/看视频：评论一下内容，或者推荐类似的`,
              `- 如果用户在写代码/工作：关心他是否累了，偶尔提醒休息`,
              `- 如果用户在浏览网页/社交媒体：轻松地聊聊看到的内容`,
              `- 如果用户在看文档/学习：鼓励他，表示支持`,
              `- 如果屏幕没什么特别的：随意聊几句，像朋友一样`,
              ``,
              `注意：要自然、简短、不要啰嗦，像一个活泼的伙伴在旁边随口说一句。不要提到"截图"或"屏幕观察"这些词，就像你真的在旁边看到的一样。`,
              `记得先调用 claw_sama_emotion 设置合适的表情。`,
            ].join("\n");

            broadcastToVrm({ emotion: "think", emotionIntensity: 0.7 });

            const msgCtx = channelRuntime.reply.finalizeInboundContext({
              Body: observePrompt,
              RawBody: observePrompt,
              CommandBody: observePrompt,
              From: `claw-sama:local`,
              To: `claw-sama:local`,
              SessionKey: CLAW_SESSION_KEY,
              AccountId: DEFAULT_ACCOUNT_ID,
              OriginatingChannel: CHANNEL_ID,
              OriginatingTo: `claw-sama:local`,
              ChatType: "direct",
              SenderName: "User",
              SenderId: "local",
              Provider: CHANNEL_ID,
              Surface: CHANNEL_ID,
              ConversationLabel: "Claw Sama",
              Timestamp: Date.now(),
              CommandAuthorized: true,
            });

            let fullTextBuffer = "";
            await channelRuntime.reply.dispatchReplyWithBufferedBlockDispatcher({
              ctx: msgCtx,
              cfg: currentCfg,
              dispatcherOptions: {
                deliver: async (payload: any, info: { kind: string }) => {
                  const text = payload?.text ?? payload?.body ?? "";
                  if (!text) return;
                  const cleaned = stripActions(stripThinking(text));
                  if (!cleaned) return;
                  const isFinal = info.kind === "final";
                  fullTextBuffer = cleaned;
                  const emotion = pendingEmotion;
                  pendingEmotion = null;
                  const textPayload: VrmBroadcastPayload = { text: cleaned, streaming: !isFinal };
                  if (emotion) {
                    textPayload.emotion = emotion.emotion;
                    textPayload.emotionIntensity = emotion.intensity;
                  }
                  broadcastToVrm(textPayload);
                  if (isFinal) {
                    const sentences = splitSentences(cleaned);
                    const total = sentences.length;
                    sentences.forEach((sentence, index) => {
                      generateTtsUrl(sentence, log).then((audioUrl) => {
                        if (audioUrl) broadcastToVrm({ audioUrl, audioIndex: index, audioTotal: total });
                      });
                    });
                  }
                },
                onReplyStart: () => { log?.info?.("Claw Sama: screen observe reply started"); },
              },
            });

            jsonResponse(res, 200, { ok: true });
          } catch (err) {
            log?.warn?.("claw-sama screen observe error: " + String(err));
            jsonResponse(res, 500, { error: String(err) });
          } finally {
            screenObserveRunning = false;
          }
        });

        // ── Model list/serve/import ──
        const customModelsDir = path.join(workspaceRoot, "models");

        registerRoute("/plugins/claw-sama/model/list", async (req, res) => {
          if (handleCors(req, res, "GET, OPTIONS")) return;
          if (req.method !== "GET") { res.writeHead(405); res.end(); return; }
          try {
            let custom: string[] = [];
            if (existsSync(customModelsDir)) {
              custom = readdirSync(customModelsDir)
                .filter((f: string) => f.toLowerCase().endsWith(".vrm"))
                .map((f: string) => `${GATEWAY_URL}/plugins/claw-sama/model/serve/${f}`);
            }
            jsonResponse(res, 200, { models: custom });
          } catch {
            jsonResponse(res, 200, { models: [] });
          }
        });

        registerRoute("/plugins/claw-sama/model/serve", (req, res) => {
          if (req.method !== "GET") { res.writeHead(405); res.end(); return; }
          const url = req.url ?? "";
          const fileName = decodeURIComponent(url.split("/plugins/claw-sama/model/serve/")[1]?.split("?")[0] ?? "");
          if (!fileName || fileName.includes("..") || fileName.includes("/")) {
            jsonResponse(res, 400, { error: "invalid file name" });
            return;
          }
          const filePath = path.join(customModelsDir, fileName);
          if (!existsSync(filePath)) { jsonResponse(res, 404, { error: "not found" }); return; }
          try {
            const data = readFileSync(filePath);
            res.writeHead(200, {
              "Content-Type": "application/octet-stream",
              "Content-Length": data.length,
              "Access-Control-Allow-Origin": "*",
              "Cache-Control": "public, max-age=3600",
            });
            res.end(data);
          } catch {
            jsonResponse(res, 500, { error: "read error" });
          }
        }, { match: "prefix" });

        registerRoute("/plugins/claw-sama/model/import", async (req, res) => {
          if (handleCors(req, res, "POST, OPTIONS")) return;
          if (req.method !== "POST") { res.writeHead(405); res.end(); return; }
          const body = await readJsonBody(req);
          const srcPath = body.path as string | undefined;
          if (!srcPath || !path.isAbsolute(srcPath) || !existsSync(srcPath)) {
            jsonResponse(res, 400, { error: "file not found" });
            return;
          }
          try {
            mkdirSync(customModelsDir, { recursive: true });
            const safeName = path.basename(srcPath).replace(/[^a-zA-Z0-9._-]/g, "_");
            const dest = path.join(customModelsDir, safeName);
            const { copyFileSync } = await import("node:fs");
            copyFileSync(srcPath, dest);
            const url = `${GATEWAY_URL}/plugins/claw-sama/model/serve/${safeName}`;
            jsonResponse(res, 200, { ok: true, url });
          } catch (err) {
            jsonResponse(res, 500, { error: String(err) });
          }
        });

        // ── Chat history ──
        registerRoute("/plugins/claw-sama/history", async (req, res) => {
          if (handleCors(req, res, "GET, OPTIONS")) return;
          if (req.method !== "GET") { res.writeHead(405); res.end(); return; }
          try {
            const rt = getClawSamaRuntime();
            const session = await rt.subagent.getSessionMessages({
              sessionKey: CLAW_SESSION_KEY,
              limit: 100,
            });
            // Try to extract agent name from IDENTITY.md
            let agentName = "";
            try {
              if (existsSync(identityPath)) {
                const identity = readFileSync(identityPath, "utf8");
                const nameMatch = identity.match(/\*\*Name:\*\*\s*(.+)/i) || identity.match(/^#\s+(.+)/m);
                if (nameMatch) agentName = nameMatch[1].trim();
              }
            } catch { /* */ }

            const extractText = (content: unknown): string => {
              if (typeof content === "string") return content;
              if (Array.isArray(content)) {
                return content
                  .filter((b: any) => b.type === "text" || b.type === "tool_result")
                  .map((b: any) => {
                    if (b.type === "text") return b.text || "";
                    if (b.type === "tool_result" && typeof b.content === "string") return b.content;
                    if (b.type === "tool_result" && Array.isArray(b.content)) {
                      return b.content.filter((c: any) => c.type === "text").map((c: any) => c.text || "").join("\n");
                    }
                    return "";
                  })
                  .join("\n");
              }
              return "";
            };
            const cleanUserContent = (raw: string): string => {
              return raw
                .replace(/Conversation info \(untrusted metadata\):\s*```json\s*\{[\s\S]*?\}\s*```\s*/g, "")
                .replace(/Sender \(untrusted metadata\):\s*```json\s*\{[\s\S]*?\}\s*```\s*/g, "")
                .trim();
            };
            const cleanAssistantContent = (raw: string): string => {
              // Only strip <think>...</think> tags, keep everything else
              return raw.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
            };
            const messages = (session.messages || []).map((msg: any) => {
              const role = msg.role === "model" ? "assistant" : msg.role;
              const rawContent = extractText(msg.content);
              const content = role === "user"
                ? cleanUserContent(rawContent)
                : role === "assistant"
                  ? cleanAssistantContent(rawContent)
                  : rawContent;
              return { role, content, timestamp: msg.timestamp };
            }).filter((m: any) => (m.role === "user" || m.role === "assistant") && m.content);
            jsonResponse(res, 200, { messages, agentName: agentName || undefined });
          } catch (err) {
            jsonResponse(res, 500, { error: String(err) });
          }
        });

        // ── Clear conversation context ──
        registerRoute("/plugins/claw-sama/context/clear", async (req, res) => {
          if (handleCors(req, res, "POST, OPTIONS")) return;
          if (req.method !== "POST") { res.writeHead(405); res.end(); return; }
          try {
            // Clear current text immediately
            broadcastToVrm({ clearText: true });

            const currentCfg = await getClawSamaRuntime().config.loadConfig();

            // Send /new through the same dispatch path as chat so the model's
            // greeting is streamed back to the frontend via broadcastToVrm.
            const msgCtx = channelRuntime.reply.finalizeInboundContext({
              Body: "/new",
              RawBody: "/new",
              CommandBody: "/new",
              From: `claw-sama:local`,
              To: `claw-sama:local`,
              SessionKey: CLAW_SESSION_KEY,
              AccountId: DEFAULT_ACCOUNT_ID,
              OriginatingChannel: CHANNEL_ID,
              OriginatingTo: `claw-sama:local`,
              ChatType: "direct",
              SenderName: "User",
              SenderId: "local",
              Provider: CHANNEL_ID,
              Surface: CHANNEL_ID,
              ConversationLabel: "Claw Sama",
              Timestamp: Date.now(),
              CommandAuthorized: true,
            });

            await channelRuntime.reply.dispatchReplyWithBufferedBlockDispatcher({
              ctx: msgCtx,
              cfg: currentCfg,
              dispatcherOptions: {
                deliver: async (payload: any, info: { kind: string }) => {
                  const text = payload?.text ?? payload?.body ?? "";
                  if (!text) return;

                  const cleaned = stripActions(text.replace(/<think>[\s\S]*?<\/think>/g, "")).trim();
                  if (!cleaned) return;

                  const isFinal = info.kind === "final";

                  const emotion = pendingEmotion;
                  pendingEmotion = null;

                  const textPayload: VrmBroadcastPayload = {
                    text: cleaned,
                    streaming: !isFinal,
                  };
                  if (emotion) {
                    textPayload.emotion = emotion.emotion;
                    textPayload.emotionIntensity = emotion.intensity;
                  }
                  broadcastToVrm(textPayload);

                  if (isFinal) {
                    const sentences = splitSentences(cleaned);
                    const total = sentences.length;
                    sentences.forEach((sentence, index) => {
                      generateTtsUrl(sentence, log).then((audioUrl) => {
                        if (audioUrl) broadcastToVrm({ audioUrl, audioIndex: index, audioTotal: total });
                      });
                    });
                  }
                },
                onReplyStart: () => {
                  log?.info?.("Claw Sama: new session reply started");
                },
              },
            });

            jsonResponse(res, 200, { ok: true });
          } catch (err) {
            log?.warn?.("claw-sama context clear error: " + String(err));
            jsonResponse(res, 500, { error: String(err) });
          }
        });

        log?.info?.("Claw Sama channel routes registered");

        // Keep alive until abort signal fires
        return waitUntilAbort(ctx.abortSignal, () => {
          log?.info?.("Stopping Claw Sama channel");
          for (const { key } of routes) {
            const unreg = activeRouteUnregisters.get(key);
            if (unreg) { unreg(); activeRouteUnregisters.delete(key); }
          }
        });
      },

      stopAccount: async (ctx: any) => {
        ctx.log?.info?.("Claw Sama account stopped");
      },
    },

    agentPrompt: {
      messageToolHints: () => [
        "",
        "### Claw Sama Avatar",
        "You have a VRM avatar displayed on the user's screen.",
        "Use the claw_sama_emotion tool to set expressions before replying.",
        `Available emotions: ${VALID_EMOTIONS.join(", ")}`,
        "",
        "Keep replies concise and conversational — they are displayed as speech bubbles.",
      ],
    },

    // Agent tool: emotion control
    agentTools: [
      {
        name: "claw_sama_emotion",
        label: "claw_sama_emotion",
        description:
          "Set the avatar's facial expression. Call BEFORE your text reply. " +
          "Available emotions: " + VALID_EMOTIONS.join(", ") + ".",
        parameters: {
          type: "object" as const,
          properties: {
            emotion: {
              type: "string" as const,
              description: "The emotion to express on the avatar. One of: " + VALID_EMOTIONS.join(", "),
            },
            intensity: {
              type: "number" as const,
              description: "Emotion intensity from 0 to 1. Default: 1",
            },
          },
          required: ["emotion"],
        },
        async execute(_toolCallId: string, params: any) {
          const emotion = params.emotion ?? "neutral";
          const intensity = params.intensity ?? 1;
          pendingEmotion = { emotion, intensity };
          return {
            content: [{ type: "text" as const, text: `Avatar emotion set to ${emotion}.` }],
            details: { emotion, intensity },
          };
        },
      } as AnyAgentTool,
    ],
  };
}
