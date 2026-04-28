"use client";
import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import {
  Mic,
  Square,
  Plus,
  Image as ImageIcon,
  FileText,
  Wand2,
  X,
  Copy,
  Pencil,
  RefreshCw,
  Download,
  Maximize2,
} from "lucide-react";

type ChatMessage = {
  question: string;
  answer: string;
  imageUrl?: string;
  attachments?: AttachmentChip[];
};

type ConversationSummary = {
  id: number;
  title: string | null;
  createdAt: string;
  updatedAt: string;
};

type DatabaseMessage = {
  id: number;
  role: string;
  content: string;
  createdAt: string;
  conversationId: number;
};


type AssistantPayload = {
  type?: string;
  text?: string;
  imageUrl?: string;
};

function parseAssistantPayload(content: string): AssistantPayload | null {
  try {
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === "object") return parsed;
    return null;
  } catch {
    return null;
  }
}

function extractImageUrlFromMarkdown(text: string) {
  const match = text.match(/!\[[^\]]*\]\(([^)]+)\)/);
  return match?.[1] || "";
}

function removeMarkdownImages(text: string) {
  return text.replace(/!\[[^\]]*\]\([^)]+\)/g, "").trim();
}

type AttachmentChip = {
  id: string;
  name: string;
  kind: "image" | "file";
  previewUrl?: string;
  type?: string;
  mimeType?: string;
  size?: number;
  base64?: string;
};

const ATTACHMENTS_STORAGE_KEY = "qa-pending-attachments";
const ACTIVE_CONVERSATION_STORAGE_KEY = "qa-active-conversation-id";
const CHAT_HISTORY_STORAGE_KEY = "qa-chat-history";

type QuranCitation = {
  surahName?: string;
  surah: string;
  ayah: string;
  quote?: string;
  arabic?: string;
  english?: string;
};

