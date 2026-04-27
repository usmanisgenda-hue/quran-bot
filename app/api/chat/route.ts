import OpenAI from "openai";
import { prisma } from "@/lib/prisma";
import fs from "fs/promises";
import path from "path";

export const runtime = "nodejs";
export const maxDuration = 60;

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

type StoredAttachment = {
  id?: string;
  name?: string;
  kind?: "image" | "file";
  previewUrl?: string;
  base64?: string;
  type?: string;
  mimeType?: string;
  size?: number;
};

type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

type ChatHistoryMessage = {
  role: "system" | "user" | "assistant";
  content: string | ChatContentPart[];
};

type ClientHistoryItem = {
  question?: string;
  answer?: string;
  imageUrl?: string;
  attachments?: StoredAttachment[];
};

function cleanBase64(input?: string) {
  if (!input) return "";
  return input.includes(",") ? input.split(",").pop() || "" : input;
}

function getAttachmentExtension(attachment: StoredAttachment) {
  const source = attachment.name || attachment.previewUrl || "";
  return path.extname(source).toLowerCase();
}

function getAttachmentMimeType(attachment: StoredAttachment) {
  if (attachment.mimeType) return attachment.mimeType;
  if (attachment.type) return attachment.type;

  const ext = getAttachmentExtension(attachment);

  switch (ext) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".pdf":
      return "application/pdf";
    case ".txt":
      return "text/plain";
    case ".csv":
      return "text/csv";
    case ".md":
      return "text/markdown";
    default:
      return "application/octet-stream";
  }
}

