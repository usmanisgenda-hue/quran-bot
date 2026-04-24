"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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
  Expand,
} from "lucide-react";

type ChatMessage = {
  question: string;
  answer: string;
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

type AttachmentChip = {
  id: string;
  name: string;
  kind: "image" | "file";
  previewUrl?: string;
};

const ATTACHMENTS_STORAGE_KEY = "qa-pending-attachments";
const ACTIVE_CONVERSATION_STORAGE_KEY = "qa-active-conversation-id";
const CHAT_HISTORY_STORAGE_KEY = "qa-chat-history";

function parseAssistantContentForDisplay(content: string): string {
  try {
    const parsed = JSON.parse(content);

    if (
      parsed &&
      typeof parsed === "object" &&
      parsed.type === "image" &&
      typeof parsed.imageUrl === "string"
    ) {
      const text =
        typeof parsed.text === "string" && parsed.text.trim()
          ? parsed.text.trim()
          : "Here is your generated image.";

      return `${text}\n\n![Generated image](${parsed.imageUrl})`;
    }

    return content;
  } catch {
    return content;
  }
}

function extractImageUrlsFromMarkdown(markdown: string): string[] {
  const urls = new Set<string>();
  const imageRegex = /!\[[^\]]*?\]\((.*?)\)/g;

  let match: RegExpExecArray | null;
  while ((match = imageRegex.exec(markdown)) !== null) {
    if (typeof match[1] === "string" && match[1]) {
      urls.add(match[1]);
    }
  }

  return Array.from(urls);
}
function formatAyahReferences(text: string) {
  return text.replace(
    /"([^"]+)"\s*\n?\s*\(Quran\s+(\d+):(\d+)\)/g,
    '\n\n> "$1"\n>\n> **Quran $2:$3**'
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

  const [isListening, setIsListening] = useState(false);
  const [autoSendAfterVoice, setAutoSendAfterVoice] = useState(false);

  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [attachments, setAttachments] = useState<AttachmentChip[]>([]);

  const [showChatInterface, setShowChatInterface] = useState(false);
  const [selectedImageUrl, setSelectedImageUrl] = useState<string | null>(null);

  const bottomRef = useRef<HTMLDivElement | null>(null);
  const recognitionRef = useRef<any>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const addMenuRef = useRef<HTMLDivElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const isHeroVisible = !showChatInterface && chatHistory.length === 0;
  const isChatVisible = showChatInterface || chatHistory.length > 0;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatHistory, loading, displayedAnswer]);

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
          if (parsedHistory.length > 0) {
            setShowChatInterface(true);
          }
        }
      }
    } catch (error) {
      console.error("Failed to restore chat session:", error);
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(ATTACHMENTS_STORAGE_KEY, JSON.stringify(attachments));
    } catch (error) {
      console.error("Failed to persist attachments:", error);
    }
  }, [attachments]);

  useEffect(() => {
    try {
      if (conversationId === null) {
        localStorage.removeItem(ACTIVE_CONVERSATION_STORAGE_KEY);
      } else {
        localStorage.setItem(ACTIVE_CONVERSATION_STORAGE_KEY, String(conversationId));
      }

      localStorage.setItem(CHAT_HISTORY_STORAGE_KEY, JSON.stringify(chatHistory));
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
        return streamBuffer.slice(0, prev.length + 2);
      });
    }, 12);

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

  useEffect(() => {
    const handleEsc = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSelectedImageUrl(null);
        setAddMenuOpen(false);
      }
    };

    window.addEventListener("keydown", handleEsc);
    return () => window.removeEventListener("keydown", handleEsc);
  }, []);

  useEffect(() => {
    if (selectedImageUrl) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }

    return () => {
      document.body.style.overflow = "";
    };
  }, [selectedImageUrl]);

  const playMicTone = (type: "start" | "stop") => {
    try {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
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
          convertedHistory.push({
            question: pendingQuestion.text,
            answer: parseAssistantContentForDisplay(msg.content),
            attachments: pendingQuestion.attachments,
          });
          pendingQuestion = null;
        }
      }

      setConversationId(id);
      setChatHistory(convertedHistory);
      setShowChatInterface(true);
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
    setSelectedImageUrl(null);
    setShowChatInterface(false);
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
        startNewChat();
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
    const isFirstPrompt = chatHistory.length === 0 && !showChatInterface;

    if ((!q && outgoingAttachments.length === 0) || loading) return;

    const effectiveQuestion =
      q || (outgoingAttachments.length > 0
        ? "Please analyze the attached image."
        : "");

    if (isFirstPrompt) {
      setShowChatInterface(true);
    }

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

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let finalAnswer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        finalAnswer += chunk;
        setStreamBuffer(finalAnswer);
      }

      setDisplayedAnswer(finalAnswer);

      setChatHistory((prev) =>
        prev.map((chat, index) =>
          index === prev.length - 1 ? { ...chat, answer: finalAnswer } : chat
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
        index === prev.length - 1 ? { ...chat, answer: "" } : chat
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
        }),
      });

      if (!response.ok || !response.body) {
        throw new Error("Regenerate failed");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let finalAnswer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        finalAnswer += chunk;
        setStreamBuffer(finalAnswer);
      }

      setDisplayedAnswer(finalAnswer);

      setChatHistory((prev) =>
        prev.map((chat, index) =>
          index === prev.length - 1 ? { ...chat, answer: finalAnswer } : chat
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
        i === index ? { ...chat, question: updatedQuestion, answer: "" } : chat
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
        }),
      });

      if (!response.ok || !response.body) {
        const errorText = await response.text();
        console.error("API /api/chat failed:", response.status, errorText);
        throw new Error(`Request failed: ${response.status} ${errorText}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let finalAnswer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        finalAnswer += chunk;
        setStreamBuffer(finalAnswer);
      }

      setDisplayedAnswer(finalAnswer);

      setChatHistory((prev) =>
        prev.map((chat, i) =>
          i === index ? { ...chat, answer: finalAnswer } : chat
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
          name: data.name,
          kind: file.type.startsWith("image/") ? "image" : "file",
          previewUrl: data.url,
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
          name: data.name,
          kind: file.type.startsWith("image/") ? "image" : "file",
          previewUrl: data.url,
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

  const handleDownloadImage = (imageUrl: string) => {
    const anchor = document.createElement("a");
    anchor.href = imageUrl;
    anchor.download = imageUrl.split("/").pop() || "generated-image.png";
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
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
                className="h-28 w-28 cursor-pointer object-cover transition hover:opacity-90"
                onClick={() => item.previewUrl && setSelectedImageUrl(item.previewUrl)}
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

  const renderAssistantActions = (chat: ChatMessage, index: number, isLast: boolean) => {
    const imageUrls = extractImageUrlsFromMarkdown(chat.answer);
    const primaryImageUrl = imageUrls[0];

    return (
      <div className="mt-2 flex flex-wrap gap-2 px-2">
        <button
          onClick={() => handleCopy(chat.answer, `answer-${index}`)}
          className="flex h-8 w-8 items-center justify-center rounded-full border border-[#d4af37]/20 bg-[#0a3a37]/60 text-[#f2d46b] transition hover:bg-[#114743] hover:text-[#ffe082] button-press"
          title="Copy"
          type="button"
        >
          {copiedKey === `answer-${index}` ? (
            <span className="text-xs">✓</span>
          ) : (
            <Copy size={14} />
          )}
        </button>

        {primaryImageUrl && (
          <>
            <button
              onClick={() => handleDownloadImage(primaryImageUrl)}
              className="flex h-8 w-8 items-center justify-center rounded-full border border-[#d4af37]/20 bg-[#0a3a37]/60 text-[#f2d46b] transition hover:bg-[#114743] hover:text-[#ffe082] button-press"
              title="Download image"
              type="button"
            >
              <Download size={14} />
            </button>

            <button
              onClick={() => setSelectedImageUrl(primaryImageUrl)}
              className="flex h-8 w-8 items-center justify-center rounded-full border border-[#d4af37]/20 bg-[#0a3a37]/60 text-[#f2d46b] transition hover:bg-[#114743] hover:text-[#ffe082] button-press"
              title="View full screen"
              type="button"
            >
              <Expand size={14} />
            </button>
          </>
        )}

        {isLast && (
          <button
            onClick={handleRegenerate}
            className="flex h-8 w-8 items-center justify-center rounded-full border border-[#d4af37]/20 bg-[#0a3a37]/60 text-[#f2d46b] transition hover:bg-[#114743] hover:text-[#ffe082] button-press"
            title="Regenerate"
            type="button"
          >
            <RefreshCw size={14} />
          </button>
        )}
      </div>
    );
  };

  const heroSection = useMemo(
    () => (
      <div
        className={`qa-panel-transition absolute inset-0 flex flex-col items-center justify-between overflow-hidden px-6 py-8 ${
          isHeroVisible ? "qa-panel-visible" : "qa-panel-hidden"
        }`}
      >
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

          <div className="flex items-center rounded-full border border-[#d4af37]/70 bg-[#0a3a37]/75 px-6 py-4 shadow-[0_0_40px_rgba(212,175,55,0.2)] backdrop-blur-xl transition-all duration-500">
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
              type="button"
              disabled={loading || (!question.trim() && attachments.length === 0)}
              className="ml-4 flex h-16 w-16 items-center justify-center rounded-2xl border border-[#d4af37]/30 bg-[#123f3b] text-4xl text-[#d4af37] shadow-lg transition hover:scale-105 hover:shadow-[0_0_25px_rgba(212,175,55,0.25)] disabled:opacity-50 button-press gold-glow"
            >
              ↑
            </button>
          </div>
        </div>
      </div>
    ),
    [isHeroVisible, attachments, question, loading, isListening, addMenuOpen]
  );

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

          <div className="qa-scroll flex-1 space-y-2 overflow-y-auto">
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

        <div className="relative flex-1 overflow-hidden">
          {heroSection}

          <div
            className={`qa-panel-transition absolute inset-0 flex flex-col ${
              isChatVisible ? "qa-panel-visible" : "qa-panel-hidden"
            }`}
          >
            <div className="qa-scroll flex flex-1 justify-center overflow-y-auto px-4 py-6">
              <div className="w-full max-w-3xl space-y-5 px-2 pb-28">
                {chatHistory.map((chat, index) => {
                  const isLast = index === chatHistory.length - 1;

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
                                type="button"
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
                                  type="button"
                                >
                                  <Pencil size={14} />
                                </button>
                              )}
                            </div>
                          )}
                        </div>
                      </div>

                      <div className="self-start max-w-[78%]">
                        <div className="rounded-3xl border border-[#d4af37]/15 bg-[#123f3b]/95 px-5 py-4 text-[#d4af37] shadow-[0_12px_40px_rgba(0,0,0,0.18)] transition hover:shadow-[0_0_30px_rgba(212,175,55,0.12)] chat-bubble">
                          <div
                            className="
                              typing-reveal
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

                              [&_img]:my-3
                              [&_img]:max-h-[420px]
                              [&_img]:max-w-full
                              [&_img]:cursor-zoom-in
                              [&_img]:rounded-2xl
                              [&_img]:border
                              [&_img]:border-[#d4af37]/30
                              [&_img]:object-cover
                            "
                          >
                            <ReactMarkdown
                              components={{
                                img: ({ src, alt }) => (
                                  <img
                                    src={typeof src === "string" ? src : ""}
                                    alt={alt || "Generated image"}
                                    className="qa-image-hover my-3 max-h-[420px] max-w-full cursor-zoom-in rounded-2xl border border-[#d4af37]/30 object-cover"
                                    onClick={() => {
                                      if (typeof src === "string") {
                                        setSelectedImageUrl(src);
                                      }
                                    }}
                                  />
                                ),
                              }}
                            >
                              {formatAyahReferences(loading && isLast ? displayedAnswer : chat.answer)}
                            </ReactMarkdown>
                            {loading && isLast && <span className="qa-cursor">▌</span>}
                          </div>
                        </div>

                        {!loading && renderAssistantActions(chat, index, isLast)}
                      </div>
                    </div>
                  );
                })}

                <div ref={bottomRef} />
              </div>
            </div>

            <div className="border-t border-[#d4af37]/20 p-4 backdrop-blur-sm">
              <div className="mx-auto max-w-5xl">
                {renderAttachmentChips()}

                <div className="flex items-center rounded-full border border-[#d4af37]/70 bg-[#0a3a37]/80 px-6 py-4 shadow-[0_0_40px_rgba(212,175,55,0.15)] backdrop-blur-xl transition-all duration-500">
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
                    type="button"
                    disabled={loading || (!question.trim() && attachments.length === 0)}
                    className="ml-3 flex h-12 w-12 items-center justify-center rounded-xl border border-[#d4af37]/30 bg-[#123f3b] text-2xl text-[#d4af37] shadow-lg transition hover:scale-105 hover:shadow-[0_0_25px_rgba(212,175,55,0.25)] disabled:opacity-50 button-press gold-glow"
                  >
                    ↑
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </main>

      {selectedImageUrl && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 p-6 qa-modal-backdrop"
          onClick={() => setSelectedImageUrl(null)}
        >
          <div
            className="relative flex max-h-full w-full max-w-6xl flex-col items-center justify-center qa-enter"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="absolute right-0 top-0 flex -translate-y-14 gap-2">
              <button
                onClick={() => handleDownloadImage(selectedImageUrl)}
                className="flex items-center gap-2 rounded-xl border border-white/15 bg-[#062927]/90 px-4 py-2 text-sm text-white transition hover:bg-[#0b3a36]"
                type="button"
              >
                <Download size={16} />
                Download
              </button>

              <button
                onClick={() => setSelectedImageUrl(null)}
                className="flex items-center gap-2 rounded-xl border border-white/15 bg-[#062927]/90 px-4 py-2 text-sm text-white transition hover:bg-[#0b3a36]"
                type="button"
              >
                <X size={16} />
                Close
              </button>
            </div>

            <img
              src={selectedImageUrl}
              alt="Expanded"
              className="max-h-[88vh] w-auto max-w-full rounded-2xl border border-[#d4af37]/25 shadow-[0_0_40px_rgba(0,0,0,0.45)]"
            />
          </div>
        </div>
      )}
    </div>
  );
}