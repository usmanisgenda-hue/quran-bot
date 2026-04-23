import { PrismaClient } from "@prisma/client";
import fs from "fs";
import path from "path";

const prisma = new PrismaClient();

async function main() {
  const filePath = path.join(process.cwd(), "data", "quran-verses.json");

  const fileContent = fs.readFileSync(filePath, "utf-8");
  const verses = JSON.parse(fileContent);

  console.log("Clearing old verses...");
  await prisma.quranVerse.deleteMany();

  console.log("Inserting new verses...");
  await prisma.quranVerse.createMany({
    data: verses,
  });

  console.log(`✅ Imported ${verses.length} verses successfully.`);
}

main()
  .catch((e) => {
    console.error("❌ Import failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });