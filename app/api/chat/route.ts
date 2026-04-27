import OpenAI from "openai";
import { prisma } from "@/lib/prisma";
import path from "path";

export const runtime = "nodejs";

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
    case ".docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case ".pptx":
      return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    case ".xlsx":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    default:
      return "application/octet-stream";
  }
}

function attachmentToDataUrl(attachment: StoredAttachment) {
  const base64 = cleanBase64(attachment.base64);
  if (!base64) return "";
  return `data:${getAttachmentMimeType(attachment)};base64,${base64}`;
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
    /^draw\b/,
    /^illustrate\b/,
    /^produce an image\b/,
    /^show me an image of\b/,
    /^make me an image of\b/,
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

async function assistantMessageToHistory(
  content: string
): Promise<ChatHistoryMessage[]> {
  const parsed = parseStoredAssistantPayload(content);

  if (parsed?.type === "image" && typeof parsed.imageUrl === "string") {
    const assistantText =
      typeof parsed.text === "string" && parsed.text.trim()
        ? parsed.text.trim()
        : "Here is your generated image.";

    const history: ChatHistoryMessage[] = [
      { role: "assistant", content: assistantText },
    ];

    if (parsed.imageUrl.startsWith("data:image/")) {
      history.push({
        role: "user",
        content: [
          {
            type: "text",
            text:
              "Reference from earlier in this same conversation: this is the previously generated image. " +
              "Use it when answering follow-up questions about 'this image', 'that image', or similar references.",
          },
          { type: "image_url", image_url: { url: parsed.imageUrl } },
        ],
      });
    }

    return history;
  }

  return [{ role: "assistant", content }];
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
    "Maintain conversational continuity and use the recent chat history carefully. " +
    "For Islamic questions, ALWAYS include at least one directly relevant Quran reference when a relevant ayah exists. " +
    "Do not invent ayah wording. If you are not fully sure of exact wording, give only the Quran reference and a brief paraphrase. " +
    "When citing Quran, use this exact parseable format on its own line after the explanation: Quran 2:153 — Indeed, Allah is with the patient. " +
    "You may include multiple Quran citation lines, but keep each as: Quran SURAH:AYAH — short English meaning. " +
    "For questions about patience/sabr, strongly consider Quran 2:153, Quran 2:155-157, Quran 3:200, Quran 39:10, and Quran 103:1-3 when relevant. " +
    "If the user provides image attachments, analyze the visible contents directly. " +
    "If the user provides uploaded files, read the attached file content directly. Do not claim you cannot access the file when file input is present. " +
    "For time-sensitive questions, use the runtime date context below instead of guessing from stale model knowledge. " +
    `Current runtime ISO date/time: ${dateContext.isoDate}. ` +
    `Current UTC year: ${dateContext.utcYear}. ` +
    `Current local year: ${dateContext.localYear}. ` +
    `Current UTC date string: ${dateContext.prettyUtc}. ` +
    `Current local date string: ${dateContext.prettyLocal}. ` +
    "Be clear, helpful, and reasonably concise."
  );
}

async function buildUserContent(
  text: string,
  attachments: StoredAttachment[] = []
): Promise<string | ChatContentPart[]> {
  const parts: ChatContentPart[] = [
    { type: "text", text: text || "Please analyze the attachment." },
  ];

  for (const attachment of attachments) {
    if (!isImageAttachment(attachment)) continue;

    const dataUrl = attachmentToDataUrl(attachment);
    if (!dataUrl) continue;

    parts.push({ type: "image_url", image_url: { url: dataUrl } });
  }

  if (parts.length === 1 && parts[0].type === "text") {
    return parts[0].text;
  }

  return parts;
}

