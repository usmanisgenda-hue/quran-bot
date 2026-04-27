import { NextResponse } from "next/server";
import { mkdir, writeFile } from "fs/promises";
import path from "path";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const formData = await req.formData();
    const file = formData.get("file");

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "No file uploaded" }, { status: 400 });
    }

    const bytes = await file.arrayBuffer();
    const buffer = Buffer.from(bytes);

    const uploadsDir = path.join(process.cwd(), "public", "uploads");
    await mkdir(uploadsDir, { recursive: true });

    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
    const filename = `${Date.now()}-${safeName}`;
    const filePath = path.join(uploadsDir, filename);

    // This preview URL is only for UI display. The chat route uses base64 instead,
    // because Railway's filesystem is not reliable between requests/deploys.
    await writeFile(filePath, buffer).catch((error) => {
      console.warn("Preview file save failed; continuing with base64 upload:", error);
    });

    return NextResponse.json({
      url: `/uploads/${filename}`,
      name: file.name,
      type: file.type || "application/octet-stream",
      size: file.size,
      base64: buffer.toString("base64"),
    });
  } catch (error) {
    console.error("Upload failed:", error);
    return NextResponse.json({ error: "Upload failed" }, { status: 500 });
  }
}

