"use client";

import React, { useState, useEffect, useMemo } from "react";
import {
  Upload, Video, FileText, Brain, Sparkles, AlertTriangle,
  CheckCircle, ArrowRight, Layers, HelpCircle, RefreshCw, Zap, Loader2,
  IdCard, RotateCcw, XCircle, Clock, TrendingDown, History
} from "lucide-react";
   const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

interface Topic {
  id: string;
  title: string;
  status: string;
  depth: number;
}

interface Quiz {
  topic: string;
  question: string;
  options: string[];
  answer: string;
  explanation?: string;
}

interface Flashcard {
  term: string;
  definition: string;
}

interface MemoryRecord {
  key: string;
  title: string;
  status: string;
  lastReviewed: number; // epoch ms
  stabilityDays: number; // higher = decays slower
  reviewCount: number;
}

// v2: bumped from v1 because v1 had hardcoded quantum-computing placeholder
// topics get saved into it on first load. Bumping the key means anyone with
// old v1 data in their browser simply starts fresh instead of carrying that
// junk data forward.
const MEMORY_STORAGE_KEY = "mindchunk_memory_records_v2";
const DAY_MS = 24 * 60 * 60 * 1000;

// Starting "stability" (in days) before any review has happened, based on
// how conceptually demanding a topic is. More demanding topics start out
// decaying faster until the user proves they've retained them.
const BASE_STABILITY_DAYS: Record<string, number> = {
  foundational: 4,
  advanced: 2.5,
  mastery: 1.5,
};

function normalizeKey(title: string): string {
  return title.trim().toLowerCase();
}

// Ebbinghaus-style exponential decay: retention starts at 1.0 (100%) right
// after a review and decays toward 0 over time, slower for higher-stability
// (better-retained) topics.
function retentionAt(record: MemoryRecord, atTimeMs: number): number {
  const elapsedDays = Math.max(0, (atTimeMs - record.lastReviewed) / DAY_MS);
  return Math.exp(-elapsedDays / record.stabilityDays);
}

function elapsedDaysAt(record: MemoryRecord, atTimeMs: number): number {
  return Math.max(0, (atTimeMs - record.lastReviewed) / DAY_MS);
}

// Finds the best-matching memory record for a quiz's free-text "topic"
// field, since the AI doesn't guarantee it matches a topic title exactly.
function findMatchingRecordKey(quizTopic: string, records: Record<string, MemoryRecord>): string | null {
  if (!quizTopic) return null;
  const q = normalizeKey(quizTopic);
  if (records[q]) return q;

  const keys = Object.keys(records);
  const substringMatch = keys.find((k) => k.includes(q) || q.includes(k));
  if (substringMatch) return substringMatch;

  const qWords = new Set(q.split(/\W+/).filter(Boolean));
  let bestKey: string | null = null;
  let bestScore = 0;
  for (const k of keys) {
    const score = k.split(/\W+/).filter((w) => qWords.has(w)).length;
    if (score > bestScore) {
      bestScore = score;
      bestKey = k;
    }
  }
  return bestScore > 0 ? bestKey : null;
}

// Builds an SVG path for the decay curve (fixed shape based on stability)
// and the coordinates for a marker showing the current retention point.
function buildDecayCurve(stabilityDays: number, elapsedDays: number, width = 160, height = 44) {
  const windowDays = Math.max(14, elapsedDays + 2);
  const steps = 24;
  const points: string[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * windowDays;
    const r = Math.exp(-t / stabilityDays);
    const x = (t / windowDays) * width;
    const y = height - r * height;
    points.push(`${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`);
  }
  const markerT = Math.min(elapsedDays, windowDays);
  const markerR = Math.exp(-elapsedDays / stabilityDays);
  const markerX = (markerT / windowDays) * width;
  const markerY = height - markerR * height;
  return { path: points.join(" "), markerX, markerY, width, height };
}

function urgencyColor(retention: number) {
  if (retention >= 0.7) return { stroke: "#34d399", text: "text-emerald-400", bg: "bg-emerald-500/10", border: "border-emerald-500/30" };
  if (retention >= 0.4) return { stroke: "#fbbf24", text: "text-amber-400", bg: "bg-amber-500/10", border: "border-amber-500/30" };
  return { stroke: "#f87171", text: "text-red-400", bg: "bg-red-500/10", border: "border-red-500/30" };
}