function isImageAttachment(attachment: StoredAttachment) {
  const mimeType = getAttachmentMimeType(attachment);
  const ext = getAttachmentExtension(attachment);

  return (
    attachment.kind === "image" ||
    mimeType.startsWith("image/") ||
    [".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(ext)
  );
}

function attachmentToDataUrl(attachment: StoredAttachment) {
  const base64 = cleanBase64(attachment.base64);
  if (!base64) return "";
  return `data:${getAttachmentMimeType(attachment)};base64,${base64}`;
}

function parseUserMessageContent(content: string): {
  text: string;
  attachments: StoredAttachment[];
} {
  try {
    const parsed = JSON.parse(content);
    return {
      text: typeof parsed?.text === "string" ? parsed.text : content,
      attachments: Array.isArray(parsed?.attachments) ? parsed.attachments : [],
    };
  } catch {
    return { text: content, attachments: [] };
  }
}

function isLikelyJson(content: string) {
  const trimmed = content.trim();
  return trimmed.startsWith("{") && trimmed.endsWith("}");
}

function parseStoredAssistantPayload(content: string): {
  type?: string;
  text?: string;
  imageUrl?: string;
} | null {
  if (!isLikelyJson(content)) return null;

  try {
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function shouldGenerateImage(question: string, attachments: StoredAttachment[]) {
  if (attachments.length > 0) return false;

  const q = question.trim().toLowerCase();
  if (!q) return false;

  const patterns = [
    /^generate an image\b/,
    /^generate image\b/,
    /^create an image\b/,
    /^create image\b/,
    /^make an image\b/,
    /^make me an image\b/,
    /^draw\b/,
    /^illustrate\b/,
    /^produce an image\b/,
    /^show me an image of\b/,
    /^create a picture of\b/,
    /^generate a picture of\b/,
  ];

  return patterns.some((pattern) => pattern.test(q));
}

function cleanImagePrompt(question: string) {
  return question
    .trim()
    .replace(/^please\s+/i, "")
    .replace(/^(generate|create|make|produce)\s+(me\s+)?/i, "")
    .replace(/^(an?\s+)?(image|picture)\s+(of|for)\s+/i, "")
    .replace(/^(draw|illustrate)\s+/i, "")
    .trim();
}

function makeSafeAttachmentForDb(attachment: StoredAttachment) {
  return {
    id: attachment.id,
    name: attachment.name,
    kind: attachment.kind,
    previewUrl: attachment.previewUrl,
    type: attachment.type,
    mimeType: attachment.mimeType,
    size: attachment.size,
  };
}

function publicUrlToAbsolutePath(publicUrl: string) {
  const cleanPath = publicUrl.startsWith("/") ? publicUrl.slice(1) : publicUrl;
  return path.join(process.cwd(), "public", cleanPath);
}

async function localPublicImageToDataUrl(imageUrl: string) {
  if (imageUrl.startsWith("data:image/")) return imageUrl;
  if (!imageUrl.startsWith("/")) return "";

  try {
    const filePath = publicUrlToAbsolutePath(imageUrl);
    const fileBuffer = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const mimeType =
      ext === ".jpg" || ext === ".jpeg"
        ? "image/jpeg"
        : ext === ".webp"
          ? "image/webp"
          : ext === ".gif"
            ? "image/gif"
            : "image/png";

    return `data:${mimeType};base64,${fileBuffer.toString("base64")}`;
  } catch (error) {
    console.error("Could not rehydrate local generated image:", imageUrl, error);
    return "";
  }
}

async function saveBase64ImageToPublic(base64: string) {
  const dir = path.join(process.cwd(), "public", "generated-images");
  await fs.mkdir(dir, { recursive: true });

  const filename = `${Date.now()}-${Math.random().toString(36).slice(2)}.png`;
  const filePath = path.join(dir, filename);
  await fs.writeFile(filePath, Buffer.from(cleanBase64(base64), "base64"));

  return `/generated-images/${filename}`;
}

async function buildUserContent(
  text: string,
  attachments: StoredAttachment[] = []
): Promise<string | ChatContentPart[]> {
  const textPart: ChatContentPart = {
    type: "text",
    text: text?.trim() || "Please analyze the attached content.",
  };

  const parts: ChatContentPart[] = [textPart];

  for (const attachment of attachments) {
    if (!isImageAttachment(attachment)) {
      if (attachment.name) {
        textPart.text += `\n\nUploaded file: ${attachment.name}.`;
      }
      continue;
    }

    const dataUrl = attachmentToDataUrl(attachment);
    if (!dataUrl) {
      if (attachment.name) {
        textPart.text += `\n\nImage attachment metadata received: ${attachment.name}.`;
      }
      continue;
    }

    parts.push({
      type: "image_url",
      image_url: { url: dataUrl },
    });
  }

  return parts.length === 1 ? textPart.text : parts;
}

async function assistantMessageToHistory(content: string): Promise<ChatHistoryMessage[]> {
  const parsed = parseStoredAssistantPayload(content);

  if (parsed?.type === "image" && typeof parsed.imageUrl === "string") {
    const assistantText =
      typeof parsed.text === "string" && parsed.text.trim()
        ? parsed.text.trim()
        : "Here is your generated image.";

    const history: ChatHistoryMessage[] = [
      { role: "assistant", content: assistantText },
    ];

    const dataUrl = await localPublicImageToDataUrl(parsed.imageUrl);

    if (dataUrl) {
      history.push({
        role: "user",
        content: [
          {
            type: "text",
            text:
              "Reference from earlier in this same conversation: this is the previously generated image. " +
              "Use it when answering follow-up questions about 'this image', 'that image', or similar references.",
          },
          { type: "image_url", image_url: { url: dataUrl } },
        ],
      });
    } else {
      history.push({
        role: "assistant",
        content: `${assistantText}\n\nGenerated image reference: ${parsed.imageUrl}`,
      });
    }

    return history;
  }

  return [{ role: "assistant", content }];
}

async function clientHistoryToMessages(
  history: ClientHistoryItem[] = []
): Promise<ChatHistoryMessage[]> {
  const messages: ChatHistoryMessage[] = [];
  const recent = history.slice(-10);

  for (const item of recent) {
    if (item.question?.trim()) {
      messages.push({
        role: "user",
        content: await buildUserContent(item.question, item.attachments ?? []),
      });
    }

    if (item.answer?.trim()) {
      messages.push({ role: "assistant", content: item.answer });
    }

    if (item.imageUrl) {
      const dataUrl = await localPublicImageToDataUrl(item.imageUrl);
      if (dataUrl) {
        messages.push({
          role: "user",
          content: [
            {
              type: "text",
              text:
                "Reference from earlier in this same conversation: this is the previously generated image. " +
                "Use it when answering follow-up questions about the image.",
            },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        });
      }
    }
  }

  return messages;
}

function buildRealtimeDateContext() {
  const now = new Date();

  return {
    isoDate: now.toISOString(),
    utcYear: now.getUTCFullYear(),
    localYear: now.getFullYear(),
    prettyUtc: now.toUTCString(),
    prettyLocal: now.toLocaleString("en-CA", {
      dateStyle: "full",
      timeStyle: "long",
    }),
  };
}

function buildSystemPrompt() {
  const dateContext = buildRealtimeDateContext();

  return (
    "You are Quran Assist, a respectful and knowledgeable Islamic assistant. " +
    "Maintain conversational continuity and use recent chat history carefully. " +
    "If a prior generated image is included as a reference in the conversation history, use it directly to answer follow-up questions about that image. " +
    "If the user says 'this image', 'that image', or similar, first check whether a referenced image from earlier in the same conversation is present. " +
    "If the user provides image attachments, analyze the visible contents directly. " +
    "Do not claim you cannot view an image when an image is present in the conversation context. " +
    "For Islamic questions, include a relevant Quran reference when a relevant ayah exists. Do not invent exact ayah wording. " +
    "When citing Quran, use this parseable format on its own line: Quran 2:153 — Indeed, Allah is with the patient. " +
    "For time-sensitive questions, use the runtime date context below instead of stale knowledge. " +
    `Current runtime ISO date/time: ${dateContext.isoDate}. ` +
    `Current UTC year: ${dateContext.utcYear}. ` +
    `Current local year: ${dateContext.localYear}. ` +
    `Current UTC date string: ${dateContext.prettyUtc}. ` +
    `Current local date string: ${dateContext.prettyLocal}. ` +
    "Be clear, helpful, and reasonably concise."
  );
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const {
      question = "",
      conversationId,
      attachments = [],
      regenerate = false,
      history = [],
    } = body ?? {};

    const safeAttachments: StoredAttachment[] = Array.isArray(attachments)
      ? attachments
      : [];

    if (!question?.trim() && safeAttachments.length === 0) {
      return new Response("Question or attachment is required.", { status: 400 });
    }

    let conversation =
      typeof conversationId === "number"
        ? await prisma.conversation.findUnique({ where: { id: conversationId } })
        : null;

    if (!conversation) {
      conversation = await prisma.conversation.create({
        data: { title: "New Chat" },
      });
    }

    if (!regenerate) {
      await prisma.message.create({
        data: {
          conversationId: conversation.id,
          role: "user",
          content: JSON.stringify({
            text: question,
            attachments: safeAttachments.map(makeSafeAttachmentForDb),
          }),
        },
      });
    }

    if (shouldGenerateImage(question, safeAttachments)) {
      const prompt = cleanImagePrompt(question) || question.trim();

      const result = await client.images.generate({
        model: "gpt-image-1",
        prompt,
        size: "1024x1024",
      });

      const imageBase64 = result.data?.[0]?.b64_json;

      if (!imageBase64) {
        throw new Error("Image generation returned no image data.");
      }

      const imageUrl = await saveBase64ImageToPublic(imageBase64);

      const assistantPayload = {
        type: "image",
        text: "Here is your generated image.",
        imageUrl,
      };

      await prisma.message.create({
        data: {
          conversationId: conversation.id,
          role: "assistant",
          content: JSON.stringify(assistantPayload),
        },
      });

      return Response.json(assistantPayload, {
        headers: {
          "X-Conversation-Id": String(conversation.id),
        },
      });
    }

    const recentMessagesDesc = await prisma.message.findMany({
      where: { conversationId: conversation.id },
      orderBy: { createdAt: "desc" },
      take: 18,
    });

    const recentMessages = recentMessagesDesc.reverse();
    const dbHistoryMessages: ChatHistoryMessage[] = [];

    for (const msg of recentMessages) {
      if (msg.role === "user") {
        const parsed = parseUserMessageContent(msg.content);
        dbHistoryMessages.push({
          role: "user",
          content: await buildUserContent(parsed.text, parsed.attachments),
        });
      } else {
        dbHistoryMessages.push(...(await assistantMessageToHistory(msg.content)));
      }
    }

    const frontendHistoryMessages = await clientHistoryToMessages(history);

    const messages: ChatHistoryMessage[] = [
      { role: "system", content: buildSystemPrompt() },
      ...(dbHistoryMessages.length > 0 ? dbHistoryMessages : frontendHistoryMessages),
      ...(regenerate
        ? []
        : [
            {
              role: "user",
              content: await buildUserContent(question, safeAttachments),
            } satisfies ChatHistoryMessage,
          ]),
    ];

    const stream = await client.chat.completions.create({
      model: "gpt-4o",
      messages: messages as any,
      stream: true,
    });

    const encoder = new TextEncoder();
    let fullAnswer = "";

    const readableStream = new ReadableStream({
      async start(controller) {
        try {
          for await (const chunk of stream) {
            const token = chunk.choices?.[0]?.delta?.content || "";
            if (!token) continue;

            fullAnswer += token;
            controller.enqueue(encoder.encode(token));
          }

          await prisma.message.create({
            data: {
              conversationId: conversation!.id,
              role: "assistant",
              content: fullAnswer || "No response generated.",
            },
          });

          controller.close();
        } catch (error) {
          console.error("Streaming error:", error);
          controller.error(error);
        }
      },
    });

    return new Response(readableStream, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "X-Conversation-Id": String(conversation.id),
      },
    });
  } catch (error) {
    console.error("Chat route error:", error);
    const message = error instanceof Error ? error.message : String(error);
    return new Response(`Something went wrong: ${message}`, { status: 500 });
  }
}