async function answerWithFilesUsingResponsesAPI(args: {
  question: string;
  attachments: StoredAttachment[];
  conversationId: number;
}) {
  const { question, attachments, conversationId } = args;

  const content: any[] = [
    {
      type: "input_text",
      text: question || "Please summarize the uploaded file.",
    },
  ];

  for (const attachment of attachments) {
    const base64 = cleanBase64(attachment.base64);
    if (!base64) {
      console.warn("Skipping attachment without inline base64:", attachment.name);
      continue;
    }

    const mimeType = getAttachmentMimeType(attachment);
    const filename = attachment.name || `uploaded${getAttachmentExtension(attachment) || ".file"}`;

    if (mimeType.startsWith("image/")) {
      content.push({
        type: "input_image",
        image_url: `data:${mimeType};base64,${base64}`,
      });
    } else {
      content.push({
        type: "input_file",
        filename,
        file_data: `data:${mimeType};base64,${base64}`,
      });
    }
  }

  if (content.length === 1) {
    return "I received the file bubble, but the actual file content was not sent. Please re-upload the file in a new chat and try again.";
  }

  const response = await client.responses.create({
    model: "gpt-4o",
    instructions: buildSystemPrompt(),
    input: [
      {
        role: "user",
        content,
      },
    ],
  } as any);

  const outputText = (response as any).output_text;

  if (typeof outputText === "string" && outputText.trim()) {
    return outputText.trim();
  }

  const output = (response as any).output;
  const fallback = Array.isArray(output)
    ? output
        .flatMap((item: any) => item?.content || [])
        .map((part: any) => part?.text || part?.content || "")
        .filter(Boolean)
        .join("\n")
        .trim()
    : "";

  return fallback || "I could not extract a response from the uploaded file.";
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const {
      question = "",
      conversationId,
      attachments = [],
      regenerate = false,
    } = body ?? {};

    if (
      !question?.trim() &&
      (!Array.isArray(attachments) || attachments.length === 0)
    ) {
      return new Response("Question or attachment is required.", { status: 400 });
    }

    const normalizedAttachments: StoredAttachment[] = Array.isArray(attachments)
      ? attachments
      : [];

    console.log(
      "CHAT ATTACHMENTS SUMMARY:",
      normalizedAttachments.map((a) => ({
        name: a.name,
        kind: a.kind,
        type: a.type,
        mimeType: a.mimeType,
        hasBase64: Boolean(a.base64),
        base64Length: a.base64 ? cleanBase64(a.base64).length : 0,
        previewUrl: a.previewUrl,
      }))
    );

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
            attachments: normalizedAttachments,
          }),
        },
      });
    }

    if (shouldGenerateImage(question, normalizedAttachments)) {
      const prompt = cleanImagePrompt(question) || question.trim();

      const result = await client.images.generate({
        model: "gpt-image-1",
        prompt,
        size: "1024x1024",
      });

      const imageBase64 = result.data?.[0]?.b64_json;
      if (!imageBase64) throw new Error("Image generation returned no image data.");

      const imageDataUrl = `data:image/png;base64,${imageBase64}`;
      const assistantPayload = {
        type: "image",
        text: "Here is your generated image.",
        imageUrl: imageDataUrl,
      };

      await prisma.message.create({
        data: {
          conversationId: conversation.id,
          role: "assistant",
          content: JSON.stringify(assistantPayload),
        },
      });

      return Response.json(
        {
          answer: assistantPayload.text,
          imageUrl: assistantPayload.imageUrl,
          conversationId: conversation.id,
        },
        { headers: { "X-Conversation-Id": String(conversation.id) } }
      );
    }

    const hasFileAttachment = normalizedAttachments.some(
      (a) => a.kind === "file" || (!isImageAttachment(a) && Boolean(a.base64))
    );

    if (hasFileAttachment) {
      const answer = await answerWithFilesUsingResponsesAPI({
        question,
        attachments: normalizedAttachments,
        conversationId: conversation.id,
      });

      await prisma.message.create({
        data: {
          conversationId: conversation.id,
          role: "assistant",
          content: answer,
        },
      });

      return new Response(answer, {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "X-Conversation-Id": String(conversation.id),
        },
      });
    }

    const recentMessagesDesc = await prisma.message.findMany({
      where: { conversationId: conversation.id },
      orderBy: { createdAt: "desc" },
      take: 18,
    });

    let recentMessages = recentMessagesDesc.reverse();
    if (regenerate && recentMessages.at(-1)?.role === "assistant") {
      recentMessages = recentMessages.slice(0, -1);
    }

    const historyMessages: ChatHistoryMessage[] = [];
    for (const msg of recentMessages) {
      if (msg.role === "user") {
        const parsed = parseUserMessageContent(msg.content);
        historyMessages.push({
          role: "user",
          content: await buildUserContent(parsed.text, parsed.attachments),
        });
      } else {
        const expandedAssistantHistory = await assistantMessageToHistory(msg.content);
        historyMessages.push(...expandedAssistantHistory);
      }
    }

    const messages: ChatHistoryMessage[] = [
      { role: "system", content: buildSystemPrompt() },
      ...historyMessages,
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
