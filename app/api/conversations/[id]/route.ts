import { prisma } from "@/lib/prisma";

type RouteContext = {
  params: Promise<{
    id: string;
  }>;
};

export async function GET(_: Request, context: RouteContext) {
  try {
    const params = await context.params;
    const id = Number(params.id);

    if (Number.isNaN(id)) {
      return Response.json(
        { error: "Invalid conversation id." },
        { status: 400 }
      );
    }

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

    return Response.json({ conversation });
  } catch (error) {
    console.error("Error fetching conversation:", error);
    return Response.json(
      { error: "Failed to fetch conversation." },
      { status: 500 }
    );
  }
}

export async function DELETE(_: Request, context: RouteContext) {
  try {
    const params = await context.params;
    const id = Number(params.id);

    if (Number.isNaN(id)) {
      return Response.json(
        { error: "Invalid conversation id." },
        { status: 400 }
      );
    }

    await prisma.message.deleteMany({
      where: {
        conversationId: id,
      },
    });

    await prisma.conversation.delete({
      where: {
        id,
      },
    });

    return Response.json({ success: true });
  } catch (error) {
    console.error("Error deleting conversation:", error);
    return Response.json(
      { error: "Failed to delete conversation." },
      { status: 500 }
    );
  }
}