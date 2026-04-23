-- CreateTable
CREATE TABLE "QuranVerse" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "surahNumber" INTEGER NOT NULL,
    "surahName" TEXT NOT NULL,
    "ayahNumber" INTEGER NOT NULL,
    "arabicText" TEXT NOT NULL,
    "translation" TEXT NOT NULL
);
