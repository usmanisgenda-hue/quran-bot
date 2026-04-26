import OpenAI from "openai";
import { prisma } from "@/lib/prisma";
import fs from "fs/promises";
import path from "path";

function getAbsoluteUploadPath(previewUrl: string) {
  return path.join(process.cwd(), "public", previewUrl);
}

async function extractTextFromFile(previewUrl: string) {
  const absolutePath = getAbsoluteUploadPath(previewUrl);
  const ext = path.extname(absolutePath).toLowerCase();

  const fileBuffer = await fs.readFile(absolutePath);

  if (ext === ".pdf") {
    const req = eval("require");
    const pdfParse = req("pdf-parse");
    const result = await pdfParse(fileBuffer);
    return (result?.text || "").trim();
  }

  if ([".pptx", ".docx", ".xlsx"].includes(ext)) {
    const req = eval("require");
    const officeParser = req("officeparser");
    const text = await officeParser.parseOfficeAsync(absolutePath);
    return String(text || "").trim();
  }

  if ([".txt", ".md", ".csv"].includes(ext)) {
    return fileBuffer.toString("utf8").trim();
  }

  return "";
}
export const runtime = "nodejs";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

type StoredAttachment = {
  id?: string;
  name?: string;
  kind?: "image" | "file";
  previewUrl?: string;
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
    return {
      text: content,
      attachments: [],
    };
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
    if (parsed && typeof parsed === "object") return parsed;
    return null;
  } catch {
    return null;
  }
}

function getMimeType(filePath: string) {
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
    default:
      return "application/octet-stream";
  }
}



async function filePathToDataUrl(filePath: string) {
  const fileBuffer = await fs.readFile(filePath);
  const mimeType = getMimeType(filePath);
  const base64 = fileBuffer.toString("base64");
  return `data:${mimeType};base64,${base64}`;
}

async function imagePreviewToDataUrl(previewUrl: string) {
  const absolutePath = getAbsoluteUploadPath(previewUrl);
  return filePathToDataUrl(absolutePath);
}

async function extractTextFromPdf(previewUrl: string) {
  const absolutePath = getAbsoluteUploadPath(previewUrl);
  const fileBuffer = await fs.readFile(absolutePath);

  const req = eval("require");
  const pdfParse = req("pdf-parse");
  const textResult = await pdfParse(fileBuffer);

  return (textResult?.text || "").trim();
}

