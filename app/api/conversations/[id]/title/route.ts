import OpenAI from "openai";
import { prisma } from "@/lib/prisma";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

type RouteContext = {
  params: Promise<{
    id: string;
  }>;
};

function extractUserText(content: string): string {
  try {
    const parsed = JSON.parse(content);
    if (typeof parsed?.text === "string" && parsed.text.trim()) {
      return parsed.text.trim();
    }
    return content;
  } catch {
    return content;
  }
}

function fallbackTitleFromQuestion(question: string): string {
  const cleaned = question.replace(/\s+/g, " ").trim();
  if (!cleaned) return "New Chat";
  return cleaned.length > 40 ? `${cleaned.slice(0, 40).trim()}...` : cleaned;
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const params = await context.params;
    const id = Number(params.id);

    if (Number.isNaN(id)) {
      return Response.json(
        { error: "Invalid conversation id." },
        { status: 400 }
      );
    }

    const body = await request.json().catch(() => ({}));
    const fallbackQuestionFromFrontend =
      typeof body?.question === "string" ? body.question : "";

    const conversation = await prisma.conversation.findUnique({
      where: { id },
      include: {
        messages: {
          orderBy: {
            createdAt: "asc",
          },
        },
      },
    });

    if (!conversation) {
      return Response.json(
        { error: "Conversation not found." },
        { status: 404 }
      );
    }

    const firstUserMessage = conversation.messages.find(
      (message) => message.role === "user"
    );

    const firstQuestion =
      (firstUserMessage && extractUserText(firstUserMessage.content)) ||
      fallbackQuestionFromFrontend ||
      "New Chat";

    let generatedTitle = fallbackTitleFromQuestion(firstQuestion);

    try {
      const completion = await client.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              "Generate a very short conversation title. " +
              "Return only the title text, no quotes, no punctuation at the end unless necessary. " +
              "Keep it under 6 words. Make it natural and specific.",
          },
          {
            role: "user",
            content: firstQuestion,
          },
        ],
      });

      const aiTitle = completion.choices?.[0]?.message?.content?.trim();

      if (aiTitle) {
        generatedTitle = aiTitle
          .replace(/^["']|["']$/g, "")
          .replace(/\.$/, "")
          .replace(/\n/g, "")
          .trim();
      }
    } catch (error) {
      console.error("AI title generation failed, using fallback:", error);
    }

    const updatedConversation = await prisma.conversation.update({
      where: { id },
      data: {
        title: generatedTitle || "New Chat",
      },
    });

    return Response.json({
      success: true,
      conversation: updatedConversation,
    });
  } catch (error) {
    console.error("Error generating conversation title:", error);
    return Response.json(
      { error: "Failed to generate conversation title." },
      { status: 500 }
    );
  }
}