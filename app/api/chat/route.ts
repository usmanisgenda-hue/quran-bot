import OpenAI from "openai";
import { prisma } from "@/lib/prisma";
import fs from "fs/promises";
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
  url?: string;
  type?: string;
  mimeType?: string;
  base64?: string;
  size?: number;
};

type ClientHistoryItem = {
  question?: string;
  answer?: string;
  imageUrl?: string;
  attachments?: StoredAttachment[];
};

type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

type ChatHistoryMessage = {
  role: "system" | "user" | "assistant";
  content: string | ChatContentPart[];
};

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

function parseStoredAssistantPayload(content: string): {
  type?: string;
  text?: string;
  imageUrl?: string;
} | null {
  const trimmed = content.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;

  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object") return parsed;
  } catch {}

  return null;
}

function getMimeTypeFromPath(filePath: string) {
  const ext = path.extname(filePath).toLowerCase();
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
    default:
      return "application/octet-stream";
  }
}

function getAttachmentMimeType(attachment: StoredAttachment) {
  return (
    attachment.mimeType ||
    attachment.type ||
    (attachment.name ? getMimeTypeFromPath(attachment.name) : "application/octet-stream")
  );
}

function getAbsoluteUploadPath(previewUrl: string) {
  const normalized = previewUrl.startsWith("/") ? previewUrl.slice(1) : previewUrl;
  return path.join(process.cwd(), "public", normalized);
}

async function filePathToDataUrl(filePath: string) {
  const fileBuffer = await fs.readFile(filePath);
  const mimeType = getMimeTypeFromPath(filePath);
  const base64 = fileBuffer.toString("base64");
  return `data:${mimeType};base64,${base64}`;
}

async function saveGeneratedImage(base64: string) {
  const generatedDir = path.join(process.cwd(), "public", "generated");
  await fs.mkdir(generatedDir, { recursive: true });

  const fileName = `quran-assist-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}.png`;
  const filePath = path.join(generatedDir, fileName);

  await fs.writeFile(filePath, Buffer.from(base64, "base64"));
  return `/generated/${fileName}`;
}