function extractQuranCitations(answer: string): {
  mainText: string;
  citations: QuranCitation[];
} {
  const citations: QuranCitation[] = [];
  let mainText = answer || "";

  const addCitation = (citation: QuranCitation) => {
    const alreadyExists = citations.some(
      (item) => item.surah === citation.surah && item.ayah === citation.ayah
    );
    if (!alreadyExists) citations.push(citation);
  };

  // Format: Quran 2:153 — O you who have believed...
  // This must run BEFORE the bare-reference matcher below.
  mainText = mainText.replace(
    /^\s*Quran\s+(\d+)\s*:\s*(\d+)\s*(?:—|-|–|:)\s*(.+?)\s*$/gim,
    (_match, surah, ayah, quote) => {
      const cleanedQuote = String(quote || "")
        .replace(/^[“\"]|[”\"]$/g, "")
        .trim();

      addCitation({
        surah: String(surah),
        ayah: String(ayah),
        quote: cleanedQuote,
        english: cleanedQuote,
      });
      return "";
    }
  );

  mainText = mainText.replace(
    /(?:from\s+)?Surah\s+([A-Za-z'’\-\s]+)\s*[\[(](\d+)\s*:\s*(\d+)[\])]\s*:?\s*[“\"]?([^“\"\n]+)?[”\"]?/gi,
    (_match, surahName, surah, ayah, quote) => {
      addCitation({
        surahName: String(surahName || "").trim(),
        surah: String(surah),
        ayah: String(ayah),
        quote: typeof quote === "string" ? quote.trim() : undefined,
        english: typeof quote === "string" ? quote.trim() : undefined,
      });
      return "";
    }
  );

  mainText = mainText.replace(
    /[“\"]([^“\"]+)[”\"]\s*\(?\s*Quran\s+(\d+)\s*:\s*(\d+)\s*\)?/gi,
    (_match, quote, surah, ayah) => {
      addCitation({
        surah: String(surah),
        ayah: String(ayah),
        quote: String(quote).trim(),
        english: String(quote).trim(),
      });
      return "";
    }
  );

  // Fallback: bare reference only. This keeps your gold bar even when the
  // model fails to provide ayah text.
  mainText = mainText.replace(
    /\(?\s*Quran\s+(\d+)\s*:\s*(\d+)\s*\)?/gi,
    (_match, surah, ayah) => {
      addCitation({ surah: String(surah), ayah: String(ayah) });
      return "";
    }
  );

  mainText = mainText
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\s+([,.!?;:])/g, "$1")
    .trim();

  return { mainText, citations };
}

function QuranCitationBar({ citation }: { citation: QuranCitation }) {
  const title = citation.surahName
    ? `Surah ${citation.surahName} (${citation.surah}:${citation.ayah})`
    : `Quran ${citation.surah}:${citation.ayah}`;

  return (
    <div className="border-l-2 border-[#d4af37]/70 py-3 pl-4">
      {citation.arabic && (
        <p className="mb-3 text-right text-2xl leading-loose text-[#ffe27a]">
          {citation.arabic}
        </p>
      )}

      {(citation.english || citation.quote) && (
        <p className="mb-2 text-sm italic leading-relaxed text-[#f8dc7a]">
          “{citation.english || citation.quote}”
        </p>
      )}

      <p className="text-xs font-black uppercase tracking-[0.28em] text-[#d4af37]">
        {title}
      </p>
    </div>
  );
}

function QuranReferencesBlock({ citations }: { citations: QuranCitation[] }) {
  if (citations.length === 0) return null;

  return (
    <div className="not-prose mt-5 space-y-3">
      {citations.map((citation, citationIndex) => (
        <QuranCitationBar
          key={`${citation.surah}:${citation.ayah}:${citationIndex}`}
          citation={citation}
        />
      ))}
    </div>
  );
}

function ChatGPTTypingIndicator() {
  return (
    <div className="not-prose flex items-center gap-2 py-1 text-[#f5d76e]/80">
      <div className="flex items-center gap-1.5">
        <span className="h-2 w-2 animate-bounce rounded-full bg-[#d4af37] [animation-delay:-0.3s]" />
        <span className="h-2 w-2 animate-bounce rounded-full bg-[#d4af37] [animation-delay:-0.15s]" />
        <span className="h-2 w-2 animate-bounce rounded-full bg-[#d4af37]" />
      </div>
      <span className="text-xs font-semibold uppercase tracking-[0.22em] text-[#d4af37]/70">
        Thinking
      </span>
    </div>
  );
}

function GeneratedImageCard({
  imageUrl,
  onCopy,
  onOpen,
  copied,
}: {
  imageUrl: string;
  onCopy: () => void;
  onOpen: () => void;
  copied: boolean;
}) {
  return (
    <div className="not-prose mt-5 overflow-hidden rounded-[1.75rem] border border-[#d4af37]/35 bg-[#041f1d]/80 shadow-[0_18px_60px_rgba(0,0,0,0.35),0_0_35px_rgba(212,175,55,0.12)] backdrop-blur">
      <div className="flex items-center justify-between border-b border-[#d4af37]/15 bg-gradient-to-r from-[#0b3a36]/95 via-[#0f4a43]/80 to-[#0b3a36]/95 px-4 py-3">
        <div>
          <p className="text-[11px] font-black uppercase tracking-[0.28em] text-[#d4af37]">
            Generated Image
          </p>
          <p className="mt-0.5 text-xs text-[#f7df8a]/75">
            Quran Assist visual result
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onCopy}
            className="flex h-9 w-9 items-center justify-center rounded-full border border-[#d4af37]/25 bg-[#062927]/80 text-[#f5d76e] transition hover:-translate-y-0.5 hover:border-[#f5d76e]/60 hover:bg-[#123f3b] hover:shadow-[0_0_18px_rgba(212,175,55,0.2)]"
            title="Copy image link"
          >
            {copied ? <span className="text-xs font-bold">✓</span> : <Copy size={15} />}
          </button>
          <button
            type="button"
            onClick={onOpen}
            className="flex h-9 w-9 items-center justify-center rounded-full border border-[#d4af37]/25 bg-[#062927]/80 text-[#f5d76e] transition hover:-translate-y-0.5 hover:border-[#f5d76e]/60 hover:bg-[#123f3b] hover:shadow-[0_0_18px_rgba(212,175,55,0.2)]"
            title="Open full image"
          >
            <Maximize2 size={15} />
          </button>

          <a
            href={imageUrl}
            download
            className="flex h-9 w-9 items-center justify-center rounded-full border border-[#d4af37]/25 bg-[#062927]/80 text-[#f5d76e] transition hover:-translate-y-0.5 hover:border-[#f5d76e]/60 hover:bg-[#123f3b] hover:shadow-[0_0_18px_rgba(212,175,55,0.2)]"
            title="Download image"
          >
            <Download size={15} />
          </a>
        </div>
      </div>

      <div className="relative bg-[radial-gradient(circle_at_top,rgba(212,175,55,0.18),transparent_35%),linear-gradient(135deg,rgba(4,31,29,0.92),rgba(2,18,17,0.95))] p-3">
        <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(120deg,transparent,rgba(255,224,130,0.08),transparent)]" />
        <img
          src={imageUrl}
          alt="Generated image"
          onClick={onOpen}
          className="relative cursor-zoom-in max-h-[560px] w-full rounded-2xl object-contain shadow-[0_14px_45px_rgba(0,0,0,0.35)]"
        />
      </div>
    </div>
  );
}

export default function Home() {
  const [question, setQuestion] = useState("");
  const [loading, setLoading] = useState(false);
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([]);
  const [conversationId, setConversationId] = useState<number | null>(null);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(true);

  const [editingConversationId, setEditingConversationId] = useState<number | null>(null);
  const [editingTitle, setEditingTitle] = useState("");

  const [editingPromptIndex, setEditingPromptIndex] = useState<number | null>(null);
  const [editingPromptText, setEditingPromptText] = useState("");

  const [streamBuffer, setStreamBuffer] = useState("");
  const [displayedAnswer, setDisplayedAnswer] = useState("");
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [fullscreenImage, setFullscreenImage] = useState<string | null>(null);

  const [isListening, setIsListening] = useState(false);
  const [autoSendAfterVoice, setAutoSendAfterVoice] = useState(false);

  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [attachments, setAttachments] = useState<AttachmentChip[]>([]);

  const bottomRef = useRef<HTMLDivElement | null>(null);
  const recognitionRef = useRef<any>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const addMenuRef = useRef<HTMLDivElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatHistory]);

  useEffect(() => {
    fetchConversations();
  }, []);

  useEffect(() => {
    try {
      const rawAttachments = localStorage.getItem(ATTACHMENTS_STORAGE_KEY);
      if (rawAttachments) {
        const parsedAttachments = JSON.parse(rawAttachments);
        if (Array.isArray(parsedAttachments)) {
          setAttachments(parsedAttachments);
        }
      }

      const savedConversationId = localStorage.getItem(ACTIVE_CONVERSATION_STORAGE_KEY);
      if (savedConversationId) {
        const parsedId = Number(savedConversationId);
        if (!Number.isNaN(parsedId)) {
          setConversationId(parsedId);
        }
      }

      const savedChatHistory = localStorage.getItem(CHAT_HISTORY_STORAGE_KEY);
      if (savedChatHistory) {
        const parsedHistory = JSON.parse(savedChatHistory);
        if (Array.isArray(parsedHistory)) {
          setChatHistory(parsedHistory);
        }
      }
    } catch (error) {
      console.error("Failed to restore chat session:", error);
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(
        ATTACHMENTS_STORAGE_KEY,
        JSON.stringify(attachments)
      );
    } catch (error) {
      console.error("Failed to persist attachments:", error);
    }
  }, [attachments]);

  useEffect(() => {
    try {
      if (conversationId === null) {
        localStorage.removeItem(ACTIVE_CONVERSATION_STORAGE_KEY);
      } else {
        localStorage.setItem(
          ACTIVE_CONVERSATION_STORAGE_KEY,
          String(conversationId)
        );
      }

      localStorage.setItem(
        CHAT_HISTORY_STORAGE_KEY,
        JSON.stringify(chatHistory)
      );
    } catch (error) {
      console.error("Failed to persist chat session:", error);
    }
  }, [conversationId, chatHistory]);

  useEffect(() => {
    if (!loading) return;
    if (displayedAnswer === streamBuffer) return;

    const interval = setInterval(() => {
      setDisplayedAnswer((prev) => {
        if (prev.length >= streamBuffer.length) return prev;
        return streamBuffer.slice(0, prev.length + 1);
      });
    }, 7);

    return () => clearInterval(interval);
  }, [streamBuffer, displayedAnswer, loading]);

  useEffect(() => {
    const handleOutsideClick = (event: MouseEvent) => {
      if (!addMenuRef.current) return;
      if (!addMenuRef.current.contains(event.target as Node)) {
        setAddMenuOpen(false);
      }
    };

    document.addEventListener("mousedown", handleOutsideClick);
    return () => {
      document.removeEventListener("mousedown", handleOutsideClick);
    };
  }, []);

  const playMicTone = (type: "start" | "stop") => {
    try {
      const AudioCtx =
        window.AudioContext || (window as any).webkitAudioContext;

      if (!AudioCtx) return;

      if (!audioContextRef.current) {
        audioContextRef.current = new AudioCtx();
      }

      const ctx = audioContextRef.current;
      const oscillator = ctx.createOscillator();
      const gainNode = ctx.createGain();

      oscillator.connect(gainNode);
      gainNode.connect(ctx.destination);

      oscillator.type = "sine";
      oscillator.frequency.value = type === "start" ? 880 : 660;

      gainNode.gain.setValueAtTime(0.001, ctx.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(0.06, ctx.currentTime + 0.01);
      gainNode.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.12);

      oscillator.start();
      oscillator.stop(ctx.currentTime + 0.12);
    } catch (error) {
      console.error("Mic tone failed:", error);
    }
  };

  useEffect(() => {
    if (typeof window === "undefined") return;

    const SpeechRecognition =
      (window as any).SpeechRecognition ||
      (window as any).webkitSpeechRecognition;

    if (!SpeechRecognition) return;

    const recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = "en-US";

    recognition.onstart = () => {
      setIsListening(true);
      playMicTone("start");
    };

    recognition.onend = () => {
      setIsListening(false);
      playMicTone("stop");
    };

    recognition.onresult = (event: any) => {
      let transcript = "";

      for (let i = 0; i < event.results.length; i++) {
        transcript += event.results[i][0].transcript;
      }

      const finalText = transcript.trim();
      setQuestion(finalText);

      const lastResult = event.results[event.results.length - 1];
      if (lastResult?.isFinal && finalText) {
        setAutoSendAfterVoice(true);
      }
    };

    recognition.onerror = () => {
      setIsListening(false);
    };

    recognitionRef.current = recognition;
  }, []);

  useEffect(() => {
    if (!autoSendAfterVoice) return;
    if (isListening) return;
    if (!question.trim()) return;
    if (loading) return;

    handleAsk();
    setAutoSendAfterVoice(false);
  }, [autoSendAfterVoice, isListening, question, loading]);

  async function fetchConversations() {
    try {
      const response = await fetch("/api/conversations");
      if (!response.ok) {
        throw new Error("Failed to fetch conversations");
      }

      const data = await response.json();
      setConversations(data.conversations ?? []);
    } catch (error) {
      console.error(error);
    }
  }

  async function openConversation(id: number) {
    try {
      const response = await fetch(`/api/conversations/${id}`);
      if (!response.ok) {
        throw new Error("Failed to fetch conversation");
      }

      const data = await response.json();
      const messages: DatabaseMessage[] = data.conversation.messages ?? [];

      const convertedHistory: ChatMessage[] = [];
      let pendingQuestion: { text: string; attachments: AttachmentChip[] } | null = null;

      for (const msg of messages) {
        if (msg.role === "user") {
          try {
            const parsed = JSON.parse(msg.content);
            pendingQuestion = {
              text: typeof parsed?.text === "string" ? parsed.text : msg.content,
              attachments: Array.isArray(parsed?.attachments) ? parsed.attachments : [],
            };
          } catch {
            pendingQuestion = {
              text: msg.content,
              attachments: [],
            };
          }
        } else if (msg.role === "assistant" && pendingQuestion !== null) {
          const assistantPayload = parseAssistantPayload(msg.content);
          const markdownImageUrl = extractImageUrlFromMarkdown(msg.content);

          convertedHistory.push({
            question: pendingQuestion.text,
            answer:
              assistantPayload?.text ||
              removeMarkdownImages(msg.content) ||
              msg.content,
            imageUrl: assistantPayload?.imageUrl || markdownImageUrl || undefined,
            attachments: pendingQuestion.attachments,
          });
          pendingQuestion = null;
        }
      }

      setConversationId(id);
      setChatHistory(convertedHistory);
      setStreamBuffer("");
      setDisplayedAnswer("");
      setEditingPromptIndex(null);
      setEditingPromptText("");
      setAddMenuOpen(false);
    } catch (error) {
      console.error(error);
    }
  }

  function startNewChat() {
    setConversationId(null);
    setChatHistory([]);
    setQuestion("");
    setStreamBuffer("");
    setDisplayedAnswer("");
    setEditingPromptIndex(null);
    setEditingPromptText("");
    setAddMenuOpen(false);
    setAttachments([]);
    localStorage.removeItem(ATTACHMENTS_STORAGE_KEY);
    localStorage.removeItem(ACTIVE_CONVERSATION_STORAGE_KEY);
    localStorage.removeItem(CHAT_HISTORY_STORAGE_KEY);
  }

  async function deleteConversation(id: number) {
    try {
      const response = await fetch(`/api/conversations/${id}`, {
        method: "DELETE",
      });

      if (!response.ok) {
        throw new Error("Failed to delete conversation");
      }

      if (conversationId === id) {
        setConversationId(null);
        setChatHistory([]);
        setStreamBuffer("");
        setDisplayedAnswer("");
        localStorage.removeItem(ACTIVE_CONVERSATION_STORAGE_KEY);
        localStorage.removeItem(CHAT_HISTORY_STORAGE_KEY);
      }

      await fetchConversations();
    } catch (error) {
      console.error(error);
    }
  }

  function beginRename(conversation: ConversationSummary) {
    setEditingConversationId(conversation.id);
    setEditingTitle(conversation.title || "");
  }

  function cancelRename() {
    setEditingConversationId(null);
    setEditingTitle("");
  }

  async function saveRename(id: number) {
    const title = editingTitle.trim();
    if (!title) return;

    try {
      const response = await fetch(`/api/conversations/${id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ title }),
      });

      if (!response.ok) {
        throw new Error("Failed to rename conversation");
      }

      await fetchConversations();
      setEditingConversationId(null);
      setEditingTitle("");
    } catch (error) {
      console.error(error);
    }
  }

  const handleCopy = async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 1400);
    } catch (error) {
      console.error("Copy failed:", error);
    }
  };

  const handleMicClick = () => {
    if (!recognitionRef.current) {
      alert("Speech recognition is not supported in this browser.");
      return;
    }

    if (isListening) {
      recognitionRef.current.stop();
      setAutoSendAfterVoice(false);
    } else {
      recognitionRef.current.start();
    }
  };

  const handleAsk = async () => {
  const q = question.trim();
  const outgoingAttachments = [...attachments];

  if ((!q && outgoingAttachments.length === 0) || loading) return;

  const effectiveQuestion =
    q || (outgoingAttachments.length > 0
      ? "Please analyze the attached image."
      : "");

  setLoading(true);
  setQuestion("");
  setStreamBuffer("");
  setDisplayedAnswer("");
  setEditingPromptIndex(null);
  setEditingPromptText("");
  setAddMenuOpen(false);

  setChatHistory((prev) => [
    ...prev,
    {
      question: effectiveQuestion,
      answer: "",
      attachments: outgoingAttachments,
    },
  ]);

  setAttachments([]);
  localStorage.removeItem(ATTACHMENTS_STORAGE_KEY);

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        question: effectiveQuestion,
        conversationId,
        attachments: outgoingAttachments,
        history: chatHistory.map((chat) => ({
          question: chat.question,
          answer: chat.answer,
          imageUrl: chat.imageUrl,
          attachments: chat.attachments ?? [],
        })),
      }),
    });

    if (!response.ok || !response.body) {
      const errorText = await response.text();
      console.error("API /api/chat failed:", response.status, errorText);
      throw new Error(`Request failed: ${response.status} ${errorText}`);
    }

    const streamedConversationId = response.headers.get("X-Conversation-Id");
    let createdNewConversation = false;

    if (streamedConversationId) {
      const parsedId = Number(streamedConversationId);
      if (!Number.isNaN(parsedId)) {
        if (conversationId === null) {
          createdNewConversation = true;
        }
        setConversationId(parsedId);
      }
    }

    const contentType = response.headers.get("Content-Type") || "";
    let finalAnswer = "";
    let finalImageUrl = "";

    if (contentType.includes("application/json")) {
      const data = await response.json();
      finalAnswer = data.answer || data.text || "";
      finalImageUrl = data.imageUrl || "";
      setStreamBuffer(finalAnswer);
      setDisplayedAnswer(finalAnswer);
    } else {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        finalAnswer += chunk;
        setStreamBuffer(finalAnswer);
      }

      finalImageUrl = extractImageUrlFromMarkdown(finalAnswer);
      finalAnswer = removeMarkdownImages(finalAnswer) || finalAnswer;
      setDisplayedAnswer(finalAnswer);
    }

    setChatHistory((prev) =>
      prev.map((chat, index) =>
        index === prev.length - 1
          ? { ...chat, answer: finalAnswer, imageUrl: finalImageUrl || undefined }
          : chat
      )
    );

    await fetchConversations();

    if (createdNewConversation && streamedConversationId) {
      fetch(`/api/conversations/${streamedConversationId}/title`, {
        method: "POST",
      })
        .then(() => fetchConversations())
        .catch((error) => console.error("Title generation failed:", error));
    }
  } catch (error) {
    console.error(error);
    setChatHistory((prev) =>
      prev.map((chat, index) =>
        index === prev.length - 1
          ? { ...chat, answer: "Something went wrong." }
          : chat
      )
    );
  } finally {
    setLoading(false);
    setStreamBuffer("");
    setDisplayedAnswer("");
  }
};

  const handleRegenerate = async () => {
    if (loading || !conversationId || chatHistory.length === 0) return;

    const lastChat = chatHistory[chatHistory.length - 1];
    const lastQuestion = lastChat.question;

    if (!lastQuestion.trim()) return;

    setLoading(true);
    setStreamBuffer("");
    setDisplayedAnswer("");

    setChatHistory((prev) =>
      prev.map((chat, index) =>
        index === prev.length - 1 ? { ...chat, answer: "", imageUrl: undefined } : chat
      )
    );

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          question: lastQuestion,
          conversationId,
          regenerate: true,
          attachments: lastChat.attachments ?? [],
          history: chatHistory.slice(0, -1).map((chat) => ({
            question: chat.question,
            answer: chat.answer,
            imageUrl: chat.imageUrl,
            attachments: chat.attachments ?? [],
          })),
        }),
      });

      if (!response.ok || !response.body) {
        const errorText = await response.text();
        console.error("API /api/chat regenerate failed:", response.status, errorText);
        throw new Error(`Regenerate failed: ${response.status} ${errorText}`);
      }

      const contentType = response.headers.get("Content-Type") || "";
      let finalAnswer = "";
      let finalImageUrl = "";

      if (contentType.includes("application/json")) {
        const data = await response.json();
        finalAnswer = data.answer || data.text || "";
        finalImageUrl = data.imageUrl || "";
        setStreamBuffer(finalAnswer);
        setDisplayedAnswer(finalAnswer);
      } else {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value, { stream: true });
          finalAnswer += chunk;
          setStreamBuffer(finalAnswer);
        }

        finalImageUrl = extractImageUrlFromMarkdown(finalAnswer);
        finalAnswer = removeMarkdownImages(finalAnswer) || finalAnswer;
        setDisplayedAnswer(finalAnswer);
      }

      setChatHistory((prev) =>
        prev.map((chat, index) =>
          index === prev.length - 1
            ? { ...chat, answer: finalAnswer, imageUrl: finalImageUrl || undefined }
            : chat
        )
      );

      await fetchConversations();
    } catch (error) {
      console.error(error);
      setChatHistory((prev) =>
        prev.map((chat, index) =>
          index === prev.length - 1
            ? { ...chat, answer: "Something went wrong." }
            : chat
        )
      );
    } finally {
      setLoading(false);
      setStreamBuffer("");
      setDisplayedAnswer("");
    }
  };

  const beginEditPrompt = (index: number, text: string) => {
    setEditingPromptIndex(index);
    setEditingPromptText(text);
  };

  const cancelEditPrompt = () => {
    setEditingPromptIndex(null);
    setEditingPromptText("");
  };

  const saveEditPrompt = async (index: number) => {
    const updatedQuestion = editingPromptText.trim();
    if (!updatedQuestion || loading || !conversationId) return;

    setLoading(true);
    setStreamBuffer("");
    setDisplayedAnswer("");

    setChatHistory((prev) =>
      prev.map((chat, i) =>
        i === index ? { ...chat, question: updatedQuestion, answer: "", imageUrl: undefined } : chat
      )
    );

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          question: updatedQuestion,
          conversationId,
          editPrompt: true,
          attachments: chatHistory[index]?.attachments ?? [],
          history: chatHistory.slice(0, index).map((chat) => ({
            question: chat.question,
            answer: chat.answer,
            imageUrl: chat.imageUrl,
            attachments: chat.attachments ?? [],
          })),
        }),
      });

      if (!response.ok || !response.body) {
  const errorText = await response.text();
  console.error("API /api/chat failed:", response.status, errorText);
  throw new Error(`Request failed: ${response.status} ${errorText}`);
}

      const contentType = response.headers.get("Content-Type") || "";
      let finalAnswer = "";
      let finalImageUrl = "";

      if (contentType.includes("application/json")) {
        const data = await response.json();
        finalAnswer = data.answer || data.text || "";
        finalImageUrl = data.imageUrl || "";
        setStreamBuffer(finalAnswer);
        setDisplayedAnswer(finalAnswer);
      } else {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value, { stream: true });
          finalAnswer += chunk;
          setStreamBuffer(finalAnswer);
        }

        finalImageUrl = extractImageUrlFromMarkdown(finalAnswer);
        finalAnswer = removeMarkdownImages(finalAnswer) || finalAnswer;
        setDisplayedAnswer(finalAnswer);
      }

      setChatHistory((prev) =>
        prev.map((chat, i) =>
          i === index ? { ...chat, answer: finalAnswer, imageUrl: finalImageUrl || undefined } : chat
        )
      );

      setEditingPromptIndex(null);
      setEditingPromptText("");
      await fetchConversations();
    } catch (error) {
      console.error(error);
      setChatHistory((prev) =>
        prev.map((chat, i) =>
          i === index ? { ...chat, answer: "Something went wrong." } : chat
        )
      );
    } finally {
      setLoading(false);
      setStreamBuffer("");
      setDisplayedAnswer("");
    }
  };

  const handleAddImageClick = () => {
    imageInputRef.current?.click();
    setAddMenuOpen(false);
  };

  const handleAddFileClick = () => {
    fileInputRef.current?.click();
    setAddMenuOpen(false);
  };

  const handleGenerateImagePrompt = () => {
    setQuestion((prev) =>
      prev.trim() ? `Create an image of ${prev}` : "Create an image of "
    );
    setAddMenuOpen(false);
  };

  const handleImageSelection = async (
    event: React.ChangeEvent<HTMLInputElement>
  ) => {
    try {
      const files = Array.from(event.target.files ?? []);
      if (!files.length) return;

      const uploadedItems: AttachmentChip[] = [];

      for (const file of files) {
        const formData = new FormData();
        formData.append("file", file);

        const res = await fetch("/api/upload", {
          method: "POST",
          body: formData,
        });

        if (!res.ok) {
          console.error("Upload failed");
          continue;
        }

        const data = await res.json();

        uploadedItems.push({
          id: `${Date.now()}-${file.name}`,
          name: data.name || file.name,
          kind: file.type.startsWith("image/") ? "image" : "file",
          previewUrl: data.url,
          type: data.type || file.type,
          mimeType: data.type || file.type,
          size: data.size || file.size,
          base64: data.base64,
        });
      }

      setAttachments((prev) => [...prev, ...uploadedItems]);
    } catch (error) {
      console.error("Attachment upload error:", error);
    } finally {
      event.target.value = "";
    }
  };

  const handleFileSelection = async (
    event: React.ChangeEvent<HTMLInputElement>
  ) => {
    try {
      const files = Array.from(event.target.files ?? []);
      if (!files.length) return;

      const uploadedItems: AttachmentChip[] = [];

      for (const file of files) {
        const formData = new FormData();
        formData.append("file", file);

        const res = await fetch("/api/upload", {
          method: "POST",
          body: formData,
        });

        if (!res.ok) {
          console.error("Upload failed");
          continue;
        }

        const data = await res.json();

        uploadedItems.push({
          id: `${Date.now()}-${file.name}`,
          name: data.name || file.name,
          kind: file.type.startsWith("image/") ? "image" : "file",
          previewUrl: data.url,
          type: data.type || file.type,
          mimeType: data.type || file.type,
          size: data.size || file.size,
          base64: data.base64,
        });
      }

      setAttachments((prev) => [...prev, ...uploadedItems]);
    } catch (error) {
      console.error("File selection error:", error);
    } finally {
      event.target.value = "";
    }
  };

  const removeAttachment = (id: string) => {
    setAttachments((prev) => prev.filter((item) => item.id !== id));
  };

  const clearAttachments = () => {
    setAttachments([]);
    localStorage.removeItem(ATTACHMENTS_STORAGE_KEY);
    setAddMenuOpen(false);
  };

  const renderAttachmentChips = () => {
    if (attachments.length === 0) return null;

    return (
      <div className="mb-3 flex flex-wrap gap-2">
        {attachments.map((item) => (
          <div
            key={item.id}
            className="flex items-center gap-2 rounded-2xl border border-[#d4af37]/25 bg-[#0a3a37]/80 px-3 py-2 text-sm text-white/85"
          >
            {item.kind === "image" && item.previewUrl ? (
              <img
                src={item.previewUrl}
                alt={item.name}
                className="h-14 w-14 rounded-xl border border-[#d4af37]/40 object-cover"
              />
            ) : (
              <div className="flex h-14 w-14 items-center justify-center rounded-xl border border-[#d4af37]/30 bg-[#0f4a45] text-[#d4af37]">
                <FileText size={18} />
              </div>
            )}

            <span className="max-w-[160px] truncate">{item.name}</span>
            <button
              onClick={() => removeAttachment(item.id)}
              className="text-white/60 transition hover:text-white button-press"
              title="Remove"
              type="button"
            >
              <X size={14} />
            </button>
          </div>
        ))}
      </div>
    );
  };

  const renderMessageAttachments = (items?: AttachmentChip[]) => {
    if (!items || items.length === 0) return null;

    return (
      <div className="mb-3 flex flex-wrap justify-end gap-2">
        {items.map((item) => (
          <div
            key={item.id}
            className="overflow-hidden rounded-2xl border border-white/10 bg-[#062927]/70"
          >
            {item.kind === "image" && item.previewUrl ? (
              <img
                src={item.previewUrl}
                alt={item.name}
                className="h-28 w-28 object-cover"
              />
            ) : (
              <div className="flex items-center gap-2 px-3 py-2 text-sm text-white/85">
                <FileText size={16} className="text-[#d4af37]" />
                <span className="max-w-[160px] truncate">{item.name}</span>
              </div>
            )}
          </div>
        ))}
      </div>
    );
  };

  const renderAddMenuButton = (size: "hero" | "chat") => {
    const isHero = size === "hero";

    return (
      <div className="relative" ref={addMenuRef}>
        <button
          onClick={() => setAddMenuOpen((prev) => !prev)}
          type="button"
          className={`flex items-center justify-center border border-[#d4af37]/30 bg-[#123f3b] text-[#d4af37] shadow-lg transition-all duration-200 button-press gold-glow ${
            isHero
              ? "h-16 w-16 rounded-2xl text-3xl"
              : "h-12 w-12 rounded-xl text-xl"
          }`}
          title="Add"
        >
          <Plus size={isHero ? 28 : 20} />
        </button>

        {addMenuOpen && (
          <div
            className={`absolute left-0 z-50 w-56 rounded-2xl border border-[#d4af37]/20 bg-[#062927]/95 p-2 shadow-[0_12px_40px_rgba(0,0,0,0.35)] backdrop-blur-xl ${
              isHero ? "bottom-[calc(100%+12px)]" : "bottom-[calc(100%+10px)]"
            }`}
          >
            <button
              onClick={handleAddImageClick}
              className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left text-sm text-white transition hover:bg-[#123f3b]"
            >
              <ImageIcon size={18} className="text-[#d4af37]" />
              <span>Upload image</span>
            </button>

            <button
              onClick={handleAddFileClick}
              className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left text-sm text-white transition hover:bg-[#123f3b]"
            >
              <FileText size={18} className="text-[#d4af37]" />
              <span>Upload file</span>
            </button>

            <button
              onClick={handleGenerateImagePrompt}
              className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left text-sm text-white transition hover:bg-[#123f3b]"
            >
              <Wand2 size={18} className="text-[#d4af37]" />
              <span>Generate image prompt</span>
            </button>

            {attachments.length > 0 && (
              <button
                onClick={clearAttachments}
                className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left text-sm text-red-200 transition hover:bg-red-500/10"
              >
                <X size={18} />
                <span>Clear attachments</span>
              </button>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="flex h-screen bg-[radial-gradient(circle_at_top,#0b4a45_0%,#052f2d_55%,#031f1d_100%)] text-[#d4af37]">
      <input
        ref={imageInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={handleImageSelection}
      />
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={handleFileSelection}
      />

      {sidebarOpen && (
        <aside className="flex w-72 flex-col border-r border-[#d4af37]/15 bg-[#062927]/95 p-4">
          <button
            onClick={startNewChat}
            className="mb-4 rounded-2xl border border-[#d4af37]/30 bg-[#123f3b] px-4 py-3 text-left text-white shadow-lg transition hover:bg-[#164944] button-press gold-glow"
          >
            + New chat
          </button>

          <div className="mb-3 text-sm font-semibold uppercase tracking-wide text-[#d4af37]/75">
            Conversations
          </div>

          <div className="flex-1 space-y-2 overflow-y-auto">
            {conversations.map((conversation) => (
              <div
                key={conversation.id}
                className={`group rounded-xl px-3 py-3 transition ${
                  conversationId === conversation.id
                    ? "bg-[#123f3b] text-[#f5d76e]"
                    : "bg-[#0a3a37]/50 text-white hover:bg-[#123f3b]/80"
                }`}
              >
                {editingConversationId === conversation.id ? (
                  <div className="space-y-2">
                    <input
                      value={editingTitle}
                      onChange={(e) => setEditingTitle(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") saveRename(conversation.id);
                        if (e.key === "Escape") cancelRename();
                      }}
                      autoFocus
                      className="w-full rounded-lg border border-[#d4af37]/20 bg-[#062927] px-2 py-1 text-sm text-white outline-none"
                    />

                    <div className="flex gap-2">
                      <button
                        onClick={() => saveRename(conversation.id)}
                        className="rounded-md bg-[#1d5a4b] px-2 py-1 text-xs text-white button-press"
                      >
                        Save
                      </button>
                      <button
                        onClick={cancelRename}
                        className="rounded-md bg-[#3a3a3a] px-2 py-1 text-xs text-white button-press"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => openConversation(conversation.id)}
                      className="min-w-0 flex-1 text-left text-sm"
                    >
                      <div
                        className={`truncate font-medium ${
                          conversation.title === "New chat"
                            ? "italic text-white/75"
                            : ""
                        }`}
                      >
                        {conversation.title || "Untitled chat"}
                      </div>
                    </button>

                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        beginRename(conversation);
                      }}
                      className="rounded-md px-2 py-1 text-xs text-[#d4af37] opacity-0 transition hover:bg-[#d4af37]/10 group-hover:opacity-100 button-press"
                    >
                      ✎
                    </button>

                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteConversation(conversation.id);
                      }}
                      className="rounded-md px-2 py-1 text-xs text-red-300 opacity-0 transition hover:bg-red-500/10 hover:text-red-200 group-hover:opacity-100 button-press"
                    >
                      ✕
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </aside>
      )}

      <main className="flex flex-1 flex-col">
        <div className="flex items-center justify-between px-4 py-4">
          <div className="flex items-center gap-3">
            <button
              onClick={() => setSidebarOpen((prev) => !prev)}
              className="rounded-xl border border-[#d4af37]/20 bg-[#0a3a37]/70 px-3 py-2 text-sm text-white button-press gold-glow"
            >
              {sidebarOpen ? "Hide" : "Show"}
            </button>

            <h1 className="font-serif text-3xl tracking-wide text-[#d4af37] drop-shadow-[0_0_20px_rgba(212,175,55,0.25)]">
              Quran Assist
            </h1>
          </div>
        </div>

        {chatHistory.length === 0 ? (
          <div className="relative flex flex-1 flex-col items-center justify-between overflow-hidden px-6 py-8">
            <div
              className="fade-in-kaaba absolute inset-0 bg-cover bg-center bg-no-repeat will-change-transform"
              style={{ backgroundImage: "url('/kaaba.png')" }}
            />
            <div className="absolute inset-0 bg-[#052f2d]/35" />

            <div className="fade-in-gold relative z-10 mt-2 text-center font-serif text-6xl tracking-wide text-[#d4af37] drop-shadow-[0_0_20px_rgba(212,175,55,0.35)] md:text-7xl">
              Quran Assist
            </div>

            <div className="flex-1" />

            <div className="relative z-10 mb-4 w-full max-w-6xl">
              {renderAttachmentChips()}

              <div className="flex items-center rounded-full border border-[#d4af37]/70 bg-[#0a3a37]/75 px-6 py-4 shadow-[0_0_40px_rgba(212,175,55,0.2)] backdrop-blur-xl">
                {renderAddMenuButton("hero")}
                 
                <input
                  type="text"
                  placeholder="Ask Quran Assist anything..."
                  value={question}
                  disabled={loading}
                  onChange={(e) => setQuestion(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleAsk();
                  }}
                  className="ml-4 flex-1 bg-transparent text-2xl text-white outline-none placeholder:text-white/70 disabled:opacity-50"
                />

                <button
                  onClick={handleMicClick}
                  type="button"
                  className={`ml-4 flex h-16 w-16 items-center justify-center rounded-2xl border text-3xl shadow-lg transition-all duration-200 button-press ${
                    isListening
                      ? "border-red-400/40 bg-red-500/20 text-red-300 mic-glow shadow-lg"
                      : "border-[#d4af37]/30 bg-[#123f3b] text-[#d4af37] hover:scale-105 hover:shadow-[0_0_25px_rgba(212,175,55,0.25)] gold-glow"
                  }`}
                  title={isListening ? "Stop recording" : "Start voice input"}
                >
                  {isListening ? <Square size={28} /> : <Mic size={28} />}
                </button>

                <button
                  onClick={handleAsk}
                  disabled={loading || (!question.trim() && attachments.length === 0)}
                  className="ml-4 flex h-16 w-16 items-center justify-center rounded-2xl border border-[#d4af37]/30 bg-[#123f3b] text-4xl text-[#d4af37] shadow-lg transition hover:scale-105 hover:shadow-[0_0_25px_rgba(212,175,55,0.25)] disabled:opacity-50 button-press gold-glow"
                >
                  ↑
                </button>
              </div>
            </div>
          </div>
        ) : (
          <>
            <div className="flex flex-1 justify-center overflow-y-auto px-4 py-6">
              <div className="w-full max-w-3xl space-y-5 px-2">
                {chatHistory.map((chat, index) => {
                  const isLast = index === chatHistory.length - 1;
                  const activeAnswer = loading && isLast ? displayedAnswer : chat.answer;
                  const isGenerating = loading && isLast;
                  const formattedAnswer = extractQuranCitations(activeAnswer);

                  return (
                    <div key={index} className="flex flex-col gap-2">
                      <div className="flex justify-end">
                        <div className="max-w-[70%]">
                          <div className="rounded-2xl bg-[#0a3a37]/95 px-5 py-3 text-white shadow-lg chat-bubble">
                            {editingPromptIndex === index ? (
                              <div className="space-y-2">
                                <input
                                  value={editingPromptText}
                                  onChange={(e) => setEditingPromptText(e.target.value)}
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter") saveEditPrompt(index);
                                    if (e.key === "Escape") cancelEditPrompt();
                                  }}
                                  autoFocus
                                  className="w-full rounded-lg border border-white/15 bg-[#062927] px-2 py-1 text-sm text-white outline-none"
                                />

                                <div className="flex justify-end gap-2">
                                  <button
                                    onClick={() => saveEditPrompt(index)}
                                    className="rounded-md bg-[#1d5a4b] px-2 py-1 text-xs text-white button-press"
                                  >
                                    Save
                                  </button>
                                  <button
                                    onClick={cancelEditPrompt}
                                    className="rounded-md bg-[#3a3a3a] px-2 py-1 text-xs text-white button-press"
                                  >
                                    Cancel
                                  </button>
                                </div>
                              </div>
                            ) : (
                              <>
                                {renderMessageAttachments(chat.attachments)}
                                <div className="text-right leading-relaxed">{chat.question}</div>
                              </>
                            )}
                          </div>

                          {!loading && editingPromptIndex !== index && (
                            <div className="mt-2 flex justify-end gap-2 px-2">
                              <button
                                onClick={() => handleCopy(chat.question, `prompt-${index}`)}
                                className="flex h-8 w-8 items-center justify-center rounded-full border border-white/10 bg-[#062927]/70 text-white/80 transition hover:bg-[#0b3a36] hover:text-white button-press"
                                title="Copy"
                              >
                                {copiedKey === `prompt-${index}` ? (
                                  <span className="text-xs">✓</span>
                                ) : (
                                  <Copy size={14} />
                                )}
                              </button>

                              {isLast && (
                                <button
                                  onClick={() => beginEditPrompt(index, chat.question)}
                                  className="flex h-8 w-8 items-center justify-center rounded-full border border-white/10 bg-[#062927]/70 text-white/80 transition hover:bg-[#0b3a36] hover:text-white button-press"
                                  title="Edit"
                                >
                                  <Pencil size={14} />
                                </button>
                              )}
                            </div>
                          )}
                        </div>
                      </div>

                      <div className="group self-start max-w-[78%]">
                        <div
                          className={`rounded-3xl border border-[#d4af37]/15 bg-[#123f3b]/95 px-5 text-[#d4af37] shadow-[0_12px_40px_rgba(0,0,0,0.18)] transition-all duration-300 ease-out hover:shadow-[0_0_30px_rgba(212,175,55,0.12)] chat-bubble ${
                            isGenerating
                              ? "min-h-[54px] py-3"
                              : "py-4"
                          }`}
                        >
                          <div
                            className="
                              typing-reveal
                              qa-message-enter
                              prose prose-invert max-w-none
                              leading-[1.55]

                              [&>p]:my-2
                              [&>h1]:my-3
                              [&>h2]:my-3
                              [&>h3]:my-2

                              [&>ul]:my-2
                              [&>ol]:my-2
                              [&>blockquote]:my-3

                              [&_p]:text-[0.96rem]
                              [&_li]:my-1
                              [&_li]:text-[0.96rem]

                              [&_h1]:text-[1.4rem]
                              [&_h1]:font-bold
                              [&_h1]:text-[#f5d76e]

                              [&_h2]:text-[1.25rem]
                              [&_h2]:font-bold
                              [&_h2]:text-[#f5d76e]

                              [&_h3]:text-[1.1rem]
                              [&_h3]:font-semibold
                              [&_h3]:text-[#f0d264]

                              [&_strong]:font-semibold
                              [&_strong]:text-[#f8df7a]

                              [&_em]:text-[#ead17a]

                              [&_blockquote]:rounded-r-xl
                              [&_blockquote]:border-l-4
                              [&_blockquote]:border-[#d4af37]/50
                              [&_blockquote]:bg-[#0a3a37]/40
                              [&_blockquote]:px-3
                              [&_blockquote]:py-2
                              [&_blockquote]:italic
                              [&_blockquote]:text-[#efd981]

                              [&_code]:rounded-md
                              [&_code]:bg-[#0a3a37]
                              [&_code]:px-1
                              [&_code]:py-0.5
                              [&_code]:text-xs
                              [&_code]:text-[#f5d76e]

                              [&_hr]:my-3
                              [&_hr]:border-[#d4af37]/20
                            "
                          >
                            {formattedAnswer.mainText ? (
                              <ReactMarkdown>
                                {formattedAnswer.mainText}
                              </ReactMarkdown>
                            ) : isGenerating ? (
                              <ChatGPTTypingIndicator />
                            ) : null}

                            {isGenerating && formattedAnswer.mainText && (
                              <span className="not-prose qa-cursor ml-0.5 align-baseline">▌</span>
                            )}

                            {chat.imageUrl && (
                              <GeneratedImageCard
                                imageUrl={chat.imageUrl}
                                copied={copiedKey === `image-${index}`}
                                onCopy={() => handleCopy(chat.imageUrl || "", `image-${index}`)}
                              onOpen={() => setFullscreenImage(chat.imageUrl || null)}
                              />
                            )}

                            <QuranReferencesBlock citations={formattedAnswer.citations} />

                            {isGenerating && formattedAnswer.mainText && (
                              <div className="not-prose mt-3 flex items-center gap-1.5 text-[#d4af37]/70">
                                <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-[#d4af37]/70 [animation-delay:-0.3s]" />
                                <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-[#d4af37]/70 [animation-delay:-0.15s]" />
                                <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-[#d4af37]/70" />
                              </div>
                            )}
                          </div>
                        </div>

                        {!loading && (
                          <div className="mt-2 flex gap-2 px-2 opacity-0 transition-opacity duration-200 group-hover:opacity-100">
                            <button
                              onClick={() => handleCopy(chat.answer, `answer-${index}`)}
                              className="flex h-8 w-8 items-center justify-center rounded-full border border-[#d4af37]/20 bg-[#0a3a37]/60 text-[#f2d46b] transition hover:bg-[#114743] hover:text-[#ffe082] button-press"
                              title="Copy"
                            >
                              {copiedKey === `answer-${index}` ? (
                                <span className="text-xs">✓</span>
                              ) : (
                                <Copy size={14} />
                              )}
                            </button>

                            {isLast && (
                              <button
                                onClick={handleRegenerate}
                                className="flex h-8 w-8 items-center justify-center rounded-full border border-[#d4af37]/20 bg-[#0a3a37]/60 text-[#f2d46b] transition hover:bg-[#114743] hover:text-[#ffe082] button-press"
                                title="Regenerate"
                              >
                                <RefreshCw size={14} />
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}

                <div ref={bottomRef} />
              </div>
            </div>

            <div className="border-t border-[#d4af37]/20 p-4">
              <div className="mx-auto max-w-5xl">
                {renderAttachmentChips()}

                <div className="flex items-center rounded-full border border-[#d4af37]/70 bg-[#0a3a37]/80 px-6 py-4 shadow-[0_0_40px_rgba(212,175,55,0.15)] backdrop-blur-xl">
                  {renderAddMenuButton("chat")}

                  <input
                    type="text"
                    placeholder="Ask Quran Assist anything..."
                    value={question}
                    disabled={loading}
                    onChange={(e) => setQuestion(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleAsk();
                    }}
                    className="ml-3 flex-1 bg-transparent text-lg text-white outline-none placeholder:text-white/70 disabled:opacity-50"
                  />

                  <button
                    onClick={handleMicClick}
                    type="button"
                    className={`ml-3 flex h-12 w-12 items-center justify-center rounded-xl border shadow-lg transition-all duration-200 button-press ${
                      isListening
                        ? "border-red-400/40 bg-red-500/20 text-red-300 mic-glow shadow-lg"
                        : "border-[#d4af37]/30 bg-[#123f3b] text-[#d4af37] hover:scale-105 hover:shadow-[0_0_25px_rgba(212,175,55,0.25)] gold-glow"
                    }`}
                    title={isListening ? "Stop recording" : "Start voice input"}
                  >
                    {isListening ? <Square size={20} /> : <Mic size={20} />}
                  </button>

                  <button
                    onClick={handleAsk}
                    disabled={loading || (!question.trim() && attachments.length === 0)}
                    className="ml-3 flex h-12 w-12 items-center justify-center rounded-xl border border-[#d4af37]/30 bg-[#123f3b] text-2xl text-[#d4af37] shadow-lg transition hover:scale-105 hover:shadow-[0_0_25px_rgba(212,175,55,0.25)] disabled:opacity-50 button-press gold-glow"
                  >
                    ↑
                  </button>
                </div>
              </div>
            </div>
          </>
        )}
      </main>
      {fullscreenImage && (
        <div
          className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/90 p-6 backdrop-blur-sm"
          onClick={() => setFullscreenImage(null)}
        >
          <button
            type="button"
            onClick={() => setFullscreenImage(null)}
            className="absolute right-6 top-6 z-[10000] flex h-11 w-11 items-center justify-center rounded-full border border-[#d4af37]/40 bg-black/60 text-xl text-[#f5d76e] shadow-lg transition hover:bg-black/80 hover:text-[#ffe082]"
            title="Close fullscreen image"
          >
            ×
          </button>

          <img
            src={fullscreenImage}
            alt="Fullscreen generated image"
            className="max-h-[90vh] max-w-[90vw] rounded-2xl object-contain shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          />
        </div>
      )}
    </div>
  );
}