export default function Home() {
  const [activeTab, setActiveTab] = useState<"decay" | "summary" | "quiz" | "flashcards">("decay");
  const [youtubeUrl, setYoutubeUrl] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Dynamic state populated from backend responses. Starts empty --
  // previously this held hardcoded quantum-computing placeholder data,
  // which had the side effect of permanently polluting the Memory Decay
  // Forecast (and localStorage) with fake topics before any real upload.
  const [topics, setTopics] = useState<Topic[]>([]);
  const [summaries, setSummaries] = useState<string[]>([]);
  const [quizzes, setQuizzes] = useState<Quiz[]>([]);
  const [flashcards, setFlashcards] = useState<Flashcard[]>([]);
  const [hasUploaded, setHasUploaded] = useState(false);

  // Per-question selected answer, keyed by quiz index
  const [selectedAnswers, setSelectedAnswers] = useState<Record<number, string>>({});
  // Which flashcards are currently flipped to show their definition, keyed by index
  const [flippedCards, setFlippedCards] = useState<Record<number, boolean>>({});

  // --- Memory Decay Forecast state ---
  const [memoryRecords, setMemoryRecords] = useState<Record<string, MemoryRecord>>({});
  const [simulatedDays, setSimulatedDays] = useState(0); // "Time Machine" slider, 0-14
  const [refresherContent, setRefresherContent] = useState<Record<string, string>>({});
  const [refresherLoadingKey, setRefresherLoadingKey] = useState<string | null>(null);

  // Load saved decay records once on mount
  useEffect(() => {
    try {
      const raw = localStorage.getItem(MEMORY_STORAGE_KEY);
      if (raw) setMemoryRecords(JSON.parse(raw));
    } catch (err) {
      console.warn("Could not load saved memory records:", err);
    }
  }, []);

  // Persist decay records whenever they change
  useEffect(() => {
    try {
      localStorage.setItem(MEMORY_STORAGE_KEY, JSON.stringify(memoryRecords));
    } catch (err) {
      console.warn("Could not save memory records:", err);
    }
  }, [memoryRecords]);

  // Whenever new topics arrive (new upload), rebuild the decay tracker to
  // contain ONLY the current material's topics. A topic with a matching
  // title keeps its existing decay history (so re-uploading the same
  // document doesn't reset your progress); any topic NOT in the new list
  // is dropped, so switching to a different document doesn't leave old
  // topics (e.g. from a previous upload) lingering in the forecast forever.
  useEffect(() => {
    setMemoryRecords((prev) => {
      const next: Record<string, MemoryRecord> = {};
      topics.forEach((t) => {
        const key = normalizeKey(t.title);
        next[key] = prev[key] ?? {
          key,
          title: t.title,
          status: t.status,
          lastReviewed: Date.now(),
          stabilityDays: BASE_STABILITY_DAYS[t.status] ?? 2,
          reviewCount: 0,
        };
      });
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topics]);

  // File Upload Handler with Auto Tab Switch
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setFileName(file.name);
    setLoading(true);
    setSelectedAnswers({});
    setFlippedCards({});

    const formData = new FormData();
    formData.append("file", file);

    try {
      const res = await fetch(`${API_URL}/api/ingest/pdf`, {
        method: "POST",
        body: formData,
      });
      const data = await res.json();

      if (data.topics) setTopics(data.topics);
      if (data.summaries) setSummaries(data.summaries);
      if (data.quizzes) setQuizzes(data.quizzes);
      if (data.flashcards) setFlashcards(data.flashcards);
      setHasUploaded(true);

      setActiveTab("summary");
    } catch (err) {
      console.error("Failed to connect to backend:", err);
      alert(`Error connecting to FastAPI server at ${API_URL}.`);
    } finally {
      setLoading(false);
    }
  };

  // YouTube Ingestion Handler
  const handleYoutubeIngest = async () => {
    if (!youtubeUrl) return;
    setLoading(true);
    setSelectedAnswers({});
    setFlippedCards({});

    try {
      const res = await fetch(`${API_URL}/api/ingest/youtube`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: youtubeUrl }),
      });
      const data = await res.json();
      if (data.topics) setTopics(data.topics);
      if (data.summaries) setSummaries(data.summaries);
      if (data.quizzes) setQuizzes(data.quizzes);
      if (data.flashcards) setFlashcards(data.flashcards);
      setHasUploaded(true);

      setActiveTab("summary");
    } catch (err) {
      console.error("Failed to fetch YouTube transcript:", err);
    } finally {
      setLoading(false);
    }
  };

  const handleSelectAnswer = (quizIdx: number, option: string) => {
    if (selectedAnswers[quizIdx] !== undefined) return;
    setSelectedAnswers((prev) => ({ ...prev, [quizIdx]: option }));

    // Getting a quiz question right/wrong is itself a review event: boost
    // stability on a correct answer, shrink it (decay faster) on a wrong
    // one, since a wrong answer means the concept wasn't actually retained.
    const quiz = quizzes[quizIdx];
    const isCorrect = option === quiz.answer;
    setMemoryRecords((prev) => {
      const key = findMatchingRecordKey(quiz.topic, prev);
      if (!key) return prev;
      const rec = prev[key];
      const updated: MemoryRecord = {
        ...rec,
        lastReviewed: Date.now(),
        stabilityDays: isCorrect
          ? rec.stabilityDays * 1.6
          : Math.max(0.5, rec.stabilityDays * 0.55),
        reviewCount: rec.reviewCount + 1,
      };
      return { ...prev, [key]: updated };
    });
  };

  const toggleFlip = (idx: number) => {
    setFlippedCards((prev) => ({ ...prev, [idx]: !prev[idx] }));
  };

  const markAsReviewed = (key: string) => {
    setMemoryRecords((prev) => {
      const rec = prev[key];
      if (!rec) return prev;
      return {
        ...prev,
        [key]: {
          ...rec,
          lastReviewed: Date.now(),
          stabilityDays: rec.stabilityDays * 1.3,
          reviewCount: rec.reviewCount + 1,
        },
      };
    });
  };

  // Reuses the existing /api/repair-kit endpoint to generate a focused
  // 60-second lesson on a specific decaying topic, then counts that as a
  // review, same as clicking "Mark as Reviewed."
  const handleQuickRefresher = async (record: MemoryRecord) => {
    setRefresherLoadingKey(record.key);
    try {
      const res = await fetch(`${API_URL}/api/repair-kit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic_id: record.title }),
      });
      const data = await res.json();
      setRefresherContent((prev) => ({ ...prev, [record.key]: data.repair_lesson }));
      markAsReviewed(record.key);
    } catch (err) {
      console.error("Quick refresher failed:", err);
    } finally {
      setRefresherLoadingKey(null);
    }
  };

  const correctCount = Object.entries(selectedAnswers).filter(
    ([idx, ans]) => quizzes[Number(idx)]?.answer === ans
  ).length;
  const answeredCount = Object.keys(selectedAnswers).length;

  // Recompute retention for every tracked topic at the "Time Machine"
  // preview point (real now + however many days the slider is set to),
  // sorted so the topic closest to being forgotten appears first.
  const previewNow = Date.now() + simulatedDays * DAY_MS;
  const decayList = useMemo(() => {
    return (Object.values(memoryRecords) as MemoryRecord[])
      .map((rec) => ({
        record: rec,
        retention: retentionAt(rec, previewNow),
        elapsedDays: elapsedDaysAt(rec, previewNow),
      }))
      .sort((a, b) => a.retention - b.retention);
  }, [memoryRecords, previewNow]);

  const atRiskCount = decayList.filter((d) => d.retention < 0.5).length;

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 font-sans p-6">
      {/* Header */}
      <header className="max-w-6xl mx-auto flex justify-between items-center pb-8 border-b border-slate-800">
        <div className="flex items-center gap-3">
          <div className="p-2.5 bg-indigo-600 rounded-xl shadow-lg shadow-indigo-500/30">
            <Brain className="w-7 h-7 text-white" />
          </div>
          <div>
            <h1 className="text-2xl font-bold bg-gradient-to-r from-indigo-400 to-cyan-400 bg-clip-text text-transparent">
              MindChunk AI
            </h1>
            <p className="text-xs text-slate-400">Memory Decay Forecast & Local Knowledge Engine</p>
          </div>
        </div>
        <div className="px-3 py-1 bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 text-xs rounded-full flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
          FastAPI Engine Online
        </div>
      </header>

      {/* Main Grid */}
      <main className="max-w-6xl mx-auto mt-8 grid grid-cols-1 lg:grid-cols-12 gap-8">

        {/* Left Column: File & YouTube Upload */}
        <div className="lg:col-span-4 space-y-6">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-xl">
            <h2 className="text-base font-semibold text-slate-200 mb-4 flex items-center gap-2">
              <Upload className="w-4 h-4 text-indigo-400" />
              Upload Study Material
            </h2>

            {/* Document Drag & Drop */}
            <label className="border-2 border-dashed border-slate-700 hover:border-indigo-500 rounded-xl p-6 text-center cursor-pointer transition-colors bg-slate-950/50 mb-4 block">
              <FileText className="w-8 h-8 text-indigo-400 mx-auto mb-2" />
              <p className="text-xs text-slate-300 font-medium">
                {fileName ? `Uploaded: ${fileName}` : "Click to upload PDF, DOCX or PPT"}
              </p>
              <p className="text-[10px] text-slate-500 mt-1">
                {loading ? "Analyzing document structure..." : "Local processing up to 50MB"}
              </p>
              <input type="file" accept=".pdf,.docx,.pptx" onChange={handleFileUpload} className="hidden" />
            </label>

            <div className="relative flex py-2 items-center">
              <div className="flex-grow border-t border-slate-800"></div>
              <span className="flex-shrink mx-3 text-[10px] text-slate-500 uppercase tracking-wider">or paste link</span>
              <div className="flex-grow border-t border-slate-800"></div>
            </div>

            {/* YouTube Input */}
            <div className="mt-2 space-y-3">
              <div className="relative">
                <Video className="w-4 h-4 text-red-400 absolute left-3 top-3" />
                <input
                  type="text"
                  placeholder="Paste YouTube Video URL..."
                  value={youtubeUrl}
                  onChange={(e) => setYoutubeUrl(e.target.value)}
                  className="w-full pl-9 pr-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
                />
              </div>
              <button
                onClick={handleYoutubeIngest}
                disabled={loading}
                className="w-full py-2.5 bg-indigo-600 hover:bg-indigo-500 disabled:bg-slate-800 text-white font-medium text-xs rounded-lg shadow-md transition-all flex items-center justify-center gap-2"
              >
                {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                {loading ? "Analyzing Material..." : "Analyze Source Code & Structure"}
              </button>
            </div>
          </div>
        </div>

        {/* Right Column: Dynamic Workspace */}
        <div className="lg:col-span-8 space-y-6">

          {/* Navigation Tabs */}
          <div className="flex bg-slate-900 border border-slate-800 p-1 rounded-xl gap-1 overflow-x-auto">
            <button
              onClick={() => setActiveTab("decay")}
              className={`flex-1 py-2 px-3 text-xs font-medium rounded-lg flex items-center justify-center gap-2 transition-all whitespace-nowrap ${
                activeTab === "decay" ? "bg-indigo-600 text-white shadow-md" : "text-slate-400 hover:text-slate-200"
              }`}
            >
              <TrendingDown className="w-3.5 h-3.5" />
              Memory Decay Forecast
            </button>
            <button
              onClick={() => setActiveTab("summary")}
              className={`flex-1 py-2 px-3 text-xs font-medium rounded-lg flex items-center justify-center gap-2 transition-all whitespace-nowrap ${
                activeTab === "summary" ? "bg-indigo-600 text-white shadow-md" : "text-slate-400 hover:text-slate-200"
              }`}
            >
              <Layers className="w-3.5 h-3.5" />
              Precise Summaries ({summaries.length})
            </button>
            <button
              onClick={() => setActiveTab("quiz")}
              className={`flex-1 py-2 px-3 text-xs font-medium rounded-lg flex items-center justify-center gap-2 transition-all whitespace-nowrap ${
                activeTab === "quiz" ? "bg-indigo-600 text-white shadow-md" : "text-slate-400 hover:text-slate-200"
              }`}
            >
              <HelpCircle className="w-3.5 h-3.5" />
              Topic Quizzes ({quizzes.length})
            </button>
            <button
              onClick={() => setActiveTab("flashcards")}
              className={`flex-1 py-2 px-3 text-xs font-medium rounded-lg flex items-center justify-center gap-2 transition-all whitespace-nowrap ${
                activeTab === "flashcards" ? "bg-indigo-600 text-white shadow-md" : "text-slate-400 hover:text-slate-200"
              }`}
            >
              <IdCard className="w-3.5 h-3.5" />
              Flashcards ({flashcards.length})
            </button>
          </div>

          {/* TAB 1: MEMORY DECAY FORECAST */}
          {activeTab === "decay" && (
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-6">
              <div className="flex justify-between items-start flex-wrap gap-3">
                <div>
                  <h3 className="text-base font-semibold text-slate-100 flex items-center gap-2">
                    <TrendingDown className="w-4 h-4 text-amber-400" />
                    Memory Decay Forecast
                  </h3>
                  <p className="text-xs text-slate-400 mt-1 max-w-md">
                    Based on the Ebbinghaus forgetting curve. Each topic's retention drops
                    over time until you review it -- drag the time machine below to see
                    what you're likely to forget, and when.
                  </p>
                </div>
                {atRiskCount > 0 && (
                  <div className="px-3 py-1.5 bg-red-500/10 border border-red-500/30 text-red-400 text-xs rounded-lg flex items-center gap-1.5 whitespace-nowrap">
                    <AlertTriangle className="w-3.5 h-3.5" />
                    {atRiskCount} topic{atRiskCount > 1 ? "s" : ""} at risk
                  </div>
                )}
              </div>

              {/* Time Machine slider */}
              <div className="p-4 bg-slate-950 border border-slate-800 rounded-xl space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-slate-300 flex items-center gap-1.5">
                    <Clock className="w-3.5 h-3.5 text-indigo-400" />
                    Time Machine -- preview retention if you don't review for...
                  </span>
                  <span className="text-xs font-bold text-indigo-300">
                    {simulatedDays === 0 ? "Today" : `+${simulatedDays} day${simulatedDays > 1 ? "s" : ""}`}
                  </span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={14}
                  step={1}
                  value={simulatedDays}
                  onChange={(e) => setSimulatedDays(Number(e.target.value))}
                  className="w-full accent-indigo-500"
                />
                <div className="flex justify-between text-[10px] text-slate-600">
                  <span>Today</span>
                  <span>+7 days</span>
                  <span>+14 days</span>
                </div>
              </div>

              {/* Topic decay list */}
              <div className="space-y-3">
                {decayList.length === 0 && (
                  <p className="text-xs text-slate-500 text-center py-6">
                    {hasUploaded
                      ? "No topics were extracted from that upload yet."
                      : "Upload material to start tracking memory decay per topic."}
                  </p>
                )}

                {decayList.map(({ record, retention, elapsedDays }) => {
                  const colors = urgencyColor(retention);
                  const curve = buildDecayCurve(record.stabilityDays, elapsedDays);
                  const halfLifeDays = record.stabilityDays * Math.LN2;
                  const daysUntilHalf = halfLifeDays - elapsedDays;
                  const isLoadingRefresher = refresherLoadingKey === record.key;

                  let forecastText: string;
                  if (retention < 0.5) {
                    forecastText = "At risk now -- review recommended";
                  } else if (daysUntilHalf < 1) {
                    forecastText = "You'll likely forget this within a day";
                  } else {
                    forecastText = `You'll likely forget this in ~${Math.round(daysUntilHalf)} day${Math.round(daysUntilHalf) === 1 ? "" : "s"}`;
                  }

                  return (
                    <div key={record.key} className={`p-4 rounded-xl border bg-slate-950 ${colors.border} space-y-3`}>
                      <div className="flex items-start justify-between gap-3 flex-wrap">
                        <div className="flex-1 min-w-[160px]">
                          <p className="text-xs font-medium text-slate-200">{record.title}</p>
                          <p className={`text-[11px] mt-0.5 ${colors.text}`}>{forecastText}</p>
                        </div>
                        <svg width={curve.width} height={curve.height} className="flex-shrink-0">
                          <path d={curve.path} fill="none" stroke={colors.stroke} strokeWidth="2" opacity="0.85" />
                          <circle cx={curve.markerX} cy={curve.markerY} r="4" fill={colors.stroke} />
                        </svg>
                      </div>

                      <div className="flex items-center justify-between flex-wrap gap-2">
                        <div className="flex items-center gap-3">
                          <span className={`text-lg font-bold ${colors.text}`}>{Math.round(retention * 100)}%</span>
                          <span className="text-[10px] text-slate-500">retained</span>
                          <span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-800 text-slate-400">
                            {record.status}
                          </span>
                          <span className="text-[10px] text-slate-600 flex items-center gap-1">
                            <History className="w-3 h-3" />
                            Reviewed {record.reviewCount}x
                          </span>
                        </div>
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => markAsReviewed(record.key)}
                            className="text-[11px] px-2.5 py-1.5 rounded-lg border border-slate-800 bg-slate-900 hover:bg-slate-800 text-slate-300 flex items-center gap-1.5"
                          >
                            <RefreshCw className="w-3 h-3" />
                            Mark as Reviewed
                          </button>
                          <button
                            onClick={() => handleQuickRefresher(record)}
                            disabled={isLoadingRefresher}
                            className="text-[11px] px-2.5 py-1.5 rounded-lg border border-indigo-500/40 bg-indigo-500/10 hover:bg-indigo-500/20 text-indigo-300 flex items-center gap-1.5 disabled:opacity-60"
                          >
                            {isLoadingRefresher ? <Loader2 className="w-3 h-3 animate-spin" /> : <Zap className="w-3 h-3" />}
                            Quick Refresher
                          </button>
                        </div>
                      </div>

                      {refresherContent[record.key] && (
                        <div className="p-3 bg-indigo-950/60 border border-indigo-500/40 rounded-lg space-y-1">
                          <p className="text-[11px] font-bold text-indigo-200 flex items-center gap-1.5">
                            <Sparkles className="w-3.5 h-3.5" />
                            60-Second Refresher
                          </p>
                          <p className="text-[11px] text-slate-300 leading-relaxed">{refresherContent[record.key]}</p>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* TAB 2: PRECISE SUMMARIES */}
          {activeTab === "summary" && (
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-4">
              <h3 className="text-base font-semibold text-slate-100 flex items-center gap-2">
                <FileText className="w-4 h-4 text-indigo-400" />
                Precise Key Bullet Points ({summaries.length} extracted)
              </h3>
              {summaries.length === 0 && (
                <p className="text-xs text-slate-500 text-center py-6">
                  Upload a PDF, DOCX, PPTX, or paste a YouTube link to generate summaries.
                </p>
              )}
              <ul className="space-y-3 text-xs text-slate-300">
                {summaries.map((s, idx) => (
                  <li key={idx} className="flex items-start gap-2 bg-slate-950 p-3 rounded-xl border border-slate-800">
                    <ArrowRight className="w-3.5 h-3.5 text-indigo-400 mt-0.5 flex-shrink-0" />
                    <span>{s}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* TAB 3: QUIZ */}
          {activeTab === "quiz" && (
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-base font-semibold text-slate-100 flex items-center gap-2">
                  <HelpCircle className="w-4 h-4 text-emerald-400" />
                  Topic Quizzes ({quizzes.length} available)
                </h3>
                {answeredCount > 0 && (
                  <span className="text-[11px] px-2.5 py-1 rounded-full bg-slate-800 text-slate-300">
                    Score: {correctCount}/{answeredCount} answered
                  </span>
                )}
              </div>

              {quizzes.length === 0 && (
                <p className="text-xs text-slate-500 text-center py-6">
                  Upload material to generate quiz questions.
                </p>
              )}

              {quizzes.map((q, idx) => {
                const selected = selectedAnswers[idx];
                const hasAnswered = selected !== undefined;
                const isCorrect = selected === q.answer;

                return (
                  <div key={idx} className="bg-slate-950 p-4 rounded-xl border border-slate-800 space-y-3">
                    <div className="flex items-start justify-between gap-3">
                      <p className="text-xs font-medium text-slate-200">Q{idx + 1}: {q.question}</p>
                      {q.topic && (
                        <span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-800 text-slate-400 whitespace-nowrap flex-shrink-0">
                          {q.topic}
                        </span>
                      )}
                    </div>

                    <div className="space-y-2">
                      {q.options.map((opt, i) => {
                        const isSelectedOption = selected === opt;
                        const isCorrectOption = opt === q.answer;

                        let optionStyle = "border-slate-800 bg-slate-900 hover:bg-slate-800 text-slate-300";
                        if (hasAnswered) {
                          if (isCorrectOption) {
                            optionStyle = "border-emerald-500/50 bg-emerald-500/10 text-emerald-200";
                          } else if (isSelectedOption && !isCorrectOption) {
                            optionStyle = "border-red-500/50 bg-red-500/10 text-red-200";
                          } else {
                            optionStyle = "border-slate-800 bg-slate-900/50 text-slate-500";
                          }
                        }

                        return (
                          <button
                            key={i}
                            onClick={() => handleSelectAnswer(idx, opt)}
                            disabled={hasAnswered}
                            className={`w-full text-left p-2.5 rounded-lg border text-xs transition-colors flex items-center justify-between gap-2 ${optionStyle} ${hasAnswered ? "cursor-default" : "cursor-pointer"}`}
                          >
                            <span>{opt}</span>
                            {hasAnswered && isCorrectOption && <CheckCircle className="w-3.5 h-3.5 flex-shrink-0" />}
                            {hasAnswered && isSelectedOption && !isCorrectOption && <XCircle className="w-3.5 h-3.5 flex-shrink-0" />}
                          </button>
                        );
                      })}
                    </div>

                    {hasAnswered && (
                      <div className={`p-3 rounded-lg border text-[11px] leading-relaxed space-y-1 ${
                        isCorrect
                          ? "bg-emerald-950/40 border-emerald-500/30 text-emerald-200"
                          : "bg-red-950/40 border-red-500/30 text-red-200"
                      }`}>
                        <p className="font-semibold flex items-center gap-1.5">
                          {isCorrect ? <CheckCircle className="w-3.5 h-3.5" /> : <XCircle className="w-3.5 h-3.5" />}
                          {isCorrect ? "Correct!" : `Incorrect -- the right answer is: ${q.answer}`}
                        </p>
                        {q.explanation && (
                          <p className="text-slate-300">{q.explanation}</p>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* TAB 4: FLASHCARDS */}
          {activeTab === "flashcards" && (
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-xl space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-base font-semibold text-slate-100 flex items-center gap-2">
                  <IdCard className="w-4 h-4 text-cyan-400" />
                  Flashcards ({flashcards.length})
                </h3>
                {Object.keys(flippedCards).length > 0 && (
                  <button
                    onClick={() => setFlippedCards({})}
                    className="text-[11px] text-slate-400 hover:text-slate-200 flex items-center gap-1"
                  >
                    <RotateCcw className="w-3 h-3" />
                    Flip all back
                  </button>
                )}
              </div>

              {flashcards.length === 0 && (
                <p className="text-xs text-slate-500 text-center py-6">
                  Upload material to generate flashcards.
                </p>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {flashcards.map((card, idx) => {
                  const isFlipped = !!flippedCards[idx];
                  return (
                    <button
                      key={idx}
                      onClick={() => toggleFlip(idx)}
                      className={`text-left p-4 rounded-xl border min-h-[110px] flex flex-col justify-between transition-colors ${
                        isFlipped
                          ? "bg-cyan-950/30 border-cyan-500/40"
                          : "bg-slate-950 border-slate-800 hover:border-indigo-500/50"
                      }`}
                    >
                      <span className={`text-[10px] uppercase tracking-wide ${isFlipped ? "text-cyan-400" : "text-slate-500"}`}>
                        {isFlipped ? "Definition" : "Term"}
                      </span>
                      <span className={`text-xs mt-2 ${isFlipped ? "text-cyan-100" : "text-slate-200 font-medium"}`}>
                        {isFlipped ? card.definition : card.term}
                      </span>
                      <span className="text-[10px] text-slate-600 mt-3">Click to flip</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

        </div>
      </main>
    </div>
  );
}