async function saveGeneratedImageFromUrl(remoteUrl: string) {
  const response = await fetch(remoteUrl);

  if (!response.ok) {
    throw new Error(`Could not download generated image: ${response.status} ${response.statusText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const generatedDir = path.join(process.cwd(), "public", "generated");
  await fs.mkdir(generatedDir, { recursive: true });

  const fileName = `quran-assist-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}.png`;
  const filePath = path.join(generatedDir, fileName);

  await fs.writeFile(filePath, Buffer.from(arrayBuffer));
  return `/generated/${fileName}`;
}

async function generateAndSaveImage(prompt: string) {
  let firstError: unknown = null;

  try {
    const result = await client.images.generate({
      model: "gpt-image-1",
      prompt,
      size: "1024x1024",
    });

    const imageBase64 = result.data?.[0]?.b64_json;
    const remoteUrl = (result.data?.[0] as any)?.url as string | undefined;

    if (imageBase64) return saveGeneratedImage(imageBase64);
    if (remoteUrl) return saveGeneratedImageFromUrl(remoteUrl);

    throw new Error("gpt-image-1 returned no b64_json or url.");
  } catch (error) {
    firstError = error;
    console.error("gpt-image-1 failed, trying dall-e-3:", error);
  }

  try {
    const fallback = await client.images.generate({
      model: "dall-e-3",
      prompt,
      size: "1024x1024",
      response_format: "url",
    });

    const imageBase64 = fallback.data?.[0]?.b64_json;
    const remoteUrl = (fallback.data?.[0] as any)?.url as string | undefined;

    if (imageBase64) return saveGeneratedImage(imageBase64);
    if (remoteUrl) return saveGeneratedImageFromUrl(remoteUrl);

    throw new Error("dall-e-3 returned no b64_json or url.");
  } catch (fallbackError) {
    console.error("dall-e-3 failed:", fallbackError);
    throw new Error(
      `Image generation failed. First error: ${
        firstError instanceof Error ? firstError.message : String(firstError)
      }. Fallback error: ${
        fallbackError instanceof Error ? fallbackError.message : String(fallbackError)
      }`
    );
  }
}

function attachmentToDataUrl(attachment: StoredAttachment) {
  if (attachment.base64) {
    if (attachment.base64.startsWith("data:")) return attachment.base64;
    return `data:${getAttachmentMimeType(attachment)};base64,${attachment.base64}`;
  }
  return null;
}

async function imageAttachmentToDataUrl(attachment: StoredAttachment) {
  const inlineDataUrl = attachmentToDataUrl(attachment);
  if (inlineDataUrl) return inlineDataUrl;

  const preview = attachment.previewUrl || attachment.url;
  if (!preview) throw new Error("Image attachment has no previewUrl or base64 data.");
  if (preview.startsWith("data:")) return preview;
  if (/^https?:\/\//i.test(preview)) return preview;

  return filePathToDataUrl(getAbsoluteUploadPath(preview));
}

async function extractTextFromPdfAttachment(attachment: StoredAttachment) {
  const req = eval("require");
  const pdfParse = req("pdf-parse");

  let fileBuffer: Buffer;

  if (attachment.base64) {
    const rawBase64 = attachment.base64.includes(",")
      ? attachment.base64.split(",").pop() || ""
      : attachment.base64;
    fileBuffer = Buffer.from(rawBase64, "base64");
  } else {
    const preview = attachment.previewUrl || attachment.url;
    if (!preview) return "";
    if (preview.startsWith("data:")) {
      const rawBase64 = preview.split(",").pop() || "";
      fileBuffer = Buffer.from(rawBase64, "base64");
    } else {
      fileBuffer = await fs.readFile(getAbsoluteUploadPath(preview));
    }
  }

  const textResult = await pdfParse(fileBuffer);
  return (textResult?.text || "").trim();
}

async function buildUserContent(
  text: string,
  attachments: StoredAttachment[] = []
): Promise<string | ChatContentPart[]> {
  const imageAttachments = attachments.filter((attachment) => {
    const mime = getAttachmentMimeType(attachment);
    return attachment.kind === "image" || mime.startsWith("image/");
  });

  const fileAttachments = attachments.filter((attachment) => {
    const mime = getAttachmentMimeType(attachment);
    return attachment.kind === "file" || mime === "application/pdf" || /\.pdf$/i.test(attachment.name || "");
  });

  let fileContext = "";

  for (const attachment of fileAttachments) {
    try {
      const pdfText = await extractTextFromPdfAttachment(attachment);
      if (pdfText) {
        const limitedPdfText = pdfText.slice(0, 12000);
        const wasTrimmed = pdfText.length > 12000;
        fileContext += `\n\n--- FILE: ${attachment.name || "attached file"} ---\n${limitedPdfText}${
          wasTrimmed ? "\n\n[File text truncated]" : ""
        }`;
      }
    } catch (error) {
      console.error("Failed to read file attachment:", attachment.name, error);
      fileContext += `\n\n--- FILE: ${attachment.name || "attached file"} ---\n[Could not extract readable text from this file.]`;
    }
  }

  const finalText = [
    fileContext.trim() ? `ATTACHED FILE CONTENT:\n${fileContext.trim()}` : "",
    `USER QUESTION:\n${text || "Please analyze the attachment."}`,
  ]
    .filter(Boolean)
    .join("\n\n")
    .trim();

  if (imageAttachments.length === 0) return finalText;

  const parts: ChatContentPart[] = [{ type: "text", text: finalText }];

  for (const attachment of imageAttachments) {
    try {
      const dataUrl = await imageAttachmentToDataUrl(attachment);
      parts.push({ type: "image_url", image_url: { url: dataUrl } });
    } catch (error) {
      console.error("Failed to prepare image attachment:", attachment.name, error);
    }
  }

  return parts;
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

function markdownImageUrl(text: string) {
  const match = text.match(/!\[[^\]]*\]\(([^)]+)\)/);
  return match?.[1] || "";
}

async function assistantMessageToHistory(content: string): Promise<ChatHistoryMessage[]> {
  const parsed = parseStoredAssistantPayload(content);

  if (parsed?.type === "image" && typeof parsed.imageUrl === "string") {
    const assistantText =
      typeof parsed.text === "string" && parsed.text.trim()
        ? parsed.text.trim()
        : "Here is your generated image.";

    const history: ChatHistoryMessage[] = [{ role: "assistant", content: assistantText }];

    try {
      const imageUrl = parsed.imageUrl.startsWith("data:")
        ? parsed.imageUrl
        : await imageAttachmentToDataUrl({ previewUrl: parsed.imageUrl, kind: "image" });

      history.push({
        role: "user",
        content: [
          {
            type: "text",
            text:
              "Reference from earlier in this same conversation: this is the previously generated image. " +
              "Use it when answering follow-up questions about this image.",
          },
          { type: "image_url", image_url: { url: imageUrl } },
        ],
      });
    } catch (error) {
      console.error("Failed to rehydrate generated image for history:", error);
      history.push({ role: "assistant", content: `${assistantText}\n\nImage URL: ${parsed.imageUrl}` });
    }

    return history;
  }

  const extractedImage = markdownImageUrl(content);
  if (extractedImage) {
    return assistantMessageToHistory(
      JSON.stringify({ type: "image", text: content.replace(/!\[[^\]]*\]\([^)]+\)/g, "").trim(), imageUrl: extractedImage })
    );
  }

  return [{ role: "assistant", content }];
}

function clientHistoryToMessages(history: ClientHistoryItem[] = []): ChatHistoryMessage[] {
  const messages: ChatHistoryMessage[] = [];

  for (const item of history.slice(-12)) {
    if (item.question) {
      messages.push({ role: "user", content: `USER QUESTION:\n${item.question}` });
    }
    if (item.answer || item.imageUrl) {
      messages.push({
        role: "assistant",
        content: [item.answer || "", item.imageUrl ? `Previously generated image URL: ${item.imageUrl}` : ""]
          .filter(Boolean)
          .join("\n\n"),
      });
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

function jsonResponse(data: unknown, conversationId: number, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "X-Conversation-Id": String(conversationId),
    },
  });
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
    }: {
      question?: string;
      conversationId?: number | null;
      attachments?: StoredAttachment[];
      regenerate?: boolean;
      history?: ClientHistoryItem[];
    } = body ?? {};

    const safeAttachments = Array.isArray(attachments) ? attachments : [];
    const safeQuestion = typeof question === "string" ? question : "";

    if (!safeQuestion.trim() && safeAttachments.length === 0) {
      return new Response("Question or attachment is required.", { status: 400 });
    }
    let conversation =
      typeof conversationId === "number"
        ? await prisma.conversation.findUnique({ where: { id: conversationId } })
        : null;

    if (!conversation) {
      conversation = await prisma.conversation.create({ data: { title: "New Chat" } });
    }

    if (!regenerate) {
      await prisma.message.create({
        data: {
          conversationId: conversation.id,
          role: "user",
          content: JSON.stringify({ text: safeQuestion, attachments: safeAttachments }),
        },
      });
    }

    if (shouldGenerateImage(safeQuestion, safeAttachments)) {
      try {
        const prompt = cleanImagePrompt(safeQuestion) || safeQuestion.trim();

        const imageUrl = await generateAndSaveImage(prompt);

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

        return jsonResponse(
          { answer: assistantPayload.text, imageUrl: assistantPayload.imageUrl },
          conversation.id
        );
      } catch (error) {
        console.error("Image generation failed:", error);
        const assistantText =
          "I couldn’t generate that image. The image request may have been rejected by the image model or the image API failed. Try a simpler, non-graphic prompt.";

        await prisma.message.create({
          data: {
            conversationId: conversation.id,
            role: "assistant",
            content: assistantText,
          },
        });

        return jsonResponse({ answer: assistantText, imageUrl: "" }, conversation.id);
      }
    }

    const recentMessagesDesc = await prisma.message.findMany({
      where: { conversationId: conversation.id },
      orderBy: { createdAt: "desc" },
      take: 18,
    });

    const recentMessages = recentMessagesDesc.reverse();
    const historyMessages: ChatHistoryMessage[] = [];

    for (const msg of recentMessages) {
      if (msg.role === "user") {
        const parsed = parseUserMessageContent(msg.content);
        historyMessages.push({
          role: "user",
          content: await buildUserContent(parsed.text, parsed.attachments),
        });
      } else if (msg.role === "assistant") {
        historyMessages.push(...(await assistantMessageToHistory(msg.content)));
      }
    }

    if (historyMessages.length === 0 && Array.isArray(history) && history.length > 0) {
      historyMessages.push(...clientHistoryToMessages(history));
    }

    const dateContext = buildRealtimeDateContext();

    const messages: ChatHistoryMessage[] = [
      {
        role: "system",
        content:
          "You are Quran Assist, a respectful and knowledgeable Islamic assistant. " +
          "Maintain conversational continuity and use the recent chat history carefully. " +
          "If a prior generated image is included as a reference in the conversation history, use it directly to answer follow-up questions about that image. " +
          "If the user says 'this image', 'that image', or similar, first check whether a referenced image from earlier in the same conversation is present. " +
          "If the user provides image attachments, analyze the visible contents directly. " +
          "If the user provides a PDF, use extracted PDF text when available. " +
          "Do not claim you cannot view an image when an image is present in the conversation context. " +
          `Current runtime ISO date/time: ${dateContext.isoDate}. ` +
          `Current UTC year: ${dateContext.utcYear}. ` +
          `Current local year: ${dateContext.localYear}. ` +
          `Current UTC date string: ${dateContext.prettyUtc}. ` +
          `Current local date string: ${dateContext.prettyLocal}. ` +
          "Be clear, helpful, and reasonably concise.",
      },
      ...historyMessages,
      ...(regenerate
        ? []
        : [
            {
              role: "user",
              content: await buildUserContent(safeQuestion, safeAttachments),
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