async function buildUserContent(
  text: string,
  attachments: StoredAttachment[] = []
): Promise<string | ChatContentPart[]> {
  const imageAttachments = attachments.filter(
    (attachment) =>
      attachment.kind === "image" && typeof attachment.previewUrl === "string"
  );

  const fileAttachments = attachments.filter(
    (attachment) =>
      attachment.kind === "file" && typeof attachment.previewUrl === "string"
  );

  let pdfContext = "";

  for (const attachment of fileAttachments) {
    if (!attachment.previewUrl) continue;

    try {
      const pdfText = await extractTextFromPdf(attachment.previewUrl);

      if (pdfText) {
        const limitedPdfText = pdfText.slice(0, 12000);
        const wasTrimmed = pdfText.length > 12000;

        pdfContext += `\n\n--- PDF: ${attachment.name || "attached file"} ---\n${limitedPdfText}${
          wasTrimmed ? "\n\n[PDF text truncated]" : ""
        }`;
      }
    } catch (error) {
      console.error(
        "Failed to read file attachment:",
        attachment.previewUrl,
        error
      );
    }
  }

  const finalText = [
    pdfContext.trim() ? `PDF CONTENT:\n${pdfContext.trim()}` : "",
    `USER QUESTION:\n${text || "Please analyze the attachment."}`,
  ]
    .filter(Boolean)
    .join("\n\n")
    .trim();

  if (imageAttachments.length === 0) {
    return finalText;
  }

  const parts: ChatContentPart[] = [{ type: "text", text: finalText }];

  for (const attachment of imageAttachments) {
    if (!attachment.previewUrl) continue;

    try {
      const dataUrl = await imagePreviewToDataUrl(attachment.previewUrl);

      parts.push({
        type: "image_url",
        image_url: { url: dataUrl },
      });
    } catch (error) {
      console.error(
        "Failed to prepare image attachment:",
        attachment.previewUrl,
        error
      );
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

async function saveBase64ImageToPublic(base64: string) {
  const uploadDir = path.join(process.cwd(), "public", "uploads");
  await fs.mkdir(uploadDir, { recursive: true });

  const fileName = `generated-${Date.now()}.png`;
  const absolutePath = path.join(uploadDir, fileName);

  await fs.writeFile(absolutePath, Buffer.from(base64, "base64"));

  return `/uploads/${fileName}`;
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
      {
        role: "assistant",
        content: assistantText,
      },
    ];

    try {
      const dataUrl = parsed.imageUrl.startsWith("data:image/")
        ? parsed.imageUrl
        : await imagePreviewToDataUrl(parsed.imageUrl);

      history.push({
        role: "user",
        content: [
          {
            type: "text",
            text:
              "Reference from earlier in this same conversation: this is the previously generated image. " +
              "Use it when answering follow-up questions about 'this image', 'that image', or similar references.",
          },
          {
            type: "image_url",
            image_url: { url: dataUrl },
          },
        ],
      });
    } catch (error) {
      console.error(
        "Failed to rehydrate generated image for history:",
        parsed.imageUrl,
        error
      );

      history.push({
        role: "assistant",
        content: `${assistantText}\n\n![Generated image](${parsed.imageUrl})`,
      });
    }

    return history;
  }

  return [
    {
      role: "assistant",
      content,
    },
  ];
}

function buildRealtimeDateContext() {
  const now = new Date();

  const isoDate = now.toISOString();
  const utcYear = now.getUTCFullYear();
  const localYear = now.getFullYear();

  const prettyUtc = now.toUTCString();
  const prettyLocal = now.toLocaleString("en-CA", {
    dateStyle: "full",
    timeStyle: "long",
  });

  return {
    isoDate,
    utcYear,
    localYear,
    prettyUtc,
    prettyLocal,
  };
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
      return new Response("Question or attachment is required.", {
        status: 400,
      });
    }

    let conversation =
      typeof conversationId === "number"
        ? await prisma.conversation.findUnique({
            where: { id: conversationId },
          })
        : null;

    if (!conversation) {
      conversation = await prisma.conversation.create({
        data: {
          title: "New Chat",
        },
      });
    }

    if (!regenerate) {
      await prisma.message.create({
        data: {
          conversationId: conversation.id,
          role: "user",
          content: JSON.stringify({
            text: question,
            attachments,
          }),
        },
      });
    }

    if (shouldGenerateImage(question, attachments)) {
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

      // Railway/Next deployments often do NOT reliably serve files written
      // into /public at runtime. Return a data URL directly so the browser
      // can render the generated image immediately.
      const imageDataUrl = `data:image/png;base64,${imageBase64}`;

      const assistantPayload = {
        type: "image",
        text: "Here is your generated image.",
        imageUrl: imageDataUrl,
      };

      const assistantMarkdown = `${assistantPayload.text}\n\n![Generated image](${assistantPayload.imageUrl})`;

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
        {
          headers: {
            "X-Conversation-Id": String(conversation.id),
          },
        }
      );
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
        const expandedAssistantHistory = await assistantMessageToHistory(
          msg.content
        );
        historyMessages.push(...expandedAssistantHistory);
      }
    }

    const dateContext = buildRealtimeDateContext();

    const messages: ChatHistoryMessage[] = [
      {
        role: "system",
        content:
          "You are Quran Assist, a respectful and knowledgeable Islamic assistant. " +
          "Maintain conversational continuity and use the recent chat history carefully. " +
          "For Islamic questions, ALWAYS include at least one directly relevant Quran reference when a relevant ayah exists. " +
          "Do not invent ayah wording. If you are not fully sure of the exact Arabic or English wording, give the Quran reference followed by a clearly marked short meaning after the dash. " +
          "When citing Quran, use this exact parseable format on its own line after the explanation: Quran 2:153 — O you who have believed, seek help through patience and prayer. Indeed, Allah is with the patient. The text after the dash must be the English ayah text or a short accurate English meaning, not just the reference. " +
          "You may include multiple Quran citation lines, but keep each as: Quran SURAH:AYAH — short English meaning. " +
          "For questions about patience/sabr, strongly consider Quran 2:153, Quran 2:155-157, Quran 3:200, Quran 39:10, and Quran 103:1-3 when relevant. " +
          "For questions about prayer/salah, cite directly relevant Quran references when applicable, such as Quran 2:43, Quran 4:103, or Quran 29:45. " +
          "For questions about hardship, trials, forgiveness, repentance, modesty, parents, character, or worship, include a relevant Quran reference when applicable. " +
          "If a prior generated image is included as a reference in the conversation history, use it directly to answer follow-up questions about that image. " +
          "If the user says 'this image', 'that image', or similar, first check whether a referenced image from earlier in the same conversation is present. " +
          "If the user provides image attachments, analyze the visible contents directly. " +
          "If the user provides a PDF, use the extracted PDF text to answer. " +
          "Do not claim you cannot view an image when an image is present in the conversation context. " +
          "For time-sensitive questions, use the runtime date context below instead of guessing from stale model knowledge. " +
          `Current runtime ISO date/time: ${dateContext.isoDate}. ` +
          `Current UTC year: ${dateContext.utcYear}. ` +
          `Current local year: ${dateContext.localYear}. ` +
          `Current UTC date string: ${dateContext.prettyUtc}. ` +
          `Current local date string: ${dateContext.prettyLocal}. ` +
          "Be clear, helpful, and reasonably concise.",
      },
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